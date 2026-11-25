import { Elysia, t } from "elysia";
import type postgres from "postgres";
import { requireActor, requireStudent } from "../auth/session";
import { sql } from "../db/client";
import { HttpError } from "../http-error";
import { checkRequestOrigin, cleanText } from "../security";
import { gradeWorksheet, normalizeWorksheetQuestions, validateWorksheetAnswers, worksheetPrompts, type WorksheetAnswers, type WorksheetQuestion } from "../worksheet-core";

const id = t.String({ format: "uuid" });
const idParams = t.Object({ id });
const classParams = t.Object({ classroomId: id });
const roundParams = t.Object({ classroomId: id, roundId: id });
const titleSchema = t.String({ minLength: 1, maxLength: 120 });
type Attempt = { answers: WorksheetAnswers; revision: number; submittedAt: string | null; score: number | null };
type Round = { id: string; classroomId: string; classroomName: string; studentId: string; title: string; status: string; maxScore: number; questions: WorksheetQuestion[] };

function worksheetTitle(value: string) {
  const title = cleanText(value, 120);
  if (!title) throw new HttpError(422, "กรุณาระบุชื่อใบงาน");
  return title;
}

async function studentRound(db: postgres.ISql, roundId: string, account: string, lock = false) {
  const [round] = await db<Round[]>`SELECT r.id, r.classroom_id AS "classroomId", c.name AS "classroomName",
      s.id AS "studentId", r.title, r.status, r.max_score AS "maxScore", r.questions
    FROM classroom.worksheet_rounds r JOIN classroom.classrooms c ON c.id = r.classroom_id
    JOIN classroom.students s ON s.classroom_id = c.id AND s.account_id = ${account} AND s.archived_at IS NULL
    WHERE r.id = ${roundId} AND c.archived_at IS NULL AND r.status <> 'awaiting_open'
    ${lock ? db`FOR SHARE OF r, c, s` : db``}`;
  if (!round) throw new HttpError(404, "ไม่พบใบงานสำหรับห้องเรียนของคุณ");
  return round;
}

async function readAttempt(db: postgres.ISql, round: Round, lock = false) {
  const [attempt] = await db<Attempt[]>`SELECT answers, revision, submitted_at AS "submittedAt", score
    FROM classroom.worksheet_attempts WHERE round_id = ${round.id} AND student_id = ${round.studentId}
    ${lock ? db`FOR UPDATE` : db``}`;
  return attempt ?? null;
}

function studentView(round: Round, attempt: Attempt | null) {
  return { id: round.id, title: round.title, classroomName: round.classroomName, status: round.status,
    maxScore: round.maxScore, questions: attempt ? worksheetPrompts(round.questions) : [], attempt };
}

async function requireLessonLink(tx: postgres.ISql, ownerId: string, classroomId: string, lessonId: string | null) {
  if (!lessonId) return;
  const [lesson] = await tx`SELECT l.id FROM classroom.lesson_pages l
    JOIN classroom.classroom_lessons a ON a.lesson_id = l.id
    WHERE l.id = ${lessonId} AND l.owner_id = ${ownerId} AND a.classroom_id = ${classroomId}
      AND l.trashed_at IS NULL AND l.published_blocks IS NOT NULL FOR SHARE OF l`;
  if (!lesson) throw new HttpError(422, "เลือกบทเรียนที่เผยแพร่และมอบหมายให้ห้องนี้แล้ว");
}

