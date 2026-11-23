import { createHash } from "node:crypto";
import { Elysia, t } from "elysia";
import { requireActor, requireStudent, type Actor } from "../auth/session";
import { sql } from "../db/client";
import { HttpError } from "../http-error";
import { checkRequestOrigin, cleanText } from "../security";
import { allocateGroups } from "../group-allocation";

type Database = typeof sql | import("postgres").TransactionSql;

async function ownedClass(actor: Actor, classroomId: string) {
  const [room] = await sql`SELECT id FROM classroom.classrooms WHERE id = ${classroomId} AND owner_id = ${actor.id} AND archived_at IS NULL`;
  if (!room) throw new HttpError(404, "ไม่พบห้องเรียนนี้");
}

function groupText(value: string, maxLength: number) {
  const cleaned = cleanText(value, maxLength);
  if (!cleaned) throw new HttpError(422, "กรุณาระบุชื่อกลุ่มหรือชื่อชุด");
  return cleaned;
}

async function setForTeacher(actor: Actor, classroomId: string, setId: string, tx: Database = sql) {
  const [set] = await tx<{ id: string; classroomId: string; title: string; studentLimit: number | null; groupLimit: number | null; status: string; revision: number }[]>`
    SELECT gs.id, gs.classroom_id AS "classroomId", gs.title, gs.student_limit AS "studentLimit", gs.group_limit AS "groupLimit", gs.status, gs.revision
    FROM classroom.group_sets gs JOIN classroom.classrooms c ON c.id = gs.classroom_id
    WHERE gs.id = ${setId} AND gs.classroom_id = ${classroomId} AND c.owner_id = ${actor.id} AND c.archived_at IS NULL
  `;
  if (!set) throw new HttpError(404, "ไม่พบการจัดกลุ่มนี้");
  return set;
}

async function lockSet(tx: Database, actor: Actor, classroomId: string, setId: string) {
  const [set] = await tx<{ id: string; classroomId: string; title: string; studentLimit: number | null; groupLimit: number | null; status: string; revision: number }[]>`
    SELECT gs.id, gs.classroom_id AS "classroomId", gs.title, gs.student_limit AS "studentLimit", gs.group_limit AS "groupLimit", gs.status, gs.revision
    FROM classroom.group_sets gs JOIN classroom.classrooms c ON c.id = gs.classroom_id
    WHERE gs.id = ${setId} AND gs.classroom_id = ${classroomId} AND c.owner_id = ${actor.id} AND c.archived_at IS NULL FOR UPDATE OF gs
  `;
  if (!set) throw new HttpError(404, "ไม่พบการจัดกลุ่มนี้");
  return set;
}

async function teacherSets(classroomId: string) {
  const [sets, students] = await Promise.all([
    sql`
      SELECT gs.id, gs.title, gs.student_limit AS "studentLimit", gs.group_limit AS "groupLimit", gs.status, gs.revision, gs.created_at AS "createdAt",
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', g.id, 'name', g.name, 'creatorStudentId', g.creator_student_id,
          'members', COALESCE((SELECT jsonb_agg(jsonb_build_object('studentId', s.id, 'displayName', s.display_name, 'studentNumber', s.student_number) ORDER BY s.student_number NULLS LAST, s.display_name, s.id)
            FROM classroom.group_memberships m JOIN classroom.students s ON s.id = m.student_id
            WHERE m.group_set_id = gs.id AND m.group_id = g.id AND s.archived_at IS NULL), '[]'::jsonb)
        ) ORDER BY g.created_at, g.id) FROM classroom.student_groups g WHERE g.group_set_id = gs.id), '[]'::jsonb) AS groups
      FROM classroom.group_sets gs WHERE gs.classroom_id = ${classroomId} ORDER BY gs.created_at DESC
    `,
    sql`SELECT id AS "studentId", display_name AS "displayName", student_number AS "studentNumber" FROM classroom.students WHERE classroom_id = ${classroomId} AND archived_at IS NULL ORDER BY student_number NULLS LAST, display_name, id`,
  ]);
  return { sets, students };
}

async function studentIdFor(tx: Database, accountId: string, classroomId: string) {
  const [row] = await tx<{ id: string }[]>`
    SELECT s.id FROM classroom.students s JOIN classroom.classrooms c ON c.id = s.classroom_id
    WHERE s.account_id = ${accountId} AND s.classroom_id = ${classroomId} AND s.archived_at IS NULL AND c.archived_at IS NULL FOR UPDATE OF s
  `;
  if (!row) throw new HttpError(403, "คุณไม่มีสิทธิ์ในห้องเรียนนี้");
  return row.id;
}

