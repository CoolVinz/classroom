import { Elysia, t } from "elysia";
import { requireStudent } from "../auth/session";
import { sql } from "../db/client";
import { HttpError } from "../http-error";
import { checkRequestOrigin, validCalendarDate } from "../security";

export const studentAttendanceRoutes = new Elysia({ prefix: "/api/student" })
  .get("/lessons", async ({ request }) => {
    const actor = await requireStudent(request);
    return sql`
      SELECT l.classroom_id AS "classroomId", c.name AS "classroomName",
        l.lesson_date AS date, l.starts_at AS "startsAt", l.ends_at AS "endsAt",
        l.grace_minutes AS "graceMinutes", p.first_arrival_at AS "firstArrivalAt",
        p.last_seen_at AS "lastSeenAt", p.visible_seconds AS "visibleSeconds",
        a.status AS "attendanceStatus"
      FROM classroom.lessons l
      JOIN classroom.classrooms c ON c.id = l.classroom_id
      JOIN classroom.students s ON s.classroom_id = c.id AND s.account_id = ${actor.id}
      LEFT JOIN classroom.attendance_presence p ON p.classroom_id = l.classroom_id
        AND p.student_id = s.id AND p.attendance_date = l.lesson_date
      LEFT JOIN classroom.attendance a ON a.classroom_id = l.classroom_id
        AND a.student_id = s.id AND a.attendance_date = l.lesson_date
      WHERE s.archived_at IS NULL AND c.archived_at IS NULL AND l.cancelled_at IS NULL
        AND l.lesson_date = (NOW() AT TIME ZONE 'Asia/Bangkok')::date
      ORDER BY l.starts_at, c.name
    `;
  })
  .post("/classrooms/:classroomId/attendance/presence", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireStudent(request);
    if (!validCalendarDate(body.lessonDate)) throw new HttpError(422, "วันที่ไม่ถูกต้อง");

    const result = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"presence-account:" + actor.id}, 0))`;
      const [lesson] = await tx<{
        studentId: string; startsAtEpoch: number; endsAtEpoch: number; nowEpoch: number;
        arrivalCutoffEpoch: number; firstArrivalAt: string | null; lastSeenAt: string | null;
        visibleSeconds: number; activeView: string | null; lastSequence: number | null; lastHeartbeatEpoch: number | null;
      }[]>`
        SELECT s.id AS "studentId", EXTRACT(EPOCH FROM l.starts_at)::float8 AS "startsAtEpoch",
          EXTRACT(EPOCH FROM l.ends_at)::float8 AS "endsAtEpoch", EXTRACT(EPOCH FROM NOW())::float8 AS "nowEpoch",
          EXTRACT(EPOCH FROM (l.starts_at + l.grace_minutes * INTERVAL '1 minute'))::float8 AS "arrivalCutoffEpoch",
          p.first_arrival_at AS "firstArrivalAt", p.last_seen_at AS "lastSeenAt",
          COALESCE(p.visible_seconds, 0)::int AS "visibleSeconds", p.active_view AS "activeView",
          p.last_sequence AS "lastSequence", EXTRACT(EPOCH FROM p.last_heartbeat_at)::float8 AS "lastHeartbeatEpoch"
        FROM classroom.lessons l
        JOIN classroom.classrooms c ON c.id = l.classroom_id
        JOIN classroom.students s ON s.classroom_id = c.id AND s.account_id = ${actor.id}
        LEFT JOIN classroom.attendance_presence p ON p.classroom_id = l.classroom_id
          AND p.student_id = s.id AND p.attendance_date = l.lesson_date
        WHERE l.classroom_id = ${params.classroomId} AND l.lesson_date = ${body.lessonDate}::date
          AND l.cancelled_at IS NULL AND s.archived_at IS NULL AND c.archived_at IS NULL
        FOR UPDATE OF l, s, c
      `;
      if (!lesson) throw new HttpError(404, "ไม่พบคาบเรียนนี้หรือไม่มีสิทธิ์เข้าเรียน");
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"daily-attendance:" + params.classroomId + ":" + lesson.studentId + ":" + body.lessonDate}, 0))`;
      const [other] = body.active ? await tx`
        SELECT 1 FROM classroom.attendance_presence p
        JOIN classroom.students s ON s.id = p.student_id AND s.classroom_id = p.classroom_id
        JOIN classroom.classrooms c ON c.id = p.classroom_id
        WHERE s.account_id = ${actor.id} AND s.archived_at IS NULL AND c.archived_at IS NULL
          AND p.active_view IS NOT NULL AND p.last_heartbeat_at > NOW() - INTERVAL '45 seconds'
          AND NOT (p.student_id = ${lesson.studentId} AND p.attendance_date = ${body.lessonDate}::date)
      ` : [];

      if (body.active) {
        if (lesson.nowEpoch < lesson.startsAtEpoch || lesson.nowEpoch >= lesson.endsAtEpoch) {
          throw new HttpError(409, "ขณะนี้อยู่นอกเวลาเช็กชื่อของคาบเรียน");
        }
        if (other) return { accepted: false, reason: "another-classroom", ...lesson };
        if (lesson.activeView && lesson.activeView !== body.viewId
          && lesson.lastHeartbeatEpoch !== null && lesson.nowEpoch - lesson.lastHeartbeatEpoch <= 45) {
          return { accepted: false, reason: "another-window", ...lesson };
        }
        if (lesson.activeView === body.viewId && (lesson.lastSequence ?? 0) >= body.sequence) {
          return { accepted: false, reason: "stale", ...lesson };
        }
        const sameView = lesson.activeView === body.viewId;
        const credited = sameView && lesson.lastHeartbeatEpoch !== null
          ? Math.max(0, Math.min(45, Math.floor(Math.min(lesson.nowEpoch, lesson.endsAtEpoch) - lesson.lastHeartbeatEpoch))) : 0;
        if (!lesson.firstArrivalAt) {
          await tx`
            INSERT INTO classroom.attendance_presence
              (classroom_id, student_id, attendance_date, first_arrival_at, last_seen_at,
               visible_seconds, active_view, last_sequence, last_heartbeat_at)
            VALUES (${params.classroomId}, ${lesson.studentId}, ${body.lessonDate}::date,
              NOW(), NOW(), 0, ${body.viewId}::uuid, ${body.sequence}, NOW())
          `;
          const status = lesson.nowEpoch <= lesson.arrivalCutoffEpoch ? "present" : "late";
          await tx`
            INSERT INTO classroom.attendance (classroom_id, student_id, attendance_date, status, source)
            VALUES (${params.classroomId}, ${lesson.studentId}, ${body.lessonDate}::date, ${status}, 'automatic')
            ON CONFLICT (student_id, attendance_date) DO UPDATE
              SET status = EXCLUDED.status, source = 'automatic', updated_at = NOW()
              WHERE classroom.attendance.source = 'automatic'
          `;
        } else {
          await tx`
            UPDATE classroom.attendance_presence SET
              visible_seconds = visible_seconds + ${credited}, last_seen_at = NOW(),
              active_view = ${body.viewId}::uuid, last_sequence = ${body.sequence}, last_heartbeat_at = NOW()
            WHERE student_id = ${lesson.studentId} AND attendance_date = ${body.lessonDate}::date
          `;
        }
      } else {
        if (lesson.activeView !== body.viewId || (lesson.lastSequence ?? 0) >= body.sequence) {
          return { accepted: false, reason: "stale", ...lesson };
        }
        const delta = lesson.lastHeartbeatEpoch === null ? 0
          : Math.max(0, Math.min(45, Math.floor(Math.min(lesson.nowEpoch, lesson.endsAtEpoch) - lesson.lastHeartbeatEpoch)));
        await tx`
          UPDATE classroom.attendance_presence SET visible_seconds = visible_seconds + ${delta},
            last_seen_at = LEAST(NOW(), ${new Date(lesson.endsAtEpoch * 1000)}::timestamptz),
            active_view = NULL, last_sequence = ${body.sequence}, last_heartbeat_at = NOW()
          WHERE student_id = ${lesson.studentId} AND attendance_date = ${body.lessonDate}::date
        `;
      }

      const [current] = await tx<{ firstArrivalAt: string; lastSeenAt: string; visibleSeconds: number; attendanceStatus: string | null }[]>`
        SELECT p.first_arrival_at AS "firstArrivalAt", p.last_seen_at AS "lastSeenAt",
          p.visible_seconds AS "visibleSeconds", a.status AS "attendanceStatus"
        FROM classroom.attendance_presence p
        LEFT JOIN classroom.attendance a ON a.student_id = p.student_id AND a.attendance_date = p.attendance_date
        WHERE p.student_id = ${lesson.studentId} AND p.attendance_date = ${body.lessonDate}::date
      `;
      return { accepted: true, ...current };
    });
    return result;
  }, { body: t.Object({
    lessonDate: t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    viewId: t.String({ format: "uuid" }),
    sequence: t.Integer({ minimum: 1, maximum: 2147483647 }),
    active: t.Boolean(),
  }) });