export const worksheetRoutes = new Elysia({ prefix: "/api" })
  .get("/worksheets", async ({ request }) => {
    const actor = await requireActor(request);
    return sql`SELECT id, title, published_title AS "publishedTitle" FROM classroom.worksheets
      WHERE owner_id = ${actor.id} ORDER BY updated_at DESC, id`;
  })
  .post("/worksheets", async ({ request, body }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const [item] = await sql`INSERT INTO classroom.worksheets (owner_id, title)
      VALUES (${actor.id}, ${worksheetTitle(body.title)}) RETURNING id`;
    return item;
  }, { body: t.Object({ title: titleSchema }) })
  .get("/worksheets/:id", async ({ params, request }) => {
    const actor = await requireActor(request);
    const [worksheet] = await sql`SELECT id, title, draft_questions AS questions, revision,
          published_title AS "publishedTitle"
      FROM classroom.worksheets WHERE id = ${params.id} AND owner_id = ${actor.id}`;
    if (!worksheet) throw new HttpError(404, "ไม่พบใบงาน");
    const rounds = await sql`SELECT r.id, r.classroom_id AS "classroomId", c.name AS "classroomName",
        r.lesson_id AS "lessonId", l.published_title AS "lessonTitle", r.title, r.status, r.max_score AS "maxScore"
      FROM classroom.worksheet_rounds r JOIN classroom.classrooms c ON c.id = r.classroom_id
      LEFT JOIN classroom.lesson_pages l ON l.id = r.lesson_id
      WHERE r.worksheet_id = ${params.id} AND c.owner_id = ${actor.id} AND c.archived_at IS NULL
      ORDER BY r.created_at DESC, r.id`;
    return { ...worksheet, rounds };
  }, { params: idParams })
  .put("/worksheets/:id", async ({ request, params, body }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const title = worksheetTitle(body.title);
    const questions = normalizeWorksheetQuestions(body.questions, body.publish);
    const [item] = await sql`UPDATE classroom.worksheets SET title = ${title}, draft_questions = ${sql.json(questions)},
        revision = revision + 1, updated_at = NOW(),
        published_title = CASE WHEN ${body.publish} THEN ${title} ELSE published_title END,
        published_questions = CASE WHEN ${body.publish} THEN ${sql.json(questions)}::jsonb ELSE published_questions END
      WHERE id = ${params.id} AND owner_id = ${actor.id} AND revision = ${body.expectedRevision}
      RETURNING id, title, draft_questions AS questions, revision, published_title AS "publishedTitle"`;
    if (!item) {
      const [current] = await sql`SELECT id FROM classroom.worksheets WHERE id = ${params.id} AND owner_id = ${actor.id}`;
      if (!current) throw new HttpError(404, "ไม่พบใบงาน");
      throw new HttpError(409, "ใบงานถูกแก้ไขแล้ว กรุณาโหลดใหม่ก่อนบันทึก");
    }
    return item;
  }, { params: idParams, body: t.Object({ title: titleSchema, questions: t.Unknown(), expectedRevision: t.Integer({ minimum: 0 }), publish: t.Boolean() }) })
  .post("/classrooms/:classroomId/worksheets", async ({ request, params, body }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    return sql.begin(async (tx) => {
      const [source] = await tx<{ title: string | null; questions: WorksheetQuestion[] | null }[]>`
        SELECT w.published_title AS title, w.published_questions AS questions FROM classroom.worksheets w
        JOIN classroom.classrooms c ON c.id = ${params.classroomId} AND c.owner_id = w.owner_id AND c.archived_at IS NULL
        WHERE w.id = ${body.worksheetId} AND w.owner_id = ${actor.id}`;
      if (!source) throw new HttpError(404, "ไม่พบใบงานหรือห้องเรียน");
      if (!source.title || !source.questions) throw new HttpError(422, "เผยแพร่ใบงานก่อนมอบหมาย");
      await requireLessonLink(tx, actor.id, params.classroomId, body.lessonId);
      const maxScore = source.questions.reduce((sum, question) => sum + question.points, 0);
      const [round] = await tx`INSERT INTO classroom.worksheet_rounds (classroom_id, worksheet_id, lesson_id, title, questions, max_score)
        VALUES (${params.classroomId}, ${body.worksheetId}, ${body.lessonId}, ${source.title},
          ${sql.json(source.questions)}, ${maxScore}) RETURNING id`;
      return round;
    });
  }, { params: classParams, body: t.Object({ worksheetId: id, lessonId: t.Nullable(id) }) })
  .patch("/classrooms/:classroomId/worksheets/:roundId", async ({ request, params, body }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    return sql.begin(async (tx) => {
      if (body.action === "attach") await requireLessonLink(tx, actor.id, params.classroomId, body.lessonId);
      const [round] = await tx`SELECT r.status FROM classroom.worksheet_rounds r
        JOIN classroom.classrooms c ON c.id = r.classroom_id AND c.owner_id = ${actor.id} AND c.archived_at IS NULL
        WHERE r.id = ${params.roundId} AND r.classroom_id = ${params.classroomId} FOR UPDATE OF r`;
      if (!round) throw new HttpError(404, "ไม่พบกิจกรรมใบงาน");
      if (body.action === "attach") {
        await tx`UPDATE classroom.worksheet_rounds SET lesson_id = ${body.lessonId} WHERE id = ${params.roundId}`;
      } else {
        const status = body.action === "open" ? "open" : "closed";
        if (status === round.status) return { ok: true };
        if (body.action === "open" && round.status !== "awaiting_open" || body.action === "close" && round.status !== "open")
          throw new HttpError(409, "สถานะกิจกรรมเปลี่ยนแล้ว กรุณาโหลดใหม่");
        await tx`UPDATE classroom.worksheet_rounds SET status = ${status} WHERE id = ${params.roundId}`;
      }
      return { ok: true };
    });
  }, { params: roundParams, body: t.Union([
    t.Object({ action: t.Literal("open") }), t.Object({ action: t.Literal("close") }),
    t.Object({ action: t.Literal("attach"), lessonId: t.Nullable(id) }),
  ]) })
  .get("/classrooms/:classroomId/worksheets/:roundId/results", async ({ request, params, set }) => {
    set.headers["cache-control"] = "no-store";
    const actor = await requireActor(request);
    const [round] = await sql`SELECT r.title, r.status, r.questions, r.max_score AS "maxScore"
      FROM classroom.worksheet_rounds r JOIN classroom.classrooms c ON c.id = r.classroom_id
      WHERE r.id = ${params.roundId} AND r.classroom_id = ${params.classroomId} AND c.owner_id = ${actor.id} AND c.archived_at IS NULL`;
    if (!round) throw new HttpError(404, "ไม่พบกิจกรรมใบงาน");
    const students = await sql`SELECT s.id, s.display_name AS "displayName", s.student_number AS "studentNumber",
        a.started_at AS "startedAt", a.submitted_at AS "submittedAt", a.score,
        CASE WHEN a.submitted_at IS NOT NULL THEN a.answers END AS answers
      FROM classroom.students s LEFT JOIN classroom.worksheet_attempts a ON a.student_id = s.id AND a.round_id = ${params.roundId}
      WHERE s.classroom_id = ${params.classroomId} AND (s.archived_at IS NULL OR a.started_at IS NOT NULL)
      ORDER BY s.student_number NULLS LAST, s.display_name, s.id`;
    return { ...round, students };
  }, { params: roundParams });

