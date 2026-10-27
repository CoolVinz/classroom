import { Elysia, t } from "elysia";
import { requireActor } from "../auth/session";
import { sql } from "../db/client";
import { HttpError } from "../http-error";
import { bangkokToday, checkRequestOrigin, validCalendarDate } from "../security";

const hhmm = t.String({ pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" });

async function ownedClass(classroomId: string, ownerId: string) {
  const [room] = await sql`SELECT id FROM classroom.classrooms WHERE id = ${classroomId} AND owner_id = ${ownerId} AND archived_at IS NULL`;
  if (!room) throw new HttpError(404, "ไม่พบห้องเรียนนี้");
}

export const attendanceScheduleRoutes = new Elysia({ prefix: "/api" })
  .get("/classrooms/:classroomId/timetable", async ({ params, request }) => {
    const actor = await requireActor(request);
    await ownedClass(params.classroomId, actor.id);
    const [timetable] = await sql<{ termStartsOn: string; termEndsOn: string; graceMinutes: number }[]>`
      SELECT to_char(term_starts_on, 'YYYY-MM-DD') AS "termStartsOn",
        to_char(term_ends_on, 'YYYY-MM-DD') AS "termEndsOn", grace_minutes AS "graceMinutes"
      FROM classroom.weekly_timetables WHERE classroom_id = ${params.classroomId}
    `;
    const weekdays = timetable ? await sql<{ weekday: number; startsAt: string; endsAt: string }[]>`
      SELECT weekday, to_char(starts_at, 'HH24:MI') AS "startsAt", to_char(ends_at, 'HH24:MI') AS "endsAt"
      FROM classroom.weekly_timetable_days WHERE classroom_id = ${params.classroomId} ORDER BY weekday
    ` : [];
    const lessons = await sql<{ date: string; startsAt: string; endsAt: string; cancelledAt: string | null; finalizedAt: string | null }[]>`
      SELECT to_char(lesson_date, 'YYYY-MM-DD') AS date, starts_at AS "startsAt", ends_at AS "endsAt",
        cancelled_at AS "cancelledAt", finalized_at AS "finalizedAt"
      FROM classroom.lessons WHERE classroom_id = ${params.classroomId}
        AND lesson_date >= (NOW() AT TIME ZONE 'Asia/Bangkok')::date
      ORDER BY lesson_date
    `;
    return { timetable: timetable ?? null, weekdays, lessons };
  })
  .put("/classrooms/:classroomId/timetable", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedClass(params.classroomId, actor.id);
    if (!validCalendarDate(body.termStartsOn) || !validCalendarDate(body.termEndsOn)
      || body.termStartsOn > body.termEndsOn
      || Date.parse(body.termEndsOn + "T00:00:00Z") - Date.parse(body.termStartsOn + "T00:00:00Z") > 365 * 86400000) {
      throw new HttpError(422, "ช่วงวันที่ของตารางเรียนไม่ถูกต้อง (ไม่เกินหนึ่งปี)");
    }
    if (!body.weekdays.length || new Set(body.weekdays.map((day) => day.weekday)).size !== body.weekdays.length
      || body.weekdays.some((day) => day.endsAt <= day.startsAt)) {
      throw new HttpError(422, "เลือกวันเรียนที่ไม่ซ้ำและกำหนดเวลาเลิกหลังเวลาเริ่ม");
    }
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"timetable:" + params.classroomId}, 0))`;
      await tx`
        INSERT INTO classroom.weekly_timetables (classroom_id, term_starts_on, term_ends_on, grace_minutes)
        VALUES (${params.classroomId}, ${body.termStartsOn}::date, ${body.termEndsOn}::date, ${body.graceMinutes})
        ON CONFLICT (classroom_id) DO UPDATE SET term_starts_on = EXCLUDED.term_starts_on,
          term_ends_on = EXCLUDED.term_ends_on, grace_minutes = EXCLUDED.grace_minutes
      `;
      await tx`DELETE FROM classroom.weekly_timetable_days WHERE classroom_id = ${params.classroomId}`;
      for (const day of body.weekdays) await tx`
        INSERT INTO classroom.weekly_timetable_days (classroom_id, weekday, starts_at, ends_at)
        VALUES (${params.classroomId}, ${day.weekday}, ${day.startsAt}::time, ${day.endsAt}::time)
      `;
      await tx`
        DELETE FROM classroom.lessons l
        WHERE l.classroom_id = ${params.classroomId} AND l.starts_at > NOW()
          AND l.cancelled_at IS NULL AND l.finalized_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM classroom.weekly_timetable_days d
            JOIN classroom.weekly_timetables w USING (classroom_id)
            WHERE d.classroom_id = l.classroom_id
              AND l.lesson_date BETWEEN w.term_starts_on AND w.term_ends_on
              AND EXTRACT(ISODOW FROM l.lesson_date) = d.weekday
          )
      `;
      await tx`
        INSERT INTO classroom.lessons (classroom_id, lesson_date, starts_at, ends_at, grace_minutes)
        SELECT w.classroom_id, generated.lesson_date::date,
          (generated.lesson_date::date + d.starts_at) AT TIME ZONE 'Asia/Bangkok',
          (generated.lesson_date::date + d.ends_at) AT TIME ZONE 'Asia/Bangkok', w.grace_minutes
        FROM classroom.weekly_timetables w
        JOIN classroom.weekly_timetable_days d USING (classroom_id)
        CROSS JOIN LATERAL generate_series(w.term_starts_on::timestamp, w.term_ends_on::timestamp, INTERVAL '1 day') generated(lesson_date)
        WHERE w.classroom_id = ${params.classroomId}
          AND generated.lesson_date::date >= (NOW() AT TIME ZONE 'Asia/Bangkok')::date
          AND EXTRACT(ISODOW FROM generated.lesson_date) = d.weekday
          AND (generated.lesson_date::date + d.ends_at) AT TIME ZONE 'Asia/Bangkok' > NOW()
        ON CONFLICT (classroom_id, lesson_date) DO UPDATE SET
          starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, grace_minutes = EXCLUDED.grace_minutes
        WHERE classroom.lessons.starts_at > NOW() AND classroom.lessons.cancelled_at IS NULL
          AND classroom.lessons.finalized_at IS NULL
      `;
    });
    return { ok: true };
  }, { body: t.Object({
    termStartsOn: t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    termEndsOn: t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    graceMinutes: t.Integer({ minimum: 0, maximum: 120 }),
    weekdays: t.Array(t.Object({ weekday: t.Integer({ minimum: 1, maximum: 7 }), startsAt: hhmm, endsAt: hhmm }), { minItems: 1, maxItems: 7 }),
  }) })
  .patch("/classrooms/:classroomId/lessons/:lessonDate", async ({ params, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedClass(params.classroomId, actor.id);
    if (!validCalendarDate(params.lessonDate)) throw new HttpError(422, "วันที่ไม่ถูกต้อง");
    const [lesson] = await sql`
      UPDATE classroom.lessons SET cancelled_at = NOW()
      WHERE classroom_id = ${params.classroomId} AND lesson_date = ${params.lessonDate}::date
        AND starts_at > NOW() AND cancelled_at IS NULL AND finalized_at IS NULL
      RETURNING lesson_date
    `;
    if (!lesson) throw new HttpError(409, "ยกเลิกได้เฉพาะคาบเรียนที่ยังไม่เริ่ม");
    return { ok: true };
  })
  .post("/classrooms/:classroomId/attendance/:attendanceDate/finalize", async ({ params, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedClass(params.classroomId, actor.id);
    if (!validCalendarDate(params.attendanceDate) || params.attendanceDate > bangkokToday()) {
      throw new HttpError(422, "วันที่ไม่ถูกต้อง");
    }
    const result = await sql.begin(async (tx) => {
      const [lesson] = await tx<{ startsAt: Date; endsAt: Date; cancelledAt: Date | null; finalizedAt: Date | null; ended: boolean }[]>`
        SELECT starts_at AS "startsAt", ends_at AS "endsAt", cancelled_at AS "cancelledAt", finalized_at AS "finalizedAt",
          ends_at <= NOW() AS ended
        FROM classroom.lessons WHERE classroom_id = ${params.classroomId} AND lesson_date = ${params.attendanceDate}::date
        FOR UPDATE
      `;
      if (!lesson || lesson.cancelledAt) throw new HttpError(404, "ไม่พบคาบเรียนนี้");
      if (!lesson.ended) throw new HttpError(409, "ยังไม่ถึงเวลาเลิกเรียน");
      if (lesson.finalizedAt) return { finalizedAt: lesson.finalizedAt, addedAbsent: 0 };
      const students = await tx<{ id: string }[]>`
        SELECT id FROM classroom.students WHERE classroom_id = ${params.classroomId}
          AND created_at <= ${lesson.endsAt}::timestamptz
          AND (archived_at IS NULL OR archived_at >= ${lesson.endsAt}::timestamptz)
        ORDER BY id
      `;
      for (const student of students) {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"daily-attendance:" + params.classroomId + ":" + student.id + ":" + params.attendanceDate}, 0))`;
      }
      const [added] = await tx<{ count: number }[]>`
        WITH inserted AS (
          INSERT INTO classroom.attendance (classroom_id, student_id, attendance_date, status, source)
          SELECT ${params.classroomId}, s.id, ${params.attendanceDate}::date, 'absent', 'manual'
          FROM classroom.students s
          WHERE s.classroom_id = ${params.classroomId} AND s.id = ANY(${students.map((student) => student.id)}::uuid[])
            AND NOT EXISTS (SELECT 1 FROM classroom.attendance a WHERE a.student_id = s.id AND a.attendance_date = ${params.attendanceDate}::date)
            AND NOT EXISTS (SELECT 1 FROM classroom.attendance_presence p WHERE p.student_id = s.id AND p.attendance_date = ${params.attendanceDate}::date)
          ON CONFLICT (student_id, attendance_date) DO NOTHING
          RETURNING 1
        ) SELECT COUNT(*)::int AS count FROM inserted
      `;
      const [updated] = await tx<{ finalizedAt: Date }[]>`
        UPDATE classroom.lessons SET finalized_at = NOW()
        WHERE classroom_id = ${params.classroomId} AND lesson_date = ${params.attendanceDate}::date
        RETURNING finalized_at AS "finalizedAt"
      `;
      return { finalizedAt: updated.finalizedAt, addedAbsent: added.count };
    });
    return { ok: true, ...result };
  })
  .post("/classrooms/:classroomId/attendance/:attendanceDate/students/:studentId/reset", async ({ params, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedClass(params.classroomId, actor.id);
    if (!validCalendarDate(params.attendanceDate) || params.attendanceDate > bangkokToday()) {
      throw new HttpError(422, "วันที่ไม่ถูกต้อง");
    }
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"daily-attendance:" + params.classroomId + ":" + params.studentId + ":" + params.attendanceDate}, 0))`;
      await tx`DELETE FROM classroom.attendance WHERE classroom_id = ${params.classroomId}
        AND student_id = ${params.studentId} AND attendance_date = ${params.attendanceDate}::date AND source = 'manual'`;
      await tx`
        INSERT INTO classroom.attendance (classroom_id, student_id, attendance_date, status, source)
        SELECT p.classroom_id, p.student_id, p.attendance_date,
          CASE WHEN p.first_arrival_at <= l.starts_at + l.grace_minutes * INTERVAL '1 minute' THEN 'present' ELSE 'late' END,
          'automatic'
        FROM classroom.attendance_presence p JOIN classroom.lessons l
          ON l.classroom_id = p.classroom_id AND l.lesson_date = p.attendance_date
        WHERE p.classroom_id = ${params.classroomId} AND p.student_id = ${params.studentId}
          AND p.attendance_date = ${params.attendanceDate}::date
        ON CONFLICT (student_id, attendance_date) DO UPDATE
          SET status = EXCLUDED.status, source = 'automatic', updated_at = NOW()
          WHERE classroom.attendance.source = 'automatic'
      `;
    });
    return { ok: true };
  });
