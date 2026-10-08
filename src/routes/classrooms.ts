import { Elysia, t } from "elysia";
import { sql } from "../db/client";
import { requireActor, type Actor } from "../auth/session";
import { HttpError } from "../http-error";
import { randomBytes, createHash } from "node:crypto";
import { bangkokToday, checkRequestOrigin, cleanText, normalizeEmail, validCalendarDate } from "../security";
import { sendStudentAccessEmail } from "../student-mail";

async function ownedClass(actor: Actor, classroomId: string, includeArchived = false) {
  const [room] = await sql<{ id: string; name: string; archived: boolean }[]>`
    SELECT id, name, archived_at IS NOT NULL AS archived
    FROM classroom.classrooms
    WHERE id = ${classroomId} AND owner_id = ${actor.id}
      AND (${includeArchived} OR archived_at IS NULL)
  `;
  if (!room) throw new HttpError(404, "ไม่พบห้องเรียนนี้");
  return room;
}

const attendanceStatus = t.Union([
  t.Literal("present"), t.Literal("absent"), t.Literal("late"), t.Literal("excused"), t.Null(),
]);

export const classroomRoutes = new Elysia({ prefix: "/api" })
  .get("/overview", async ({ request }) => {
    const actor = await requireActor(request);
    const today = bangkokToday();
    const [totals] = await sql<{ classrooms: number; students: number; present: number; absent: number; late: number; excused: number }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM classroom.classrooms c WHERE c.owner_id = ${actor.id} AND c.archived_at IS NULL) AS classrooms,
        (SELECT COUNT(*)::int FROM classroom.students s JOIN classroom.classrooms c ON c.id = s.classroom_id WHERE c.owner_id = ${actor.id} AND c.archived_at IS NULL AND s.archived_at IS NULL) AS students,
        (SELECT COUNT(*)::int FROM classroom.attendance a JOIN classroom.classrooms c ON c.id = a.classroom_id WHERE c.owner_id = ${actor.id} AND c.archived_at IS NULL AND a.attendance_date = ${today}::date AND a.status = 'present') AS present,
        (SELECT COUNT(*)::int FROM classroom.attendance a JOIN classroom.classrooms c ON c.id = a.classroom_id WHERE c.owner_id = ${actor.id} AND c.archived_at IS NULL AND a.attendance_date = ${today}::date AND a.status = 'absent') AS absent,
        (SELECT COUNT(*)::int FROM classroom.attendance a JOIN classroom.classrooms c ON c.id = a.classroom_id WHERE c.owner_id = ${actor.id} AND c.archived_at IS NULL AND a.attendance_date = ${today}::date AND a.status = 'late') AS late,
        (SELECT COUNT(*)::int FROM classroom.attendance a JOIN classroom.classrooms c ON c.id = a.classroom_id WHERE c.owner_id = ${actor.id} AND c.archived_at IS NULL AND a.attendance_date = ${today}::date AND a.status = 'excused') AS excused
    `;
    return { today, ...totals };
  })
  .get("/classrooms", async ({ request }) => {
    const actor = await requireActor(request);
    return sql`
      SELECT c.id, c.name, c.created_at AS "createdAt",
        COUNT(s.id) FILTER (WHERE s.archived_at IS NULL)::int AS "studentCount"
      FROM classroom.classrooms c
      LEFT JOIN classroom.students s ON s.classroom_id = c.id
      WHERE c.owner_id = ${actor.id} AND c.archived_at IS NULL
      GROUP BY c.id ORDER BY c.created_at DESC
    `;
  })
  .post("/classrooms", async ({ body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const name = cleanText(body.name, 100);
    const [room] = await sql<{ id: string; name: string }[]>`
      INSERT INTO classroom.classrooms (owner_id, name)
      VALUES (${actor.id}, ${name}) RETURNING id, name
    `;
    return room;
  }, { body: t.Object({ name: t.String({ minLength: 1, maxLength: 120 }) }) })
  .patch("/classrooms/:classroomId", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedClass(actor, params.classroomId, body.archived === true);
    if (body.name !== undefined) {
      const name = cleanText(body.name, 100);
      await sql`UPDATE classroom.classrooms SET name = ${name} WHERE id = ${params.classroomId} AND owner_id = ${actor.id}`;
    }
    if (body.archived !== undefined) {
      await sql`UPDATE classroom.classrooms SET archived_at = ${body.archived ? sql`NOW()` : sql`NULL`} WHERE id = ${params.classroomId} AND owner_id = ${actor.id}`;
    }
    return { ok: true };
  }, { body: t.Object({ name: t.Optional(t.String({ minLength: 1, maxLength: 120 })), archived: t.Optional(t.Boolean()) }) })
  .get("/classrooms/:classroomId/students", async ({ params, request }) => {
    const actor = await requireActor(request);
    await ownedClass(actor, params.classroomId);
    return sql`
      SELECT id, student_code AS "studentCode", display_name AS "displayName",
        email, account_id IS NOT NULL AS "hasAccount",
        EXISTS (SELECT 1 FROM classroom.student_auth_tokens t
          WHERE t.student_id = students.id AND t.token_kind = 'invite'
            AND t.consumed_at IS NULL AND t.expires_at > NOW()) AS "invitePending",
        archived_at IS NOT NULL AS archived
      FROM classroom.students
      WHERE classroom_id = ${params.classroomId}
      ORDER BY archived_at NULLS FIRST, display_name
    `;
  })
  .post("/classrooms/:classroomId/students", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedClass(actor, params.classroomId);
    const name = cleanText(body.displayName, 120);
    const code = body.studentCode?.trim() || null;
    const email = normalizeEmail(body.email);
    if (code && code.length > 50) throw new HttpError(422, "รหัสนักเรียนยาวเกินไป");
    try {
      const [student] = await sql<{ id: string; studentCode: string | null; displayName: string }[]>`
        INSERT INTO classroom.students (classroom_id, student_code, display_name, email)
        VALUES (${params.classroomId}, ${code}, ${name}, ${email})
        RETURNING id, student_code AS "studentCode", display_name AS "displayName", email
      `;
      return student;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") {
        throw new HttpError(409, "รหัสนักเรียนนี้มีอยู่ในห้องแล้ว");
      }
      throw error;
    }
  }, { body: t.Object({ displayName: t.String({ minLength: 1, maxLength: 120 }), studentCode: t.Optional(t.String({ maxLength: 50 })), email: t.Optional(t.String({ maxLength: 254 })) }) })
  .post("/classrooms/:classroomId/students/:studentId/invite", async ({ params, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedClass(actor, params.classroomId);
    const [student] = await sql<{ email: string | null }[]>`
      SELECT email FROM classroom.students
      WHERE id = ${params.studentId} AND classroom_id = ${params.classroomId} AND archived_at IS NULL
    `;
    if (!student) throw new HttpError(404, "ไม่พบนักเรียนนี้");
    if (!student.email) throw new HttpError(422, "เพิ่มอีเมลนักเรียนก่อนส่งคำเชิญ");
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await sql.begin(async (tx) => {
      await tx`DELETE FROM classroom.student_auth_tokens WHERE student_id = ${params.studentId} AND token_kind = 'invite'`;
      await tx`
        INSERT INTO classroom.student_auth_tokens (token_hash, token_kind, email, student_id, expires_at)
        VALUES (${tokenHash}, 'invite', ${student.email}, ${params.studentId}, NOW() + INTERVAL '24 hours')
      `;
    });
    const url = new URL("/student/activate#token=" + token, process.env.APP_URL ?? "http://localhost:3000").toString();
    try {
      await sendStudentAccessEmail(student.email, url, "invite");
    } catch {
      await sql`DELETE FROM classroom.student_auth_tokens WHERE token_hash = ${tokenHash}`;
      throw new HttpError(503, "ส่งอีเมลไม่ได้ กรุณาตรวจสอบการตั้งค่า SMTP");
    }
    return { ok: true };
  })
  .patch("/classrooms/:classroomId/students/:studentId", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedClass(actor, params.classroomId);
    const [student] = await sql<{ id: string }[]>`
      SELECT id FROM classroom.students WHERE id = ${params.studentId} AND classroom_id = ${params.classroomId}
    `;
    if (!student) throw new HttpError(404, "ไม่พบนักเรียนนี้");
    try {
      if (body.displayName !== undefined || body.studentCode !== undefined) {
        const name = body.displayName === undefined ? undefined : cleanText(body.displayName, 120);
        const code = body.studentCode === undefined ? undefined : body.studentCode.trim() || null;
        await sql`
          UPDATE classroom.students
          SET display_name = COALESCE(${name ?? null}, display_name),
              student_code = CASE WHEN ${body.studentCode !== undefined} THEN ${code ?? null} ELSE student_code END
          WHERE id = ${params.studentId} AND classroom_id = ${params.classroomId}
        `;
      }
      if (body.email !== undefined) {
        const email = normalizeEmail(body.email);
        await sql.begin(async (tx) => {
          await tx`
            UPDATE classroom.students
            SET email = ${email}, account_id = CASE WHEN email IS DISTINCT FROM ${email} THEN NULL ELSE account_id END
            WHERE id = ${params.studentId} AND classroom_id = ${params.classroomId}
          `;
          await tx`DELETE FROM classroom.student_auth_tokens WHERE student_id = ${params.studentId} AND token_kind = 'invite' AND consumed_at IS NULL`;
        });
      }
      if (body.archived !== undefined) {
        await sql`UPDATE classroom.students SET archived_at = ${body.archived ? sql`NOW()` : sql`NULL`} WHERE id = ${params.studentId}`;
      }
      return { ok: true };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") {
        throw new HttpError(409, "รหัสหรืออีเมลนักเรียนนี้มีอยู่ในห้องแล้ว");
      }
      throw error;
    }
  }, { body: t.Object({ displayName: t.Optional(t.String({ minLength: 1, maxLength: 120 })), studentCode: t.Optional(t.String({ maxLength: 50 })), email: t.Optional(t.String({ maxLength: 254 })), archived: t.Optional(t.Boolean()) }) })
  .get("/classrooms/:classroomId/attendance", async ({ params, query, request }) => {
    const actor = await requireActor(request);
    await ownedClass(actor, params.classroomId);
    const date = query.date ?? bangkokToday();
    if (!validCalendarDate(date) || date > bangkokToday()) throw new HttpError(422, "วันที่ไม่ถูกต้อง");
    const students = await sql`
      SELECT s.id AS "studentId", s.student_code AS "studentCode",
        s.display_name AS "displayName", a.status
      FROM classroom.students s
      LEFT JOIN classroom.attendance a ON a.student_id = s.id AND a.attendance_date = ${date}::date
      WHERE s.classroom_id = ${params.classroomId} AND s.archived_at IS NULL
      ORDER BY s.display_name
    `;
    return { date, students };
  }, { query: t.Object({ date: t.Optional(t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })) }) })
  .put("/classrooms/:classroomId/attendance", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedClass(actor, params.classroomId);
    if (!validCalendarDate(body.date) || body.date > bangkokToday()) throw new HttpError(422, "วันที่ไม่ถูกต้อง");
    const ids = body.entries.map((entry) => entry.studentId);
    if (new Set(ids).size !== ids.length) throw new HttpError(422, "มีรายชื่อนักเรียนซ้ำในข้อมูล");

    await sql.begin(async (tx) => {
      const roster = await tx<{ id: string }[]>`
        SELECT id FROM classroom.students
        WHERE classroom_id = ${params.classroomId} AND archived_at IS NULL
      `;
      const rosterIds = new Set(roster.map((student) => student.id));
      if (rosterIds.size !== ids.length || ids.some((id) => !rosterIds.has(id))) {
        throw new HttpError(409, "รายชื่อนักเรียนเปลี่ยนแล้ว กรุณาโหลดหน้าอีกครั้ง");
      }
      for (const entry of body.entries) {
        if (entry.status === null) {
          await tx`
            DELETE FROM classroom.attendance
            WHERE classroom_id = ${params.classroomId} AND student_id = ${entry.studentId} AND attendance_date = ${body.date}::date
          `;
        } else {
          await tx`
            INSERT INTO classroom.attendance (classroom_id, student_id, attendance_date, status)
            VALUES (${params.classroomId}, ${entry.studentId}, ${body.date}::date, ${entry.status})
            ON CONFLICT (student_id, attendance_date) DO UPDATE SET status = EXCLUDED.status, updated_at = NOW()
          `;
        }
      }
    });
    return { ok: true, savedAt: new Date().toISOString() };
  }, { body: t.Object({ date: t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), entries: t.Array(t.Object({ studentId: t.String({ format: "uuid" }), status: attendanceStatus }), { maxItems: 1000 }) }) })
  .get("/classrooms/:classroomId/summary", async ({ params, query, request }) => {
    const actor = await requireActor(request);
    await ownedClass(actor, params.classroomId);
    const to = query.to ?? bangkokToday();
    const from = query.from ?? to;
    if (!validCalendarDate(from) || !validCalendarDate(to) || from > to || to > bangkokToday()) {
      throw new HttpError(422, "ช่วงวันที่ไม่ถูกต้อง");
    }
    const students = await sql`
      SELECT s.id AS "studentId", s.student_code AS "studentCode", s.display_name AS "displayName",
        COUNT(a.status) FILTER (WHERE a.status = 'present')::int AS present,
        COUNT(a.status) FILTER (WHERE a.status = 'absent')::int AS absent,
        COUNT(a.status) FILTER (WHERE a.status = 'late')::int AS late,
        COUNT(a.status) FILTER (WHERE a.status = 'excused')::int AS excused
      FROM classroom.students s
      LEFT JOIN classroom.attendance a ON a.student_id = s.id
        AND a.attendance_date BETWEEN ${from}::date AND ${to}::date
      WHERE s.classroom_id = ${params.classroomId}
      GROUP BY s.id ORDER BY s.archived_at NULLS FIRST, s.display_name
    `;
    return { from, to, students };
  }, { query: t.Object({ from: t.Optional(t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })), to: t.Optional(t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })) }) });