const editBody = t.Object({ answers: t.Unknown(), expectedRevision: t.Integer({ minimum: 0 }) });

async function editAttempt(request: Request, id: string, body: { answers: unknown; expectedRevision: number }, submit: boolean) {
  checkRequestOrigin(request);
  const account = (await requireStudent(request)).id;
  return sql.begin(async (tx) => {
    const round = await studentRound(tx, id, account, true);
    const attempt = await readAttempt(tx, round, true);
    if (!attempt) throw new HttpError(409, "เริ่มทำใบงานก่อนบันทึกคำตอบ");
    if (submit && attempt.submittedAt) return studentView(round, attempt);
    if (round.status !== "open" || attempt.submittedAt) throw new HttpError(409, "ใบงานปิดรับคำตอบแล้ว");
    if (body.expectedRevision !== attempt.revision) throw new HttpError(409, "คำตอบมีการแก้ไขจากหน้าต่างอื่น กรุณาโหลดข้อมูลล่าสุด");
    const answers = validateWorksheetAnswers(round.questions, body.answers);
    const [updated] = await tx<Attempt[]>`UPDATE classroom.worksheet_attempts SET answers = ${sql.json(answers)}, revision = revision + 1,
        submitted_at = CASE WHEN ${submit} THEN NOW() ELSE NULL END, score = ${submit ? gradeWorksheet(round.questions, answers) : null}
      WHERE round_id = ${round.id} AND student_id = ${round.studentId}
      RETURNING answers, revision, submitted_at AS "submittedAt", score`;
    return studentView(round, updated);
  });
}

export const studentWorksheetRoutes = new Elysia({ prefix: "/api/student" })
  .get("/worksheets", async ({ request, set }) => {
    set.headers["cache-control"] = "no-store";
    const account = (await requireStudent(request)).id;
    return sql`SELECT r.id, r.classroom_id AS "classroomId", c.name AS "classroomName", r.title, r.status,
        r.max_score AS "maxScore", a.started_at AS "startedAt", a.score, a.submitted_at AS "submittedAt"
      FROM classroom.worksheet_rounds r JOIN classroom.classrooms c ON c.id = r.classroom_id AND c.archived_at IS NULL
      JOIN classroom.students s ON s.classroom_id = c.id AND s.account_id = ${account} AND s.archived_at IS NULL
      LEFT JOIN classroom.worksheet_attempts a ON a.round_id = r.id AND a.student_id = s.id
      WHERE r.status IN ('open', 'closed') ORDER BY r.created_at DESC, r.id`;
  })
  .get("/worksheet-rounds/:id", async ({ params, request, set }) => {
    set.headers["cache-control"] = "no-store";
    const round = await studentRound(sql, params.id, (await requireStudent(request)).id);
    return studentView(round, await readAttempt(sql, round));
  }, { params: idParams })
  .post("/worksheet-rounds/:id/start", async ({ params, request }) => {
    checkRequestOrigin(request);
    const account = (await requireStudent(request)).id;
    return sql.begin(async (tx) => {
      const round = await studentRound(tx, params.id, account, true);
      const existing = await readAttempt(tx, round);
      if (existing) return studentView(round, existing);
      if (round.status !== "open") throw new HttpError(409, "ใบงานปิดรับคำตอบแล้ว");
      await tx`INSERT INTO classroom.worksheet_attempts (round_id, classroom_id, student_id)
        VALUES (${round.id}, ${round.classroomId}, ${round.studentId}) ON CONFLICT DO NOTHING`;
      return studentView(round, await readAttempt(tx, round));
    });
  }, { params: idParams })
  .put("/worksheet-rounds/:id/answers", ({ params, request, body }) => editAttempt(request, params.id, body, false), { params: idParams, body: editBody })
  .post("/worksheet-rounds/:id/submit", ({ params, request, body }) => editAttempt(request, params.id, body, true), { params: idParams, body: editBody });
