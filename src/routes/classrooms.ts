import { Elysia, t } from "elysia";
import { rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { sql } from "../db/client";
import { requireActor, type Actor } from "../auth/session";
import { HttpError } from "../http-error";
import { bangkokToday, checkRequestOrigin, cleanText, normalizeEmail, studentEmailForCode, validCalendarDate } from "../security";
import { uploadRoot } from "../file-storage";

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
      await sql.begin(async (tx) => {
        await tx`UPDATE classroom.classrooms SET archived_at = ${body.archived ? sql`NOW()` : sql`NULL`} WHERE id = ${params.classroomId} AND owner_id = ${actor.id}`;
        if (body.archived) await tx`UPDATE classroom.attendance_presence SET active_view = NULL WHERE classroom_id = ${params.classroomId}`;
      });
    }
    return { ok: true };
  }, { body: t.Object({ name: t.Optional(t.String({ minLength: 1, maxLength: 120 })), archived: t.Optional(t.Boolean()) }) })
  .get("/classrooms/:classroomId/students", async ({ params, request }) => {
    const actor = await requireActor(request);
    await ownedClass(actor, params.classroomId);
    return sql`
      SELECT id, student_code AS "studentCode", student_number AS "studentNumber", display_name AS "displayName",
        email, EXISTS (SELECT 1 FROM classroom.student_accounts a
          WHERE a.id = students.account_id AND a.google_subject IS NOT NULL) AS "googleLinked",
        archived_at IS NOT NULL AS archived
      FROM classroom.students
      WHERE classroom_id = ${params.classroomId}
      ORDER BY archived_at NULLS FIRST, student_number NULLS LAST, display_name, id
    `;
  })
  .post("/classrooms/:classroomId/students", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedClass(actor, params.classroomId);
    const name = cleanText(body.displayName, 120);
    const code = body.studentCode?.trim() || null;
    const email = normalizeEmail(body.email) ?? studentEmailForCode(code);
    if (code && code.length > 50) throw new HttpError(422, "รหัสนักเรียนยาวเกินไป");
    try {
      const [student] = await sql<{ id: string; studentCode: string | null; studentNumber: number | null; displayName: string; email: string | null }[]>`
        INSERT INTO classroom.students (classroom_id, student_code, student_number, display_name, email)
        VALUES (${params.classroomId}, ${code}, ${body.studentNumber ?? null}, ${name}, ${email})
        RETURNING id, student_code AS "studentCode", student_number AS "studentNumber", display_name AS "displayName", email
      `;
      return student;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") {
        throw new HttpError(409, "รหัสหรือเลขที่นักเรียนนี้มีอยู่ในห้องแล้ว");
      }
      throw error;
    }
  }, { body: t.Object({ displayName: t.String({ minLength: 1, maxLength: 120 }), studentCode: t.Optional(t.String({ maxLength: 50 })), studentNumber: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 2147483647 }))), email: t.Optional(t.String({ maxLength: 254 })) }) })
  .post("/classrooms/:classroomId/students/:studentId/invite", () => {
    throw new HttpError(410, "Student email invitations were retired. Students sign in with Google.");
  })
  .patch("/classrooms/:classroomId/students/:studentId", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedClass(actor, params.classroomId);
    try {
      await sql.begin(async (tx) => {
        const [student] = await tx<{ studentCode: string | null; displayName: string; email: string | null }[]>`
          SELECT student_code AS "studentCode", display_name AS "displayName", email
          FROM classroom.students WHERE id = ${params.studentId} AND classroom_id = ${params.classroomId} FOR UPDATE
        `;
        if (!student) throw new HttpError(404, "ไม่พบนักเรียนนี้");
        const nextCode = body.studentCode === undefined ? student.studentCode : body.studentCode.trim() || null;
        const email = body.email !== undefined
          ? normalizeEmail(body.email) ?? studentEmailForCode(nextCode)
          : !student.email && body.studentCode !== undefined ? studentEmailForCode(nextCode) : student.email;
        const name = body.displayName === undefined ? student.displayName : cleanText(body.displayName, 120);
        await tx`
          UPDATE classroom.students SET
            display_name = ${name},
            student_code = ${nextCode},
            student_number = CASE WHEN ${body.studentNumber !== undefined} THEN ${body.studentNumber ?? null}::integer ELSE student_number END,
            email = ${email},
            account_id = CASE WHEN email IS DISTINCT FROM ${email} THEN NULL ELSE account_id END,
            archived_at = CASE WHEN ${body.archived !== undefined} THEN ${body.archived ? new Date() : null} ELSE archived_at END
          WHERE id = ${params.studentId} AND classroom_id = ${params.classroomId}
        `;
        if (body.archived) await tx`UPDATE classroom.attendance_presence SET active_view = NULL
          WHERE classroom_id = ${params.classroomId} AND student_id = ${params.studentId}`;
      });
      return { ok: true };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") {
        throw new HttpError(409, "รหัส อีเมล หรือเลขที่นักเรียนนี้มีอยู่ในห้องแล้ว");
      }
      throw error;
    }
  }, { body: t.Object({ displayName: t.Optional(t.String({ minLength: 1, maxLength: 120 })), studentCode: t.Optional(t.String({ maxLength: 50 })), studentNumber: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 2147483647 }))), email: t.Optional(t.String({ maxLength: 254 })), archived: t.Optional(t.Boolean()) }) })
  .delete("/classrooms/:classroomId/students/:studentId", async ({ params, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const staged: { path: string; tombstone: string; storageName: string }[] = [];
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(870010022)`;
        const [student] = await tx<{ id: string }[]>`
          SELECT s.id FROM classroom.students s JOIN classroom.classrooms c ON c.id = s.classroom_id
          WHERE s.id = ${params.studentId} AND s.classroom_id = ${params.classroomId} AND c.owner_id = ${actor.id}
          FOR UPDATE OF s
        `;
        if (!student) throw new HttpError(404, "ไม่พบนักเรียนนี้");
        const files = await tx<{ storageName: string }[]>`
          SELECT storage_name AS "storageName" FROM classroom.files
          WHERE classroom_id = ${params.classroomId} AND student_id = ${params.studentId} FOR UPDATE
        `;
        for (const file of files) {
          const path = resolve(uploadRoot(), file.storageName);
          try { await rename(path, path + ".deleting"); staged.push({ path, tombstone: path + ".deleting", storageName: file.storageName }); }
          catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
        }
        await tx`DELETE FROM classroom.attendance WHERE classroom_id = ${params.classroomId} AND student_id = ${params.studentId}`;
        await tx`DELETE FROM classroom.attendance_presence WHERE classroom_id = ${params.classroomId} AND student_id = ${params.studentId}`;
        await tx`DELETE FROM classroom.student_auth_tokens WHERE student_id = ${params.studentId}`;
        await tx`DELETE FROM classroom.files WHERE classroom_id = ${params.classroomId} AND student_id = ${params.studentId}`;
        await tx`DELETE FROM classroom.students WHERE id = ${params.studentId} AND classroom_id = ${params.classroomId}`;
      });
    } catch (error) {
      for (const file of staged) {
        try {
          const [record] = await sql`SELECT id FROM classroom.files WHERE storage_name = ${file.storageName}`;
          if (record) await rename(file.tombstone, file.path).catch(() => {});
          else await rm(file.tombstone, { force: true }).catch(() => {});
        } catch { /* Startup reconciliation resolves staged files if the transaction result is unknown. */ }
      }
      throw error;
    }
    let cleanupPending = false;
    for (const file of staged) if (await rm(file.tombstone, { force: true }).then(() => false, () => true)) cleanupPending = true;
    return { ok: true, cleanupPending };
  })
  .get("/classrooms/:classroomId/attendance", async ({ params, query, request }) => {
    const actor = await requireActor(request);
    await ownedClass(actor, params.classroomId);
    const date = query.date ?? bangkokToday();
    if (!validCalendarDate(date) || date > bangkokToday()) throw new HttpError(422, "วันที่ไม่ถูกต้อง");
    const [lesson] = await sql`
      SELECT starts_at AS "startsAt", ends_at AS "endsAt", grace_minutes AS "graceMinutes",
        cancelled_at AS "cancelledAt", finalized_at AS "finalizedAt"
      FROM classroom.lessons WHERE classroom_id = ${params.classroomId} AND lesson_date = ${date}::date
    `;
    const students = await sql`
      SELECT s.id AS "studentId", s.student_code AS "studentCode", s.student_number AS "studentNumber",
        s.display_name AS "displayName", a.status, a.source,
        p.first_arrival_at AS "firstArrivalAt", p.last_seen_at AS "lastSeenAt",
        p.visible_seconds AS "visibleSeconds", p.active_view IS NOT NULL AND p.last_heartbeat_at > NOW() - INTERVAL '45 seconds' AS "tracking"
      FROM classroom.students s
      LEFT JOIN classroom.attendance a ON a.student_id = s.id AND a.attendance_date = ${date}::date
      LEFT JOIN classroom.attendance_presence p ON p.student_id = s.id AND p.attendance_date = ${date}::date
      WHERE s.classroom_id = ${params.classroomId} AND s.archived_at IS NULL
      ORDER BY s.student_number NULLS LAST, s.display_name, s.id
    `;
    return { date, lesson: lesson ?? null, students };
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
      if ((!body.partial && rosterIds.size !== ids.length) || ids.some((id) => !rosterIds.has(id))) {
        throw new HttpError(409, "รายชื่อนักเรียนเปลี่ยนแล้ว กรุณาโหลดหน้าอีกครั้ง");
      }
      for (const id of [...ids].sort()) {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"daily-attendance:" + params.classroomId + ":" + id + ":" + body.date}, 0))`;
      }
      for (const entry of body.entries) {
        if (entry.status === null) {
          await tx`
            DELETE FROM classroom.attendance
            WHERE classroom_id = ${params.classroomId} AND student_id = ${entry.studentId} AND attendance_date = ${body.date}::date
          `;
          await tx`
            INSERT INTO classroom.attendance (classroom_id, student_id, attendance_date, status, source)
            SELECT p.classroom_id, p.student_id, p.attendance_date,
              CASE WHEN p.first_arrival_at <= l.starts_at + l.grace_minutes * INTERVAL '1 minute' THEN 'present' ELSE 'late' END,
              'automatic'
            FROM classroom.attendance_presence p JOIN classroom.lessons l
              ON l.classroom_id = p.classroom_id AND l.lesson_date = p.attendance_date
            WHERE p.classroom_id = ${params.classroomId} AND p.student_id = ${entry.studentId}
              AND p.attendance_date = ${body.date}::date
            ON CONFLICT (student_id, attendance_date) DO UPDATE
              SET status = EXCLUDED.status, source = 'automatic', updated_at = NOW()
              WHERE classroom.attendance.source = 'automatic'
          `;
        } else {
          await tx`
            INSERT INTO classroom.attendance (classroom_id, student_id, attendance_date, status)
            VALUES (${params.classroomId}, ${entry.studentId}, ${body.date}::date, ${entry.status})
            ON CONFLICT (student_id, attendance_date) DO UPDATE SET status = EXCLUDED.status, source = 'manual', updated_at = NOW()
          `;
        }
      }
    });
    return { ok: true, savedAt: new Date().toISOString() };
  }, { body: t.Object({ date: t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), partial: t.Optional(t.Boolean()), entries: t.Array(t.Object({ studentId: t.String({ format: "uuid" }), status: attendanceStatus }), { maxItems: 1000 }) }) })
  .get("/classrooms/:classroomId/summary", async ({ params, query, request }) => {
    const actor = await requireActor(request);
    await ownedClass(actor, params.classroomId);
    const to = query.to ?? bangkokToday();
    const from = query.from ?? to;
    if (!validCalendarDate(from) || !validCalendarDate(to) || from > to || to > bangkokToday()) {
      throw new HttpError(422, "ช่วงวันที่ไม่ถูกต้อง");
    }
    const students = await sql`
      SELECT s.id AS "studentId", s.student_code AS "studentCode", s.student_number AS "studentNumber", s.display_name AS "displayName",
        COUNT(a.status) FILTER (WHERE a.status = 'present')::int AS present,
        COUNT(a.status) FILTER (WHERE a.status = 'absent')::int AS absent,
        COUNT(a.status) FILTER (WHERE a.status = 'late')::int AS late,
        COUNT(a.status) FILTER (WHERE a.status = 'excused')::int AS excused,
        COALESCE(p.visible_seconds, 0)::int AS "visibleSeconds"
      FROM classroom.students s
      LEFT JOIN classroom.attendance a ON a.student_id = s.id
        AND a.attendance_date BETWEEN ${from}::date AND ${to}::date
      LEFT JOIN LATERAL (
        SELECT SUM(visible_seconds)::int AS visible_seconds FROM classroom.attendance_presence
        WHERE student_id = s.id AND attendance_date BETWEEN ${from}::date AND ${to}::date
      ) p ON TRUE
      WHERE s.classroom_id = ${params.classroomId}
      GROUP BY s.id ORDER BY s.archived_at NULLS FIRST, s.student_number NULLS LAST, s.display_name, s.id
    `;
    return { from, to, students };
  }, { query: t.Object({ from: t.Optional(t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })), to: t.Optional(t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })) }) });
