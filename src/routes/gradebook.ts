import { Elysia, t } from "elysia";
import { requireActor } from "../auth/session";
import { sql } from "../db/client";
import { HttpError } from "../http-error";
import { checkRequestOrigin, cleanText } from "../security";

async function ownedClassroom(classroomId: string, ownerId: string) {
  const [room] = await sql<{ id: string }[]>`
    SELECT id FROM classroom.classrooms
    WHERE id = ${classroomId} AND owner_id = ${ownerId} AND archived_at IS NULL
  `;
  if (!room) throw new HttpError(404, "ไม่พบห้องเรียนนี้");
}

function hasTwoDecimalPlaces(value: number) {
  return Number.isFinite(value) && Math.round(value * 100) === value * 100;
}

const scoreLimit = t.Number({ minimum: 0, maximum: 9999999999.99 });
const columnParams = t.Object({ classroomId: t.String({ format: "uuid" }), columnId: t.String({ format: "uuid" }) });

export const gradebookRoutes = new Elysia({ prefix: "/api" })
  .get("/classrooms/:classroomId/gradebook", async ({ params, request }) => {
    const actor = await requireActor(request);
    await ownedClassroom(params.classroomId, actor.id);
    const [students, assignments, assignmentScores, quizzes, quizScores, columns, manualScores] = await Promise.all([
      sql`SELECT id AS "studentId", student_code AS "studentCode", student_number AS "studentNumber",
        display_name AS "displayName", archived_at IS NOT NULL AS archived
        FROM classroom.students WHERE classroom_id = ${params.classroomId}
        ORDER BY archived_at NULLS FIRST, student_number NULLS LAST, display_name, id`,
      sql`SELECT id, title AS name, max_score::float8 AS "maxScore", archived_at IS NOT NULL AS archived
        FROM classroom.assignments WHERE classroom_id = ${params.classroomId}
        ORDER BY archived_at NULLS FIRST, created_at, id`,
      sql`SELECT a.student_id AS "studentId", a.assignment_id AS "itemId", a.published_score::float8 AS score,
        a.published_max_score::float8 AS "maxScore"
        FROM classroom.assignment_assessments a JOIN classroom.assignments i ON i.id = a.assignment_id
        WHERE a.classroom_id = ${params.classroomId} AND a.published_at IS NOT NULL`,
      sql`SELECT r.id, r.title AS name, r.status,
        COALESCE((SELECT SUM((question->>'points')::numeric)
          FROM jsonb_array_elements(r.content_snapshot->'questions') question), 0)::float8 AS "maxScore"
        FROM classroom.classroom_quizzes r JOIN classroom.quizzes q ON q.id = r.quiz_id AND q.trashed_at IS NULL
        WHERE r.classroom_id = ${params.classroomId} ORDER BY r.created_at, r.id`,
      sql`SELECT a.student_id AS "studentId", a.classroom_quiz_id AS "itemId", a.score::float8 AS score,
        COALESCE((SELECT SUM((question->>'points')::numeric)
          FROM jsonb_array_elements(r.content_snapshot->'questions') question), 0)::float8 AS "maxScore"
        FROM classroom.quiz_attempts a JOIN classroom.classroom_quizzes r ON r.id = a.classroom_quiz_id
        JOIN classroom.quizzes q ON q.id = r.quiz_id AND q.trashed_at IS NULL
        WHERE r.classroom_id = ${params.classroomId} AND a.finished_at IS NOT NULL`,
      sql`SELECT id, name, max_score::float8 AS "maxScore", revision,
        archived_at IS NOT NULL AS archived FROM classroom.gradebook_columns
        WHERE classroom_id = ${params.classroomId} ORDER BY archived_at NULLS FIRST, created_at, id`,
      sql`SELECT student_id AS "studentId", column_id AS "itemId", score::float8 AS score,
        c.max_score::float8 AS "maxScore"
        FROM classroom.gradebook_marks m JOIN classroom.gradebook_columns c ON c.id = m.column_id
        WHERE m.classroom_id = ${params.classroomId}`,
    ]);
    return {
      students,
      items: [
        ...assignments.map((item) => ({ ...item, kind: "assignment" as const })),
        ...quizzes.map((item) => ({ ...item, kind: "quiz" as const, archived: false })),
        ...columns.map((item) => ({ ...item, kind: "manual" as const })),
      ],
      scores: [...assignmentScores, ...quizScores, ...manualScores],
    };
  }, { params: t.Object({ classroomId: t.String({ format: "uuid" }) }) })
  .post("/classrooms/:classroomId/gradebook/columns", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedClassroom(params.classroomId, actor.id);
    if (!hasTwoDecimalPlaces(body.maxScore)) throw new HttpError(422, "คะแนนเต็มต้องใช้ทศนิยมไม่เกิน 2 ตำแหน่ง");
    const name = cleanText(body.name, 120);
    if (!name) throw new HttpError(422, "กรุณาระบุชื่อรายการคะแนน");
    const [column] = await sql`
      INSERT INTO classroom.gradebook_columns (classroom_id, name, max_score)
      VALUES (${params.classroomId}, ${name}, ${body.maxScore})
      RETURNING id, name, max_score::float8 AS "maxScore", revision
    `;
    return column;
  }, { params: t.Object({ classroomId: t.String({ format: "uuid" }) }), body: t.Object({ name: t.String({ minLength: 1, maxLength: 120 }), maxScore: t.Number({ minimum: 0.01, maximum: 9999999999.99 }) }) })
  .put("/classrooms/:classroomId/gradebook/columns/:columnId", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    if (body.marks.some((mark) => mark.score !== null && !hasTwoDecimalPlaces(mark.score))) throw new HttpError(422, "คะแนนต้องใช้ทศนิยมไม่เกิน 2 ตำแหน่ง");
    if (new Set(body.marks.map((mark) => mark.studentId)).size !== body.marks.length) throw new HttpError(422, "พบรายชื่อนักเรียนซ้ำในรายการคะแนน");
    const revision = await sql.begin(async (tx) => {
      const [column] = await tx<{ id: string; revision: number; maxScore: number }[]>`
        SELECT g.id, g.revision, g.max_score::float8 AS "maxScore"
        FROM classroom.gradebook_columns g JOIN classroom.classrooms c ON c.id = g.classroom_id
        WHERE g.id = ${params.columnId} AND g.classroom_id = ${params.classroomId}
          AND g.archived_at IS NULL AND c.owner_id = ${actor.id} AND c.archived_at IS NULL
        FOR UPDATE OF g
      `;
      if (!column) throw new HttpError(404, "ไม่พบรายการคะแนนนี้");
      if (column.revision !== body.revision) throw new HttpError(409, "มีการแก้ไขรายการคะแนนจากอีกหน้าต่าง กรุณาโหลดใหม่");
      if (body.marks.some((mark) => mark.score !== null && mark.score > column.maxScore)) throw new HttpError(422, "คะแนนต้องไม่เกินคะแนนเต็ม");
      const ids = body.marks.map((mark) => mark.studentId);
      if (ids.length) {
        const students = await tx`SELECT id FROM classroom.students WHERE classroom_id = ${params.classroomId} AND id = ANY(${ids}::uuid[])`;
        if (students.length !== ids.length) throw new HttpError(422, "มีนักเรียนที่ไม่ได้อยู่ในห้องเรียนนี้");
      }
      for (const mark of body.marks) {
        if (mark.score === null) {
          await tx`DELETE FROM classroom.gradebook_marks WHERE classroom_id = ${params.classroomId} AND column_id = ${params.columnId} AND student_id = ${mark.studentId}`;
        } else {
          await tx`INSERT INTO classroom.gradebook_marks (classroom_id, column_id, student_id, score)
            VALUES (${params.classroomId}, ${params.columnId}, ${mark.studentId}, ${mark.score})
            ON CONFLICT (column_id, student_id) DO UPDATE SET score = EXCLUDED.score, updated_at = NOW()`;
        }
      }
      const [updated] = await tx`UPDATE classroom.gradebook_columns SET revision = revision + 1, updated_at = NOW()
        WHERE id = ${params.columnId} RETURNING revision`;
      return updated.revision as number;
    });
    return { ok: true, revision };
  }, { params: columnParams, body: t.Object({ revision: t.Integer({ minimum: 0 }), marks: t.Array(t.Object({ studentId: t.String({ format: "uuid" }), score: t.Union([scoreLimit, t.Null()]) }), { maxItems: 1000 }) }) })
  .post("/classrooms/:classroomId/gradebook/columns/:columnId/:action", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    if (params.action !== "archive" && params.action !== "restore") throw new HttpError(404, "ไม่พบรายการนี้");
    const archived = params.action === "archive";
    const [column] = await sql.begin(async (tx) => {
      const [current] = await tx`SELECT g.id, g.revision FROM classroom.gradebook_columns g
        JOIN classroom.classrooms c ON c.id = g.classroom_id
        WHERE g.id = ${params.columnId} AND g.classroom_id = ${params.classroomId}
          AND c.owner_id = ${actor.id} AND c.archived_at IS NULL FOR UPDATE OF g`;
      if (!current) throw new HttpError(404, "ไม่พบรายการคะแนนนี้");
      if (current.revision !== body.revision) throw new HttpError(409, "มีการแก้ไขรายการคะแนนจากอีกหน้าต่าง กรุณาโหลดใหม่");
      const [updated] = await tx`UPDATE classroom.gradebook_columns SET archived_at = ${archived ? sql`NOW()` : sql`NULL`},
        revision = revision + 1, updated_at = NOW() WHERE id = ${params.columnId} RETURNING revision`;
      return [updated];
    });
    return { ok: true, revision: column.revision };
  }, { params: t.Object({ classroomId: t.String({ format: "uuid" }), columnId: t.String({ format: "uuid" }), action: t.String() }), body: t.Object({ revision: t.Integer({ minimum: 0 }) }) });