function rosterFingerprint(rows: { id: string; displayName: string; studentNumber: number | null }[]) {
  return createHash("sha256").update(JSON.stringify(rows.map(({ id, displayName, studentNumber }) => [id, displayName, studentNumber]))).digest("hex");
}

const setParams = { params: t.Object({ classroomId: t.String(), setId: t.String() }) };
const idParams = { params: t.Object({ classroomId: t.String(), setId: t.String(), studentId: t.String() }) };
const actionParams = { params: t.Object({ classroomId: t.String(), setId: t.String(), action: t.String() }) };

export const groupSetRoutes = new Elysia({ prefix: "/api" })
  .get("/classrooms/:classroomId/group-sets", async ({ params, request }) => {
    const actor = await requireActor(request); await ownedClass(actor, params.classroomId); return teacherSets(params.classroomId);
  })
  .post("/classrooms/:classroomId/group-sets", async ({ params, body, request }) => {
    checkRequestOrigin(request); const actor = await requireActor(request); await ownedClass(actor, params.classroomId);
    if (body.studentLimit == null && body.groupLimit == null) throw new HttpError(422, "กำหนดจำนวนนักเรียนต่อกลุ่มหรือจำนวนกลุ่มอย่างน้อยหนึ่งค่า");
    const [created] = await sql`INSERT INTO classroom.group_sets (classroom_id, title, student_limit, group_limit) VALUES (${params.classroomId}, ${groupText(body.title, 120)}, ${body.studentLimit ?? null}, ${body.groupLimit ?? null}) RETURNING id`;
    return { id: created!.id };
  }, { body: t.Object({ title: t.String({ minLength: 1, maxLength: 120 }), studentLimit: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 400 }))), groupLimit: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 400 }))) }) })
  .patch("/classrooms/:classroomId/group-sets/:setId", async ({ params, body, request }) => {
    checkRequestOrigin(request); const actor = await requireActor(request);
    await sql.begin(async (tx) => {
      const set = await lockSet(tx, actor, params.classroomId, params.setId);
      if (set.status === "archived") throw new HttpError(409, "การจัดกลุ่มนี้ถูกเก็บแล้ว");
      if (body.revision !== set.revision) throw new HttpError(409, "ข้อมูลเปลี่ยนไปแล้ว กรุณาโหลดใหม่");
      const studentLimit = body.studentLimit === undefined ? set.studentLimit : body.studentLimit;
      const groupLimit = body.groupLimit === undefined ? set.groupLimit : body.groupLimit;
      if (studentLimit == null && groupLimit == null) throw new HttpError(422, "ต้องกำหนดขีดจำกัดอย่างน้อยหนึ่งค่า");
      const [counts] = await tx`SELECT (SELECT COUNT(*)::int FROM classroom.student_groups WHERE group_set_id = ${params.setId}) AS groups, COALESCE((SELECT MAX(n) FROM (SELECT COUNT(*)::int AS n FROM classroom.group_memberships m JOIN classroom.students s ON s.id = m.student_id WHERE m.group_set_id = ${params.setId} AND s.archived_at IS NULL GROUP BY m.group_id) c), 0)::int AS largest`;
      if (groupLimit !== null && Number(counts!.groups) > groupLimit) throw new HttpError(409, "ลบกลุ่มส่วนเกินก่อนลดจำนวนกลุ่ม");
      if (studentLimit !== null && Number(counts!.largest) > studentLimit) throw new HttpError(409, "ย้ายสมาชิกก่อนลดจำนวนนักเรียนต่อกลุ่ม");
      await tx`UPDATE classroom.group_sets SET title = ${groupText(body.title ?? set.title, 120)}, student_limit = ${studentLimit}, group_limit = ${groupLimit}, revision = revision + 1, updated_at = NOW() WHERE id = ${params.setId}`;
    }); return { ok: true };
  }, { body: t.Object({ title: t.Optional(t.String({ minLength: 1, maxLength: 120 })), studentLimit: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 400 }))), groupLimit: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 400 }))), revision: t.Integer({ minimum: 1 }) }) })
  .post("/classrooms/:classroomId/group-sets/:setId/:action", async ({ params, request }) => {
    checkRequestOrigin(request); const actor = await requireActor(request); const next = params.action;
    if (!["open", "lock", "archive"].includes(next)) throw new HttpError(404, "ไม่พบการดำเนินการนี้");
    await sql.begin(async (tx) => {
      const set = await lockSet(tx, actor, params.classroomId, params.setId);
      if (set.status === "archived") throw new HttpError(409, "การจัดกลุ่มนี้ถูกเก็บแล้ว");
      await tx`UPDATE classroom.group_sets SET status = ${next === "open" ? "open" : next === "lock" ? "locked" : "archived"}, revision = revision + 1, updated_at = NOW() WHERE id = ${params.setId}`;
    }); return { ok: true };
  }, actionParams)
  .post("/classrooms/:classroomId/group-sets/:setId/groups", async ({ params, body, request }) => {
    checkRequestOrigin(request); const actor = await requireActor(request);
    const [group] = await sql.begin(async (tx) => {
      const set = await lockSet(tx, actor, params.classroomId, params.setId);
      if (set.status === "archived") throw new HttpError(409, "การจัดกลุ่มนี้ถูกเก็บแล้ว");
      const [count] = await tx`SELECT COUNT(*)::int AS count FROM classroom.student_groups WHERE group_set_id = ${params.setId}`;
      if (set.groupLimit !== null && Number(count!.count) >= set.groupLimit) throw new HttpError(409, "ครบจำนวนกลุ่มที่กำหนดแล้ว");
      const [created] = await tx`INSERT INTO classroom.student_groups (group_set_id, classroom_id, name) VALUES (${params.setId}, ${params.classroomId}, ${groupText(body.name, 80)}) RETURNING id`;
      await tx`UPDATE classroom.group_sets SET revision = revision + 1, updated_at = NOW() WHERE id = ${params.setId}`;
      return [created!];
    }); return { id: group!.id };
  }, { ...setParams, body: t.Object({ name: t.String({ minLength: 1, maxLength: 80 }) }) })
  .delete("/classrooms/:classroomId/group-sets/:setId/groups/:groupId", async ({ params, request }) => {
    checkRequestOrigin(request); const actor = await requireActor(request);
    await sql.begin(async (tx) => {
      const set = await lockSet(tx, actor, params.classroomId, params.setId);
      if (set.status === "archived") throw new HttpError(409, "การจัดกลุ่มนี้ถูกเก็บแล้ว");
      const [deleted] = await tx`DELETE FROM classroom.student_groups g WHERE g.id = ${params.groupId} AND g.group_set_id = ${params.setId} AND NOT EXISTS (SELECT 1 FROM classroom.group_memberships m JOIN classroom.students s ON s.id = m.student_id WHERE m.group_id = g.id AND s.archived_at IS NULL) RETURNING id`;
      if (!deleted) throw new HttpError(409, "กลุ่มนี้ยังมีสมาชิก หรือไม่พบกลุ่ม");
      await tx`UPDATE classroom.group_sets SET revision = revision + 1, updated_at = NOW() WHERE id = ${params.setId}`;
    }); return { ok: true };
  }, { params: t.Object({ classroomId: t.String(), setId: t.String(), groupId: t.String() }) })
  .put("/classrooms/:classroomId/group-sets/:setId/memberships/:studentId", async ({ params, body, request }) => {
    checkRequestOrigin(request); const actor = await requireActor(request);
    await sql.begin(async (tx) => {
      const set = await lockSet(tx, actor, params.classroomId, params.setId);
      if (set.status === "archived") throw new HttpError(409, "การจัดกลุ่มนี้ถูกเก็บแล้ว");
      const [student] = await tx`SELECT id FROM classroom.students WHERE id = ${params.studentId} AND classroom_id = ${params.classroomId} AND archived_at IS NULL FOR UPDATE`;
      if (!student) throw new HttpError(404, "ไม่พบนักเรียนที่กำลังเรียนในห้องนี้");
      if (body.groupId === null) await tx`DELETE FROM classroom.group_memberships WHERE group_set_id = ${params.setId} AND student_id = ${params.studentId}`;
      else {
        const [group] = await tx`SELECT id FROM classroom.student_groups WHERE id = ${body.groupId} AND group_set_id = ${params.setId}`;
        if (!group) throw new HttpError(404, "ไม่พบกลุ่มนี้");
        if (set.studentLimit !== null) {
          const [count] = await tx`SELECT COUNT(*)::int AS count FROM classroom.group_memberships m JOIN classroom.students s ON s.id = m.student_id WHERE m.group_id = ${body.groupId} AND s.archived_at IS NULL AND m.student_id <> ${params.studentId}`;
          if (Number(count!.count) >= set.studentLimit) throw new HttpError(409, "กลุ่มนี้เต็มแล้ว");
        }
        await tx`INSERT INTO classroom.group_memberships (group_set_id, classroom_id, group_id, student_id) VALUES (${params.setId}, ${params.classroomId}, ${body.groupId}, ${params.studentId}) ON CONFLICT (group_set_id, student_id) DO UPDATE SET group_id = EXCLUDED.group_id, joined_at = NOW()`;
      }
      await tx`UPDATE classroom.group_sets SET revision = revision + 1, updated_at = NOW() WHERE id = ${params.setId}`;
    }); return { ok: true };
  }, { ...idParams, body: t.Object({ groupId: t.Nullable(t.String()) }) })
  .post("/classrooms/:classroomId/group-sets/:setId/random-preview", async ({ params, request }) => {
    const actor = await requireActor(request); const set = await setForTeacher(actor, params.classroomId, params.setId);
    if (set.status === "archived") throw new HttpError(409, "การจัดกลุ่มนี้ถูกเก็บแล้ว");
    const roster = await sql<{ id: string; displayName: string; studentNumber: number | null }[]>`SELECT id, display_name AS "displayName", student_number AS "studentNumber" FROM classroom.students WHERE classroom_id = ${params.classroomId} AND archived_at IS NULL ORDER BY student_number NULLS LAST, display_name, id`;
    const count = roster.length === 0 ? 0 : set.studentLimit === null
      ? Math.min(set.groupLimit!, roster.length)
      : set.groupLimit === null ? Math.ceil(roster.length / set.studentLimit)
        : Math.min(set.groupLimit, Math.ceil(roster.length / set.studentLimit));
    const allocation = allocateGroups(roster.map((s) => s.id), count, set.studentLimit);
    return { revision: set.revision, rosterFingerprint: rosterFingerprint(roster), groups: allocation.groups.map((studentIds, i) => ({ name: `กลุ่ม ${i + 1}`, studentIds })), unassigned: allocation.unassigned };
  }, setParams)
  .post("/classrooms/:classroomId/group-sets/:setId/random-apply", async ({ params, body, request }) => {
    checkRequestOrigin(request); const actor = await requireActor(request);
    await sql.begin(async (tx) => {
      const set = await lockSet(tx, actor, params.classroomId, params.setId);
      if (set.status === "archived") throw new HttpError(409, "การจัดกลุ่มนี้ถูกเก็บแล้ว");
      if (set.revision !== body.revision) throw new HttpError(409, "การจัดกลุ่มเปลี่ยนไปแล้ว กรุณาสร้างตัวอย่างใหม่");
      await tx`SELECT id FROM classroom.classrooms WHERE id = ${params.classroomId} FOR UPDATE`;
      const roster = await tx<{ id: string; displayName: string; studentNumber: number | null }[]>`SELECT id, display_name AS "displayName", student_number AS "studentNumber" FROM classroom.students WHERE classroom_id = ${params.classroomId} AND archived_at IS NULL ORDER BY student_number NULLS LAST, display_name, id FOR UPDATE`;
      if (rosterFingerprint(roster) !== body.rosterFingerprint) throw new HttpError(409, "รายชื่อนักเรียนเปลี่ยนไปแล้ว กรุณาสร้างตัวอย่างใหม่");
      if (set.groupLimit !== null && body.groups.length > set.groupLimit) throw new HttpError(422, "ตัวอย่างมีจำนวนกลุ่มเกินกำหนด");
      const assignments = [...body.groups.flatMap((group) => group.studentIds), ...body.unassigned];
      if (assignments.length !== roster.length || new Set(assignments).size !== roster.length || roster.some((s) => !assignments.includes(s.id))) throw new HttpError(422, "ตัวอย่างต้องระบุนักเรียนแต่ละคนครั้งเดียว");
      if (body.groups.some((group) => set.studentLimit !== null && group.studentIds.length > set.studentLimit)) throw new HttpError(422, "กลุ่มในตัวอย่างมีสมาชิกเกินกำหนด");
      const rosterIds = new Set(roster.map((s) => s.id));
      if (body.groups.some((g) => g.studentIds.some((id) => !rosterIds.has(id))) || body.unassigned.some((id) => !rosterIds.has(id))) throw new HttpError(422, "ตัวอย่างมีนักเรียนที่ไม่ได้อยู่ในห้องนี้");
      await tx`DELETE FROM classroom.student_groups WHERE group_set_id = ${params.setId}`;
      for (const group of body.groups) {
        const [created] = await tx`INSERT INTO classroom.student_groups (group_set_id, classroom_id, name) VALUES (${params.setId}, ${params.classroomId}, ${groupText(group.name, 80)}) RETURNING id`;
        for (const studentId of group.studentIds) await tx`INSERT INTO classroom.group_memberships (group_set_id, classroom_id, group_id, student_id) VALUES (${params.setId}, ${params.classroomId}, ${created!.id}, ${studentId})`;
      }
      await tx`UPDATE classroom.group_sets SET revision = revision + 1, updated_at = NOW() WHERE id = ${params.setId}`;
    }); return { ok: true };
  }, { ...setParams, body: t.Object({ revision: t.Integer({ minimum: 1 }), rosterFingerprint: t.String({ pattern: "^[a-f0-9]{64}$" }), groups: t.Array(t.Object({ name: t.String({ minLength: 1, maxLength: 80 }), studentIds: t.Array(t.String({ format: "uuid" }), { maxItems: 400 }) }), { maxItems: 400 }), unassigned: t.Array(t.String({ format: "uuid" }), { maxItems: 10000 }) }) })
  .get("/student/group-sets", async ({ request }) => {
    const actor = await requireStudent(request);
    return sql`
      SELECT gs.id AS "setId", gs.classroom_id AS "classroomId", c.name AS "classroomName", gs.title, gs.student_limit AS "studentLimit", gs.group_limit AS "groupLimit", gs.status,
        (SELECT m.group_id FROM classroom.group_memberships m JOIN classroom.students mine ON mine.id = m.student_id WHERE m.group_set_id = gs.id AND mine.account_id = ${actor.id} AND mine.archived_at IS NULL LIMIT 1) AS "myGroupId",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'members', COALESCE((SELECT jsonb_agg(jsonb_build_object('studentId', s.id, 'displayName', s.display_name, 'studentNumber', s.student_number) ORDER BY s.student_number NULLS LAST, s.display_name, s.id) FROM classroom.group_memberships m JOIN classroom.students s ON s.id = m.student_id WHERE m.group_set_id = gs.id AND m.group_id = g.id AND s.archived_at IS NULL), '[]'::jsonb)) ORDER BY g.created_at, g.id) FROM classroom.student_groups g WHERE g.group_set_id = gs.id), '[]'::jsonb) AS groups,
        (SELECT jsonb_agg(jsonb_build_object('studentId', s.id, 'displayName', s.display_name, 'studentNumber', s.student_number) ORDER BY s.student_number NULLS LAST, s.display_name, s.id)
          FROM classroom.students s WHERE s.classroom_id = gs.classroom_id AND s.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM classroom.group_memberships m WHERE m.group_set_id = gs.id AND m.student_id = s.id)) AS unassigned
      FROM classroom.group_sets gs JOIN classroom.classrooms c ON c.id = gs.classroom_id
      WHERE gs.status IN ('open', 'locked') AND c.archived_at IS NULL AND EXISTS (SELECT 1 FROM classroom.students s WHERE s.account_id = ${actor.id} AND s.classroom_id = gs.classroom_id AND s.archived_at IS NULL)
      ORDER BY c.name, gs.created_at DESC
    `;
  })
  .post("/student/classrooms/:classroomId/group-sets/:setId/groups", async ({ params, body, request }) => {
    checkRequestOrigin(request); const actor = await requireStudent(request);
    const [created] = await sql.begin(async (tx) => {
      const [set] = await tx`SELECT id, status, group_limit AS "groupLimit" FROM classroom.group_sets WHERE id = ${params.setId} AND classroom_id = ${params.classroomId} FOR UPDATE`;
      if (!set || set.status !== "open") throw new HttpError(409, "การจัดกลุ่มนี้ยังไม่เปิดให้นักเรียนแก้ไข");
      const studentId = await studentIdFor(tx, actor.id, params.classroomId);
      const [existing] = await tx`SELECT group_id FROM classroom.group_memberships WHERE group_set_id = ${params.setId} AND student_id = ${studentId}`;
      if (existing) throw new HttpError(409, "คุณอยู่ในกลุ่มแล้ว กรุณาออกจากกลุ่มก่อนสร้างกลุ่มใหม่");
      const [count] = await tx`SELECT COUNT(*)::int AS count FROM classroom.student_groups WHERE group_set_id = ${params.setId}`;
      if (set.groupLimit !== null && Number(count!.count) >= set.groupLimit) throw new HttpError(409, "ครบจำนวนกลุ่มที่กำหนดแล้ว");
      const [group] = await tx`INSERT INTO classroom.student_groups (group_set_id, classroom_id, name, creator_student_id) VALUES (${params.setId}, ${params.classroomId}, ${groupText(body.name, 80)}, ${studentId}) RETURNING id`;
      await tx`INSERT INTO classroom.group_memberships (group_set_id, classroom_id, group_id, student_id) VALUES (${params.setId}, ${params.classroomId}, ${group!.id}, ${studentId})`;
      await tx`UPDATE classroom.group_sets SET revision = revision + 1, updated_at = NOW() WHERE id = ${params.setId}`;
      return [group!];
    }); return { id: created!.id };
  }, { params: t.Object({ classroomId: t.String(), setId: t.String() }), body: t.Object({ name: t.String({ minLength: 1, maxLength: 80 }) }) })
  .post("/student/classrooms/:classroomId/group-sets/:setId/groups/:groupId/join", async ({ params, request }) => {
    checkRequestOrigin(request); const actor = await requireStudent(request);
    await sql.begin(async (tx) => {
      const [set] = await tx`SELECT id, status, student_limit AS "studentLimit" FROM classroom.group_sets WHERE id = ${params.setId} AND classroom_id = ${params.classroomId} FOR UPDATE`;
      if (!set || set.status !== "open") throw new HttpError(409, "การจัดกลุ่มนี้ยังไม่เปิดให้นักเรียนแก้ไข");
      const studentId = await studentIdFor(tx, actor.id, params.classroomId);
      const [group] = await tx`SELECT id FROM classroom.student_groups WHERE id = ${params.groupId} AND group_set_id = ${params.setId}`;
      if (!group) throw new HttpError(404, "ไม่พบกลุ่มนี้");
      if (set.studentLimit !== null) {
        const [count] = await tx`SELECT COUNT(*)::int AS count FROM classroom.group_memberships m JOIN classroom.students s ON s.id = m.student_id WHERE m.group_id = ${params.groupId} AND s.archived_at IS NULL AND m.student_id <> ${studentId}`;
        if (Number(count!.count) >= set.studentLimit) throw new HttpError(409, "กลุ่มนี้เต็มแล้ว");
      }
      await tx`INSERT INTO classroom.group_memberships (group_set_id, classroom_id, group_id, student_id) VALUES (${params.setId}, ${params.classroomId}, ${params.groupId}, ${studentId}) ON CONFLICT (group_set_id, student_id) DO UPDATE SET group_id = EXCLUDED.group_id, joined_at = NOW()`;
      await tx`UPDATE classroom.group_sets SET revision = revision + 1, updated_at = NOW() WHERE id = ${params.setId}`;
    }); return { ok: true };
  }, { params: t.Object({ classroomId: t.String(), setId: t.String(), groupId: t.String() }) })
  .delete("/student/classrooms/:classroomId/group-sets/:setId/membership", async ({ params, request }) => {
    checkRequestOrigin(request); const actor = await requireStudent(request);
    await sql.begin(async (tx) => {
      const [set] = await tx`SELECT id, status FROM classroom.group_sets WHERE id = ${params.setId} AND classroom_id = ${params.classroomId} FOR UPDATE`;
      if (!set || set.status !== "open") throw new HttpError(409, "การจัดกลุ่มนี้ยังไม่เปิดให้นักเรียนแก้ไข");
      const studentId = await studentIdFor(tx, actor.id, params.classroomId);
      const [membership] = await tx`DELETE FROM classroom.group_memberships WHERE group_set_id = ${params.setId} AND student_id = ${studentId} RETURNING group_id AS "groupId"`;
      if (!membership) return;
      await tx`DELETE FROM classroom.student_groups g WHERE g.id = ${membership.groupId} AND g.group_set_id = ${params.setId} AND g.creator_student_id = ${studentId} AND NOT EXISTS (SELECT 1 FROM classroom.group_memberships m WHERE m.group_id = g.id)`;
      await tx`UPDATE classroom.group_sets SET revision = revision + 1, updated_at = NOW() WHERE id = ${params.setId}`;
    }); return { ok: true };
  }, { params: t.Object({ classroomId: t.String(), setId: t.String() }) });
