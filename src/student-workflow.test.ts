import { describe, expect, spyOn, test } from "bun:test";
import { OAuth2Client } from "google-auth-library";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, utimes } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { Elysia } from "elysia";

const databaseUrl = process.env.CLASSROOM_TEST_DATABASE_URL;

function thumbnailChunk(type: string, data: Buffer) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0); chunk.write(type, 4); data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, data.length + 8)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
  return chunk;
}

function syntheticThumbnail() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(256, 0); header.writeUInt32BE(192, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(192 * (256 * 4 + 1));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), thumbnailChunk("IHDR", header), thumbnailChunk("IDAT", deflateSync(pixels)), thumbnailChunk("IEND", Buffer.alloc(0))]);
}

describe("student submission API", () => {
  if (!databaseUrl) {
    test.skip("set CLASSROOM_TEST_DATABASE_URL to an isolated migrated PostgreSQL database", () => {});
    return;
  }

  test("keeps class membership and file access private while accepting append-only uploads", async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.DATABASE_SSL = process.env.CLASSROOM_TEST_DATABASE_SSL ?? "disable";
    process.env.APP_URL = "http://localhost:3000";
    process.env.GOOGLE_CLIENT_ID = "classroom-test-client";
    process.env.GOOGLE_WORKSPACE_DOMAIN = "banjan.ac.th";
    process.env.UPLOAD_MAX_FILE_BYTES = String(1024 * 1024);
    process.env.UPLOAD_MAX_TOTAL_BYTES = String(5 * 1024 * 1024);
    const uploadDir = "/private/tmp/classroom-student-test-" + randomUUID();
    process.env.UPLOAD_DIR = uploadDir;
    await mkdir(uploadDir, { recursive: true });

    const { sql } = await import("./db/client");
    const { createSession } = await import("./auth/session");
    const [{ authRoutes }, { studentAuthRoutes }, { classroomRoutes }, { courseworkRoutes }, { studentCourseworkRoutes }, { attendanceScheduleRoutes }, { studentAttendanceRoutes }, { handleAppError }] = await Promise.all([
      import("./routes/auth"), import("./routes/student-auth"), import("./routes/classrooms"),
      import("./routes/coursework"), import("./routes/student-coursework"), import("./routes/attendance-schedule"), import("./routes/student-attendance"),
      import("./error-handler"),
    ]);
    const { ensureUploadRoot } = await import("./file-storage");
    const app = new Elysia().onError(handleAppError).use(authRoutes).use(studentAuthRoutes).use(classroomRoutes).use(attendanceScheduleRoutes).use(courseworkRoutes).use(studentCourseworkRoutes).use(studentAttendanceRoutes);
    const teacherId = randomUUID(); const accountId = randomUUID();
    const roomA = randomUUID(); const roomB = randomUUID(); const emptyRoom = randomUUID();
    const studentA = randomUUID(); const studentB = randomUUID(); const studentC = randomUUID(); const studentD = randomUUID();
    const assignmentA = randomUUID(); const assignmentB = randomUUID();
    const teacherFile = randomUUID(); const peerFile = randomUUID();
    let teacherToken = ""; let studentToken = ""; let otherTeacherToken = "";
    const otherTeacherId = randomUUID();
    let deleteTriggerName = ""; let deleteFunctionName = ""; let deleteTriggerInstalled = false;
    let peerAccountId: string | null = null;
    const accountEmail = "student-" + accountId.slice(0, 8) + "@banjan.ac.th";
    const peerEmail = "peer-" + accountId.slice(0, 8) + "@banjan.ac.th";
    const claims = new Map<string, Record<string, unknown>>();
    const verification = spyOn(OAuth2Client.prototype, "verifyIdToken").mockImplementation(async ({ idToken, audience }) => {
      const payload = claims.get(idToken);
      if (!payload || payload.aud !== audience) throw new Error("Invalid test token");
      return { getPayload: () => payload } as never;
    });
    function token(email: string, sub: string, extra: Record<string, unknown> = {}) {
      const value = "token-" + sub;
      claims.set(value, { sub, email, email_verified: true, hd: "banjan.ac.th", iss: "https://accounts.google.com", aud: "classroom-test-client", exp: Math.floor(Date.now() / 1000) + 3600, ...extra });
      return value;
    }
    async function googleLogin(value: string, cookie = "csrf-token", submitted = cookie) {
      const body = new URLSearchParams({ credential: value, g_csrf_token: submitted });
      return app.handle(new Request("http://localhost/api/auth/student/google", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: `g_csrf_token=${cookie}` }, body,
      }));
    }

    try {
      const configuredClient = process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_ID;
      const googleConfig = await app.handle(new Request("http://localhost/api/auth/student/config"));
      expect(await googleConfig.json()).toMatchObject({ enabled: false, clientId: null, domain: "banjan.ac.th" });
      process.env.GOOGLE_CLIENT_ID = configuredClient;
      const passwordHash = await Bun.password.hash("temporary-test-password", { algorithm: "argon2id" });
      await sql.begin(async (tx) => {
        await tx`INSERT INTO classroom.teachers (id, username, display_name, password_hash) VALUES (${teacherId}, ${"it-" + teacherId.slice(0, 8)}, 'Teacher', ${passwordHash})`;
        await tx`INSERT INTO classroom.teachers (id, username, display_name, password_hash, role) VALUES (${otherTeacherId}, ${"other-" + otherTeacherId.slice(0, 8)}, 'Other Teacher', ${passwordHash}, 'teacher')`;
        await tx`INSERT INTO classroom.student_accounts (id, email, password_hash) VALUES (${accountId}, ${accountEmail}, ${passwordHash})`;
        await tx`INSERT INTO classroom.classrooms (id, owner_id, name) VALUES (${roomA}, ${teacherId}, 'Room A'), (${roomB}, ${teacherId}, 'Room B'), (${emptyRoom}, ${teacherId}, 'Empty Room')`;
        await tx`INSERT INTO classroom.students (id, classroom_id, student_code, display_name, email, account_id)
          VALUES (${studentA}, ${roomA}, '001', 'Student One', ${accountEmail}, ${accountId}),
            (${studentB}, ${roomA}, '002', 'Student Two', ${peerEmail}, NULL),
            (${studentC}, ${roomB}, '001', 'Student One', ${accountEmail}, NULL)`;
        await tx`INSERT INTO classroom.assignments (id, classroom_id, title) VALUES (${assignmentA}, ${roomA}, 'Build'), (${assignmentB}, ${roomB}, 'Draw')`;
        await tx`INSERT INTO classroom.files (id, classroom_id, assignment_id, uploaded_by, kind, original_name, storage_name, media_type, size_bytes)
          VALUES (${teacherFile}, ${roomA}, ${assignmentA}, ${teacherId}, 'worksheet', 'task.pdf', ${randomUUID()}, 'application/pdf', 8)`;
        await tx`INSERT INTO classroom.files (id, classroom_id, assignment_id, student_id, uploaded_by, kind, original_name, storage_name, media_type, size_bytes)
          VALUES (${peerFile}, ${roomA}, ${assignmentA}, ${studentB}, ${teacherId}, 'model', 'peer.stl', ${randomUUID()}, 'model/stl', 8)`;
      });
      teacherToken = await createSession(teacherId);
      otherTeacherToken = await createSession(otherTeacherId);
      const studentIdentityToken = token(accountEmail, "google-sub-" + accountId);
      const noCsrf = await googleLogin(studentIdentityToken, "csrf-token", "wrong-token");
      expect(new URL(noCsrf.headers.get("location")!).searchParams.get("error")).toBe("signin");
      const missingCsrf = await googleLogin(studentIdentityToken, "", "");
      expect(new URL(missingCsrf.headers.get("location")!).searchParams.get("error")).toBe("signin");
      const wrongDomain = await googleLogin(token("student@other.ac.th", "wrong-domain", { hd: "other.ac.th" }));
      expect(new URL(wrongDomain.headers.get("location")!).searchParams.get("error")).toBe("domain");
      const wrongAudience = await googleLogin(token(accountEmail, "wrong-audience", { aud: "another-client" }));
      expect(new URL(wrongAudience.headers.get("location")!).searchParams.get("error")).toBe("signin");
      expect(new URL((await googleLogin("missing-token")).headers.get("location")!).searchParams.get("error")).toBe("signin");
      const expired = await googleLogin(token(accountEmail, "expired", { exp: Math.floor(Date.now() / 1000) - 1 }));
      expect(new URL(expired.headers.get("location")!).searchParams.get("error")).toBe("domain");
      const wrongIssuer = await googleLogin(token(accountEmail, "wrong-issuer", { iss: "https://example.test" }));
      expect(new URL(wrongIssuer.headers.get("location")!).searchParams.get("error")).toBe("domain");
      const unverified = await googleLogin(token(accountEmail, "unverified", { email_verified: false }));
      expect(new URL(unverified.headers.get("location")!).searchParams.get("error")).toBe("domain");
      const signedIn = await googleLogin(studentIdentityToken);
      expect(signedIn.status).toBe(303);
      studentToken = signedIn.headers.get("set-cookie")!.split(";")[0].split("=")[1];
      let studentHeaders = { cookie: signedIn.headers.get("set-cookie")!.split(";")[0], origin: "http://localhost:3000" };
      const teacherHeaders = { cookie: `classroom_session=${teacherToken}`, origin: "http://localhost:3000" };

      const timetableRequest = (classroomId: string, termStartsOn: string, termEndsOn: string) => app.handle(new Request(`http://localhost/api/classrooms/${classroomId}/timetable`, {
        method: "PUT", headers: { ...teacherHeaders, "content-type": "application/json" },
        body: JSON.stringify({ termStartsOn, termEndsOn, graceMinutes: 10, weekdays: [{ weekday: 2, startsAt: "10:00", endsAt: "11:00" }] }),
      }));
      const leapYearSchedule = await timetableRequest(emptyRoom, "2096-02-29", "2097-02-28");
      expect(leapYearSchedule.status).toBe(200);
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${emptyRoom}/timetable`, { headers: teacherHeaders })).then((response) => response.json()) as { timetable: { termStartsOn: string; termEndsOn: string; graceMinutes: number } }).timetable).toEqual({ termStartsOn: "2096-02-29", termEndsOn: "2097-02-28", graceMinutes: 10 });
      for (const [roomId, startsOn, endsOn] of [
        [roomB, "2096-02-29", "2097-03-01"],
        [roomB, "2027-02-23", "2026-10-27"],
      ]) {
        const invalidSchedule = await timetableRequest(roomId, startsOn, endsOn);
        expect(invalidSchedule.status).toBe(422);
        expect(await invalidSchedule.json()).toMatchObject({ error: "ช่วงวันที่ของตารางเรียนไม่ถูกต้อง (ไม่เกินหนึ่งปี)" });
      }
      const rejectedInput = await app.handle(new Request(`http://localhost/api/classrooms/${roomB}/timetable`, {
        method: "PUT", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ termStartsOn: "not-a-date" }),
      }));
      expect(rejectedInput.status).toBe(422);
      expect(await rejectedInput.json()).toMatchObject({ error: "ข้อมูลที่ส่งไม่ถูกต้อง กรุณาตรวจสอบค่าที่กรอก" });

      const scheduleDay = await sql<{ date: string; weekday: number }[]>`
        SELECT ((NOW() AT TIME ZONE 'Asia/Bangkok')::date + 2)::text AS date,
          EXTRACT(ISODOW FROM (NOW() AT TIME ZONE 'Asia/Bangkok')::date + 2)::int AS weekday
      `;
      const scheduled = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/timetable`, {
        method: "PUT", headers: { ...teacherHeaders, "content-type": "application/json" },
        body: JSON.stringify({ termStartsOn: scheduleDay[0].date, termEndsOn: scheduleDay[0].date, graceMinutes: 10, weekdays: [{ weekday: scheduleDay[0].weekday, startsAt: "09:00", endsAt: "10:00" }] }),
      }));
      expect(scheduled.status).toBe(200);
      const scheduleView = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/timetable`, { headers: teacherHeaders }));
      const scheduleData = await scheduleView.json() as {
        timetable: { termStartsOn: string; termEndsOn: string; graceMinutes: number };
        weekdays: { weekday: number; startsAt: string; endsAt: string }[];
        lessons: { date: string; startsAt: string; endsAt: string }[];
      };
      expect(scheduleData.timetable).toEqual({ termStartsOn: scheduleDay[0].date, termEndsOn: scheduleDay[0].date, graceMinutes: 10 });
      expect(scheduleData.lessons).toHaveLength(1);
      expect(scheduleData.lessons[0]).toMatchObject({ date: scheduleDay[0].date,
        startsAt: `${scheduleDay[0].date}T02:00:00.000Z`, endsAt: `${scheduleDay[0].date}T03:00:00.000Z` });
      const editedSchedule = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/timetable`, {
        method: "PUT", headers: { ...teacherHeaders, "content-type": "application/json" },
        body: JSON.stringify({ ...scheduleData.timetable, weekdays: scheduleData.weekdays.map((day) => ({ ...day, startsAt: "09:30", endsAt: "10:30" })) }),
      }));
      expect(editedSchedule.status).toBe(200);
      const reopenedSchedule = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/timetable`, { headers: teacherHeaders }));
      const reopenedData = await reopenedSchedule.json() as typeof scheduleData;
      expect(reopenedData.timetable).toEqual(scheduleData.timetable);
      expect(reopenedData.weekdays).toEqual([{ weekday: scheduleDay[0].weekday, startsAt: "09:30", endsAt: "10:30" }]);
      expect(reopenedData.lessons[0].startsAt).toBe(`${scheduleDay[0].date}T02:30:00.000Z`);
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/timetable`, { method: "PUT", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ termStartsOn: scheduleDay[0].date, termEndsOn: scheduleDay[0].date, graceMinutes: 10, weekdays: [{ weekday: scheduleDay[0].weekday, startsAt: "10:00", endsAt: "09:00" }] }) }))).status).toBe(422);
      const cancelLesson = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/lessons/${reopenedData.lessons[0].date}`, { method: "PATCH", headers: teacherHeaders }));
      expect(cancelLesson.status).toBe(200);
      const cancelledSchedule = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/timetable`, { headers: teacherHeaders }));
      expect((await cancelledSchedule.json() as { lessons: { cancelledAt: string | null }[] }).lessons[0].cancelledAt).not.toBeNull();
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/timetable`, { headers: studentHeaders }))).status).toBe(401);

      const todayDate = await sql<{ date: string }[]>`SELECT (NOW() AT TIME ZONE 'Asia/Bangkok')::date::text AS date`;
      await sql.begin(async (tx) => {
        await tx`INSERT INTO classroom.lessons (classroom_id, lesson_date, starts_at, ends_at, grace_minutes)
          VALUES (${roomA}, ${todayDate[0].date}::date, NOW() - INTERVAL '5 minutes', NOW() + INTERVAL '15 minutes', 10),
            (${roomB}, ${todayDate[0].date}::date, NOW() - INTERVAL '5 minutes', NOW() + INTERVAL '15 minutes', 10)`;
        await tx`UPDATE classroom.students SET created_at = NOW() - INTERVAL '2 days' WHERE id = ${studentB}`;
        await tx`INSERT INTO classroom.lessons (classroom_id, lesson_date, starts_at, ends_at, grace_minutes)
          VALUES (${roomA}, (${todayDate[0].date}::date - 1), NOW() - INTERVAL '1 day 2 hours', NOW() - INTERVAL '1 day 1 hour', 10)`;
      });
      const studentLessons = await app.handle(new Request("http://localhost/api/student/lessons", { headers: studentHeaders }));
      const studentLessonData = await studentLessons.json() as { classroomId: string; date: string; startsAt: string; endsAt: string }[];
      expect(studentLessonData.map((lesson) => lesson.classroomId).sort()).toEqual([roomA, roomB].sort());
      expect(studentLessonData.map((lesson) => lesson.date)).toEqual([todayDate[0].date, todayDate[0].date]);
      const viewId = randomUUID();
      const pulse = (active: boolean, sequence: number, classroomId = roomA) => app.handle(new Request(`http://localhost/api/student/classrooms/${classroomId}/attendance/presence`, {
        method: "POST", headers: { ...studentHeaders, "content-type": "application/json" },
        body: JSON.stringify({ lessonDate: studentLessonData.find((lesson) => lesson.classroomId === classroomId)!.date, viewId, sequence, active }),
      }));
      const arrived = await pulse(true, 1);
      expect(arrived.status).toBe(200);
      expect(await arrived.json()).toMatchObject({ accepted: true, attendanceStatus: "present", visibleSeconds: 0 });
      expect(await (await pulse(true, 1)).json()).toMatchObject({ accepted: false, reason: "stale" });
      expect(await (await pulse(true, 2, roomB)).json()).toMatchObject({ accepted: false, reason: "another-classroom" });
      const override = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/attendance`, {
        method: "PUT", headers: { ...teacherHeaders, "content-type": "application/json" },
        body: JSON.stringify({ date: todayDate[0].date, partial: true, entries: [{ studentId: studentA, status: "late" }] }),
      }));
      expect(override.status).toBe(200);
      const continued = await pulse(true, 2);
      expect(await continued.json()).toMatchObject({ attendanceStatus: "late" });
      const reset = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/attendance/${todayDate[0].date}/students/${studentA}/reset`, { method: "POST", headers: teacherHeaders }));
      expect(reset.status).toBe(200);
      const paused = await pulse(false, 3);
      expect(await paused.json()).toMatchObject({ accepted: true, attendanceStatus: "present" });
      const teacherAttendance = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/attendance?date=${todayDate[0].date}`, { headers: teacherHeaders }));
      const attendanceRows = (await teacherAttendance.json() as { students: { studentId: string; status: string | null; source: string | null; visibleSeconds: number }[] }).students;
      expect(attendanceRows.find((student) => student.studentId === studentA)).toMatchObject({ status: "present", source: "automatic" });
      expect(attendanceRows.find((student) => student.studentId === studentB)).toMatchObject({ studentId: studentB, status: null });
      const historicalLessons = await sql`SELECT lesson_date::text, starts_at, ends_at, grace_minutes
        FROM classroom.lessons WHERE classroom_id = ${roomA} AND lesson_date <= ${todayDate[0].date}::date ORDER BY lesson_date`;
      const recordedAttendance = await sql`SELECT * FROM classroom.attendance WHERE classroom_id = ${roomA}`;
      const recordedPresence = await sql`SELECT * FROM classroom.attendance_presence WHERE classroom_id = ${roomA}`;
      const timetableChange = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/timetable`, {
        method: "PUT", headers: { ...teacherHeaders, "content-type": "application/json" },
        body: JSON.stringify({ termStartsOn: todayDate[0].date, termEndsOn: scheduleDay[0].date, graceMinutes: 20,
          weekdays: [{ weekday: new Date(todayDate[0].date + "T12:00:00Z").getUTCDay() || 7, startsAt: "00:01", endsAt: "23:59" }] }),
      }));
      expect(timetableChange.status).toBe(200);
      expect([...(await sql`SELECT lesson_date::text, starts_at, ends_at, grace_minutes
        FROM classroom.lessons WHERE classroom_id = ${roomA} AND lesson_date <= ${todayDate[0].date}::date ORDER BY lesson_date`)]).toEqual([...historicalLessons]);
      expect([...(await sql`SELECT * FROM classroom.attendance WHERE classroom_id = ${roomA}`)]).toEqual([...recordedAttendance]);
      expect([...(await sql`SELECT * FROM classroom.attendance_presence WHERE classroom_id = ${roomA}`)]).toEqual([...recordedPresence]);
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/attendance/${todayDate[0].date}/finalize`, { method: "POST", headers: teacherHeaders }))).status).toBe(409);
      const finalized = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/attendance/${new Date(Date.parse(todayDate[0].date + "T12:00:00Z") - 86400000).toISOString().slice(0, 10)}/finalize`, { method: "POST", headers: teacherHeaders }));
      expect(finalized.status).toBe(200);
      expect(await finalized.json()).toMatchObject({ ok: true, addedAbsent: 1 });
      const finalizeAgain = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/attendance/${new Date(Date.parse(todayDate[0].date + "T12:00:00Z") - 86400000).toISOString().slice(0, 10)}/finalize`, { method: "POST", headers: teacherHeaders }));
      expect(await finalizeAgain.json()).toMatchObject({ ok: true, addedAbsent: 0 });
      const previousDate = new Date(Date.parse(todayDate[0].date + "T12:00:00Z") - 86400000).toISOString().slice(0, 10);
      expect(await sql`SELECT status FROM classroom.attendance WHERE student_id = ${studentB} AND attendance_date = ${previousDate}::date`).toMatchObject([{ status: "absent" }]);

      await sql.begin(async (tx) => {
        await tx`UPDATE classroom.attendance_presence SET visible_seconds = 120 WHERE student_id = ${studentA} AND attendance_date = ${todayDate[0].date}::date`;
        await tx`INSERT INTO classroom.attendance (classroom_id, student_id, attendance_date, status)
          VALUES (${roomA}, ${studentA}, ${previousDate}::date, 'late'), (${roomA}, ${studentB}, ${todayDate[0].date}::date, 'absent')`;
        await tx`INSERT INTO classroom.attendance_presence (classroom_id, student_id, attendance_date, first_arrival_at, last_seen_at, visible_seconds, last_heartbeat_at)
          VALUES (${roomA}, ${studentA}, ${previousDate}::date, NOW() - INTERVAL '1 day 90 minutes', NOW() - INTERVAL '1 day 90 minutes', 300, NOW() - INTERVAL '1 day 90 minutes')`;
        await tx`INSERT INTO classroom.students (id, classroom_id, student_code, display_name, archived_at)
          VALUES (${studentD}, ${roomA}, ${"archived-" + studentD.slice(0, 8)}, 'Archived Student', NOW())`;
        await tx`INSERT INTO classroom.attendance (classroom_id, student_id, attendance_date, status)
          VALUES (${roomA}, ${studentD}, ${todayDate[0].date}::date, 'excused')`;
      });
      const summaryResponse = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/summary?from=${previousDate}&to=${todayDate[0].date}`, { headers: teacherHeaders }));
      expect(summaryResponse.status).toBe(200);
      const summaryRows = (await summaryResponse.json() as { students: { studentId: string; present: number; absent: number; late: number; excused: number; visibleSeconds: number; archived: boolean }[] }).students;
      expect(summaryRows.find((student) => student.studentId === studentA)).toMatchObject({ present: 1, late: 1, visibleSeconds: 420, archived: false });
      expect(summaryRows.find((student) => student.studentId === studentB)).toMatchObject({ absent: 2, excused: 0 });
      expect(summaryRows.find((student) => student.studentId === studentD)).toMatchObject({ excused: 1, archived: true });
      const todaySummary = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/summary?from=${todayDate[0].date}&to=${todayDate[0].date}`, { headers: teacherHeaders }));
      const todayRows = (await todaySummary.json() as { students: { studentId: string; present: number; absent: number; late: number; excused: number; visibleSeconds: number }[] }).students;
      expect(todayRows.find((student) => student.studentId === studentA)).toMatchObject({ present: 1, late: 0, visibleSeconds: 120 });
      expect(todayRows.find((student) => student.studentId === studentB)).toMatchObject({ absent: 1 });
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${emptyRoom}/summary`, { headers: teacherHeaders })).then((response) => response.json()) as { students: unknown[] }).students).toEqual([]);
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/summary`, { headers: { cookie: `classroom_session=${otherTeacherToken}` } }))).status).toBe(404);
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/summary`))).status).toBe(401);

      const list = await app.handle(new Request("http://localhost/api/student/assignments", { headers: studentHeaders }));
      expect(list.status).toBe(200);
      expect((await list.json() as { assignmentId: string }[]).map((item) => item.assignmentId)).toEqual([assignmentA, assignmentB]);
      const [linkedAccount] = await sql<{ googleSubject: string; passwordHash: string }[]>`SELECT google_subject AS "googleSubject", password_hash AS "passwordHash" FROM classroom.student_accounts WHERE id = ${accountId}`;
      expect(linkedAccount).toMatchObject({ googleSubject: "google-sub-" + accountId });
      expect(await Bun.password.verify("temporary-test-password", linkedAccount.passwordHash)).toBe(true);
      const addedStudent = await app.handle(new Request("http://localhost/api/classrooms/" + roomB + "/students", {
        method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Roster Email Test", studentCode: "TEMP", studentNumber: 7 }),
      }));
      const addedStudentData = await addedStudent.json() as { id: string; email: string | null; studentNumber: number | null };
      expect(addedStudentData.email).toBeNull();
      expect(addedStudentData.studentNumber).toBe(7);
      const editedStudent = await app.handle(new Request("http://localhost/api/classrooms/" + roomB + "/students/" + addedStudentData.id, {
        method: "PATCH", headers: { ...teacherHeaders, "content-type": "application/json" },
        body: JSON.stringify({ studentCode: "000078", email: "" }),
      }));
      expect(editedStudent.status).toBe(200);
      const [editedEmail] = await sql<{ email: string }[]>`SELECT email FROM classroom.students WHERE id = ${addedStudentData.id}`;
      expect(editedEmail.email).toBe("000078@banjan.ac.th");
      const identityConflict = await googleLogin(token(accountEmail, "different-google-subject"));
      expect(new URL(identityConflict.headers.get("location")!).searchParams.get("error")).toBe("roster");

      const emailEdit = await app.handle(new Request("http://localhost/api/classrooms/" + roomB + "/students/" + studentC, {
        method: "PATCH", headers: { ...teacherHeaders, "content-type": "application/json" },
        body: JSON.stringify({ email: "  " + accountEmail.toUpperCase() + "  " }),
      }));
      expect(emailEdit.status).toBe(200);
      const importResult = await app.handle(new Request("http://localhost/api/classrooms/" + roomB + "/roster/import", {
        method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" },
        body: JSON.stringify({ students: [
          { studentCode: "001", studentNumber: 1, displayName: "Changed Name", email: "changed@example.test" },
          { studentCode: "0002", studentNumber: 2, displayName: "นักเรียนใหม่", email: "new@example.test" },
          { studentCode: "0003", displayName: "เลขศูนย์นำหน้า" },
          { studentCode: "000078", studentNumber: 77, displayName: "Existing number stays" },
        ] }),
      }));
      expect(await importResult.json()).toEqual({ added: 2, updated: 1, skipped: 1 });
      const roomRoster = await app.handle(new Request("http://localhost/api/classrooms/" + roomB + "/students", { headers: teacherHeaders }));
      const rosterRows = await roomRoster.json() as { id: string; studentCode: string; studentNumber: number | null; displayName: string; email: string | null; archived: boolean }[];
      expect(rosterRows.find((row) => row.id === studentC)).toMatchObject({
        id: studentC, studentCode: "001", studentNumber: 1, displayName: "Student One", email: accountEmail,
      });
      expect(rosterRows.find((row) => row.studentCode === "0002")?.email).toBe("new@example.test");
      expect(rosterRows.find((row) => row.studentCode === "0002")?.studentNumber).toBe(2);
      expect(rosterRows.find((row) => row.studentCode === "0003")?.email).toBe("0003@banjan.ac.th");
      expect(rosterRows.filter((row) => !row.archived).map((row) => row.studentNumber)).toEqual([1, 2, 7, null]);

      const duplicateNumber = await app.handle(new Request(`http://localhost/api/classrooms/${roomB}/students`, {
        method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Duplicate Number", studentCode: "DUP", studentNumber: 2 }),
      }));
      expect(duplicateNumber.status).toBe(409);
      const competingCreates = await Promise.all(["NUMBER-RACE-A", "NUMBER-RACE-B"].map((studentCode) => app.handle(new Request(`http://localhost/api/classrooms/${roomB}/students`, {
        method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" },
        body: JSON.stringify({ displayName: studentCode, studentCode, studentNumber: 11 }),
      }))));
      expect(competingCreates.map((response) => response.status).sort()).toEqual([200, 409]);
      const racedCreate = competingCreates.find((response) => response.status === 200)!;
      const racedCreateId = (await racedCreate.json() as { id: string }).id;
      await app.handle(new Request(`http://localhost/api/classrooms/${roomB}/students/${racedCreateId}`, { method: "DELETE", headers: teacherHeaders }));
      const competingImports = await Promise.all([1, 2].map(() => app.handle(new Request(`http://localhost/api/classrooms/${roomB}/roster/import`, {
        method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" },
        body: JSON.stringify({ students: [{ studentCode: "IMPORT-RACE", studentNumber: 12, displayName: "Concurrent import" }] }),
      }))));
      expect(competingImports.map((response) => response.status)).toEqual([200, 200]);
      const competingImportResults = await Promise.all(competingImports.map((response) => response.json())) as { added: number; updated: number; skipped: number }[];
      expect(competingImportResults.reduce((totals, result) => ({ added: totals.added + result.added, updated: totals.updated + result.updated, skipped: totals.skipped + result.skipped }), { added: 0, updated: 0, skipped: 0 })).toEqual({ added: 1, updated: 0, skipped: 1 });
      const archivedNumber = await app.handle(new Request(`http://localhost/api/classrooms/${roomB}/students`, {
        method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Archived Number", studentCode: "ARCHIVE-NUM", studentNumber: 9 }),
      }));
      const archivedNumberId = (await archivedNumber.json() as { id: string }).id;
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomB}/students/${archivedNumberId}`, {
        method: "PATCH", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ archived: true }),
      }))).status).toBe(200);
      const reusedNumber = await app.handle(new Request(`http://localhost/api/classrooms/${roomB}/students`, {
        method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Reused Number", studentCode: "REUSE-NUM", studentNumber: 9 }),
      }));
      const reusedNumberId = (await reusedNumber.json() as { id: string }).id;
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomB}/students/${archivedNumberId}`, {
        method: "PATCH", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ archived: false }),
      }))).status).toBe(409);
      const removedNumber = await app.handle(new Request(`http://localhost/api/classrooms/${roomB}/students/${reusedNumberId}`, { method: "DELETE", headers: teacherHeaders }));
      expect(removedNumber.status).toBe(200);
      expect(await removedNumber.json()).toEqual({ ok: true, cleanupPending: false });
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomB}/students/${archivedNumberId}`, {
        method: "PATCH", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ archived: false }),
      }))).status).toBe(200);
      const peerToken = token(peerEmail, "peer-google-sub");
      const peerLogins = await Promise.all([googleLogin(peerToken), googleLogin(peerToken)]);
      expect(peerLogins.map((response) => response.status)).toEqual([303, 303]);
      const peerLogin = peerLogins[0];
      const peerSessionCookie = peerLogin.headers.get("set-cookie")!.split(";")[0];
      const [peerAccount] = await sql<{ id: string }[]>`SELECT account_id AS id FROM classroom.students WHERE id = ${studentB}`;
      peerAccountId = peerAccount.id;
      expect(await sql`SELECT id FROM classroom.student_accounts WHERE email = ${peerEmail}`).toHaveLength(1);
      const unknownStudent = await googleLogin(token("not-rostered@banjan.ac.th", "unknown-student"));
      expect(new URL(unknownStudent.headers.get("location")!).searchParams.get("error")).toBe("roster");
      expect((await app.handle(new Request("http://localhost/api/auth/student/login", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: peerEmail, password: "anything" }),
      }))).status).toBe(410);
      for (const path of ["/invite/status", "/invite/accept", "/password-reset/request", "/password-reset/confirm"]) {
        expect((await app.handle(new Request("http://localhost/api/auth/student" + path, { method: "POST" }))).status).toBe(410);
      }
      expect((await app.handle(new Request("http://localhost/api/student/assignments", { headers: { cookie: peerSessionCookie } }))).status).toBe(200);
      const teacherLogin = await app.handle(new Request("http://localhost/api/auth/login", {
        method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ username: "it-" + teacherId.slice(0, 8), password: "temporary-test-password" }),
      }));
      expect(teacherLogin.status).toBe(200);
      expect((await app.handle(new Request("http://localhost/api/classrooms/" + roomA + "/students/" + studentA + "/invite", { method: "POST" }))).status).toBe(410);

      const filesResponse = await app.handle(new Request(`http://localhost/api/student/classrooms/${roomA}/assignments/${assignmentA}/files`, { headers: studentHeaders }));
      const files = await filesResponse.json() as { id: string }[];
      expect(filesResponse.status).toBe(200);
      expect(files.map((file) => file.id)).toEqual([teacherFile]);
      expect((await app.handle(new Request(`http://localhost/api/student/files/${peerFile}/content`, { headers: studentHeaders }))).status).toBe(404);
      const studentMissingWorksheet = await app.handle(new Request(`http://localhost/api/student/files/${teacherFile}/content`, { headers: studentHeaders }));
      expect(studentMissingWorksheet.status).toBe(404);
      expect(await studentMissingWorksheet.json()).toMatchObject({ error: expect.stringContaining("ต้นฉบับ") });
      const teacherMissingWorksheet = await app.handle(new Request(`http://localhost/api/files/${teacherFile}/content`, { headers: teacherHeaders }));
      expect(teacherMissingWorksheet.status).toBe(404);
      expect(await teacherMissingWorksheet.json()).toMatchObject({ error: expect.stringContaining("ต้นฉบับ") });
      const thumbnailBody = () => { const form = new FormData(); form.set("file", new File([syntheticThumbnail()], "preview.png", { type: "image/png" })); return form; };
      const savedThumbnail = await app.handle(new Request(`http://localhost/api/files/${teacherFile}/thumbnail`, { method: "PUT", headers: teacherHeaders, body: thumbnailBody() }));
      expect(savedThumbnail.status).toBe(200);
      const teacherThumbnail = await app.handle(new Request(`http://localhost/api/files/${teacherFile}/thumbnail`, { headers: teacherHeaders }));
      expect(teacherThumbnail.status).toBe(200);
      expect(teacherThumbnail.headers.get("content-type")).toBe("image/webp");
      expect(await (await teacherThumbnail.arrayBuffer()).byteLength).toBeGreaterThan(0);
      expect(await Bun.file(resolve(uploadDir, "thumbnails", teacherFile + ".webp")).exists()).toBe(true);
      expect((await app.handle(new Request(`http://localhost/api/files/${teacherFile}/content`, { headers: teacherHeaders }))).status).toBe(404);
      const interruptedThumbnail = resolve(uploadDir, "thumbnails", teacherFile + ".webp.deleting");
      await rename(resolve(uploadDir, "thumbnails", teacherFile + ".webp"), interruptedThumbnail);
      const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await utimes(interruptedThumbnail, oldTime, oldTime);
      await ensureUploadRoot();
      expect(await Bun.file(resolve(uploadDir, "thumbnails", teacherFile + ".webp")).exists()).toBe(true);
      expect((await app.handle(new Request(`http://localhost/api/files/${teacherFile}/thumbnail`, { headers: { cookie: `classroom_session=${otherTeacherToken}` } }))).status).toBe(404);
      const studentThumbnail = await app.handle(new Request(`http://localhost/api/student/files/${teacherFile}/thumbnail`, { headers: studentHeaders }));
      expect(studentThumbnail.status).toBe(200);
      expect(studentThumbnail.headers.get("content-type")).toBe("image/webp");
      expect((await app.handle(new Request(`http://localhost/api/student/files/${teacherFile}/thumbnail`, { method: "PUT", headers: studentHeaders, body: thumbnailBody() }))).status).toBe(200);
      expect((await app.handle(new Request(`http://localhost/api/files/${teacherFile}/thumbnail`, { headers: studentHeaders }))).status).toBe(401);
      expect(await Bun.file(resolve(uploadDir, "thumbnails", teacherFile + ".webp")).exists()).toBe(true);
      const deleteWorksheet = await app.handle(new Request(`http://localhost/api/files/${teacherFile}`, { method: "DELETE", headers: teacherHeaders }));
      expect(deleteWorksheet.status).toBe(200);
      expect(await Bun.file(resolve(uploadDir, "thumbnails", teacherFile + ".webp")).exists()).toBe(false);
      expect((await app.handle(new Request(`http://localhost/api/files/${teacherFile}/thumbnail`, { headers: teacherHeaders }))).status).toBe(404);
      expect((await app.handle(new Request(`http://localhost/api/files/${teacherFile}/content`, { headers: { cookie: `classroom_session=${otherTeacherToken}` } }))).status).toBe(404);
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/students`, { headers: studentHeaders }))).status).toBe(401);

      const form = new FormData();
      form.set("file", new File(["%PDF-1.7\nstudent work"], "work.pdf", { type: "application/pdf" }));
      process.env.UPLOAD_MAX_TOTAL_BYTES = "20";
      const rejectedUpload = await app.handle(new Request(`http://localhost/api/student/classrooms/${roomA}/assignments/${assignmentA}/files`, { method: "POST", headers: studentHeaders, body: form }));
      expect(rejectedUpload.status).toBe(413);
      expect(await readdir(uploadDir)).toEqual(["thumbnails"]);
      process.env.UPLOAD_MAX_TOTAL_BYTES = String(5 * 1024 * 1024);
      const upload = await app.handle(new Request(`http://localhost/api/student/classrooms/${roomA}/assignments/${assignmentA}/files`, { method: "POST", headers: studentHeaders, body: form }));
      expect(upload.status).toBe(200);
      const uploaded = await upload.json() as { id: string };
      const modelForm = new FormData();
      modelForm.set("file", new File(["solid student model\nendsolid student model"], "model.stl", { type: "model/stl" }));
      const modelUpload = await app.handle(new Request(`http://localhost/api/student/classrooms/${roomA}/assignments/${assignmentA}/files`, { method: "POST", headers: studentHeaders, body: modelForm }));
      expect(modelUpload.status).toBe(200);
      const uploadedModel = await modelUpload.json() as { id: string };
      const stored = await sql<{ kind: string; studentId: string; submittedBy: string }[]>`
        SELECT kind, student_id AS "studentId", submitted_by_account_id AS "submittedBy" FROM classroom.files WHERE id = ${uploaded.id}
      `;
      expect(stored[0]).toEqual({ kind: "submission", studentId: studentA, submittedBy: accountId });
      const modelRecord = await sql<{ kind: string }[]>`SELECT kind FROM classroom.files WHERE id = ${uploadedModel.id}`;
      expect(modelRecord[0].kind).toBe("model");
      expect((await app.handle(new Request(`http://localhost/api/student/files/${uploadedModel.id}/content`, { headers: studentHeaders }))).status).toBe(200);
      expect((await app.handle(new Request(`http://localhost/api/files/${uploadedModel.id}/content`, { headers: teacherHeaders }))).status).toBe(200);
      expect((await app.handle(new Request(`http://localhost/api/student/files/${uploaded.id}/content`, { headers: teacherHeaders }))).status).toBe(401);

      const teacherFiles = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/assignments/${assignmentA}/files`, { headers: teacherHeaders }));
      expect(teacherFiles.status).toBe(200);
      expect((await teacherFiles.json() as unknown[]).length).toBe(3);
      const assessmentsResponse = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/assignments/${assignmentA}/assessments`, { headers: teacherHeaders }));
      expect(assessmentsResponse.status).toBe(200);
      const assessments = await assessmentsResponse.json() as { maxScore: number | string; total: number; students: { studentId: string; submissionCount: number; latestFile: { id: string } | null }[] };
      expect(assessments).toMatchObject({ maxScore: "100.00", total: 3 });
      expect(assessments.students.find((item) => item.studentId === studentA)).toMatchObject({ submissionCount: 2, latestFile: { id: uploadedModel.id } });
      const assessmentPath = `/api/classrooms/${roomA}/assignments/${assignmentA}/students/${studentA}/assessment`;
      const assessmentRequest = (body: unknown) => app.handle(new Request(`http://localhost${assessmentPath}`, {
        method: "PUT", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify(body),
      }));
      expect((await assessmentRequest({ score: 8.5, feedback: "stale", revision: 1, reviewedFileIds: [] })).status).toBe(409);
      const firstDraft = await assessmentRequest({ score: 8.5, feedback: "โมเดลเรียบร้อย", revision: 0, reviewedFileIds: [uploaded.id, uploadedModel.id] });
      expect(firstDraft.status).toBe(200);
      expect(await firstDraft.json()).toMatchObject({ revision: 1 });
      expect((await assessmentRequest({ score: 101, feedback: "", revision: 1, reviewedFileIds: [uploaded.id, uploadedModel.id] })).status).toBe(422);
      expect((await assessmentRequest({ score: 8.555, feedback: "", revision: 1, reviewedFileIds: [uploaded.id, uploadedModel.id] })).status).toBe(422);
      expect((await assessmentRequest({ score: 9, feedback: "", revision: 0, reviewedFileIds: [uploaded.id, uploadedModel.id] })).status).toBe(409);
      const draftVisible = await app.handle(new Request("http://localhost/api/student/assignments", { headers: studentHeaders }));
      const draftAssignments = await draftVisible.json() as { assignmentId: string; publishedScore: number | null; draftScore?: number; draftFeedback?: string }[];
      expect(draftAssignments.find((item) => item.assignmentId === assignmentA)).toMatchObject({ publishedScore: null });
      expect(draftAssignments.find((item) => item.assignmentId === assignmentA)).not.toHaveProperty("draftScore");
      expect(draftAssignments.find((item) => item.assignmentId === assignmentA)).not.toHaveProperty("draftFeedback");
      const publishPath = `/api/classrooms/${roomA}/assignments/${assignmentA}/students/${studentA}/assessment/publish`;
      const publish = (revision: number) => app.handle(new Request(`http://localhost${publishPath}`, {
        method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ revision }),
      }));
      expect((await publish(0)).status).toBe(409);
      expect((await publish(1)).status).toBe(200);
      const publishedView = await app.handle(new Request("http://localhost/api/student/assignments", { headers: studentHeaders }));
      expect((await publishedView.json() as { assignmentId: string; publishedScore: number | string | null; publishedMaxScore: number | string | null; publishedFeedback: string | null }[]).find((item) => item.assignmentId === assignmentA)).toMatchObject({ publishedScore: "8.50", publishedMaxScore: "100.00", publishedFeedback: "โมเดลเรียบร้อย" });
      const laterSubmissionForm = new FormData();
      laterSubmissionForm.set("file", new File(["%PDF-1.7\nsecond draft"], "second.pdf", { type: "application/pdf" }));
      const laterSubmissionResponse = await app.handle(new Request(`http://localhost/api/student/classrooms/${roomA}/assignments/${assignmentA}/files`, { method: "POST", headers: studentHeaders, body: laterSubmissionForm }));
      const laterSubmission = await laterSubmissionResponse.json() as { id: string };
      expect(laterSubmissionResponse.status).toBe(200);
      const workAfterUpload = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/assignments/${assignmentA}/assessments`, { headers: teacherHeaders }));
      const workRows = await workAfterUpload.json() as { students: { studentId: string; publishedHasNewWork: boolean }[] };
      expect(workRows.students.find((item) => item.studentId === studentA)?.publishedHasNewWork).toBe(true);
      const refreshedDraft = await assessmentRequest({ score: 9.25, feedback: "ตรวจไฟล์ล่าสุดแล้ว", revision: 1, reviewedFileIds: [uploaded.id, uploadedModel.id, laterSubmission.id] });
      expect(refreshedDraft.status).toBe(200);
      expect(await refreshedDraft.json()).toMatchObject({ revision: 2 });
      const concurrentDrafts = await Promise.all([
        assessmentRequest({ score: 9.25, feedback: "ฉบับ A", revision: 2, reviewedFileIds: [uploaded.id, uploadedModel.id, laterSubmission.id] }),
        assessmentRequest({ score: 9.5, feedback: "ฉบับ B", revision: 2, reviewedFileIds: [uploaded.id, uploadedModel.id, laterSubmission.id] }),
      ]);
      expect(concurrentDrafts.map((response) => response.status).sort()).toEqual([200, 409]);
      expect((await publish(3)).status).toBe(200);
      const zeroScoreDraft = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/assignments/${assignmentA}/students/${studentB}/assessment`, {
        method: "PUT", headers: { ...teacherHeaders, "content-type": "application/json" },
        body: JSON.stringify({ score: 0, feedback: "ยังต้องฝึก", revision: 0, reviewedFileIds: [peerFile] }),
      }));
      expect(zeroScoreDraft.status).toBe(200);
      const zeroScorePublish = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/assignments/${assignmentA}/students/${studentB}/assessment/publish`, {
        method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ revision: 1 }),
      }));
      expect(zeroScorePublish.status).toBe(200);
      const maxScoreBody = { ...teacherHeaders, "content-type": "application/json" };
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/assignments/${assignmentA}`, { method: "PATCH", headers: maxScoreBody, body: JSON.stringify({ maxScore: 8 }) }))).status).toBe(422);
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/assignments/${assignmentA}`, { method: "PATCH", headers: maxScoreBody, body: JSON.stringify({ maxScore: 12 }) }))).status).toBe(200);
      const changedMax = await app.handle(new Request("http://localhost/api/student/assignments", { headers: studentHeaders }));
      const changedPublished = (await changedMax.json() as { assignmentId: string; publishedScore: number | string | null; publishedMaxScore: number | string | null }[]).find((item) => item.assignmentId === assignmentA)!;
      expect([9.25, 9.5]).toContain(Number(changedPublished.publishedScore));
      expect(changedPublished.publishedMaxScore).toBe("100.00");
      expect((await publish(3)).status).toBe(200);
      const republished = await app.handle(new Request("http://localhost/api/student/assignments", { headers: studentHeaders }));
      expect((await republished.json() as { assignmentId: string; publishedMaxScore: number | string | null; newWork: boolean }[]).find((item) => item.assignmentId === assignmentA)).toMatchObject({ publishedMaxScore: "12.00", newWork: false });
      const gradeRecord = (await sql`SELECT published_revision FROM classroom.assignment_assessments WHERE assignment_id = ${assignmentA} AND student_id = ${studentA}`)[0] as { published_revision: number };
      const hiddenGrade = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/assignments/${assignmentA}/students/${studentA}/assessment/unpublish`, {
        method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ revision: gradeRecord.published_revision }),
      }));
      expect(hiddenGrade.status).toBe(200);
      expect((await app.handle(new Request("http://localhost/api/student/assignments", { headers: studentHeaders })).then((response) => response.json()) as { assignmentId: string; publishedScore: number | null }[]).find((item) => item.assignmentId === assignmentA)?.publishedScore).toBeNull();
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/assignments/${assignmentA}/assessments`, { headers: studentHeaders }))).status).toBe(401);
      expect((await app.handle(new Request(`http://localhost${assessmentPath}`, { method: "PUT", headers: { ...studentHeaders, "content-type": "application/json" }, body: JSON.stringify({ score: 1, feedback: "", revision: 0, reviewedFileIds: [] }) }))).status).toBe(401);
      expect((await app.handle(new Request(`http://localhost/api/files/${uploaded.id}/content`, { headers: studentHeaders }))).status).toBe(401);
      expect((await app.handle(new Request(`http://localhost/api/files/${uploaded.id}`, { method: "DELETE", headers: studentHeaders }))).status).toBe(401);

      expect(await (await pulse(true, 4)).json()).toMatchObject({ accepted: true });
      const archiveMember = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/students/${studentA}`, {
        method: "PATCH", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ archived: true }),
      }));
      expect(archiveMember.status).toBe(200);
      expect(await sql`SELECT active_view FROM classroom.attendance_presence WHERE classroom_id = ${roomA} AND student_id = ${studentA}`).toMatchObject([{ active_view: null }, { active_view: null }]);
      expect((await pulse(true, 5)).status).toBe(404);
      expect((await app.handle(new Request(`http://localhost/api/student/classrooms/${roomA}/assignments/${assignmentA}/files`, { headers: studentHeaders }))).status).toBe(404);
      const remainingAssignments = await app.handle(new Request("http://localhost/api/student/assignments", { headers: studentHeaders }));
      expect((await remainingAssignments.json() as { assignmentId: string }[]).map((item) => item.assignmentId)).toEqual([assignmentB]);
      await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/students/${studentA}`, {
        method: "PATCH", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ archived: false }),
      }));

      await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/assignments/${assignmentA}`, {
        method: "PATCH", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ archived: true }),
      }));
      const afterArchive = await app.handle(new Request("http://localhost/api/student/assignments", { headers: studentHeaders }));
      expect((await afterArchive.json() as { assignmentId: string }[]).map((item) => item.assignmentId)).toEqual([assignmentB]);

      await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/assignments/${assignmentA}`, {
        method: "PATCH", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ archived: false }),
      }));
      const storageName = randomUUID(); const removedFileId = randomUUID(); const missingFileId = randomUUID(); const missingStorageName = randomUUID();
      await Bun.write(resolve(uploadDir, storageName), "synthetic student model");
      const removedThumbnail = syntheticThumbnail();
      await mkdir(resolve(uploadDir, "thumbnails"), { recursive: true });
      await Bun.write(resolve(uploadDir, "thumbnails", removedFileId + ".png"), removedThumbnail);
      await sql.begin(async (tx) => {
        await tx`INSERT INTO classroom.attendance (classroom_id, student_id, attendance_date, status) VALUES (${roomB}, ${studentC}, '2025-01-15', 'present')`;
        await tx`INSERT INTO classroom.files (id, classroom_id, assignment_id, student_id, uploaded_by, kind, original_name, storage_name, media_type, size_bytes, thumbnail_size_bytes, thumbnail_media_type)
          VALUES (${removedFileId}, ${roomB}, ${assignmentB}, ${studentC}, ${teacherId}, 'model', 'student.stl', ${storageName}, 'model/stl', 23, ${removedThumbnail.byteLength}, 'image/png')`;
        await tx`INSERT INTO classroom.files (id, classroom_id, assignment_id, student_id, uploaded_by, kind, original_name, storage_name, media_type, size_bytes)
          VALUES (${missingFileId}, ${roomB}, ${assignmentB}, ${studentC}, ${teacherId}, 'model', 'missing.stl', ${missingStorageName}, 'model/stl', 1)`;
      });
      const legacyThumbnail = await app.handle(new Request(`http://localhost/api/files/${removedFileId}/thumbnail`, { headers: teacherHeaders }));
      expect(legacyThumbnail.status).toBe(200);
      expect(legacyThumbnail.headers.get("content-type")).toBe("image/png");
      const blockedTombstone = resolve(uploadDir, storageName + ".deleting");
      await mkdir(blockedTombstone);
      await Bun.write(resolve(blockedTombstone, "keep"), "block the staged rename");
      const storageFailure = await app.handle(new Request(`http://localhost/api/classrooms/${roomB}/students/${studentC}`, { method: "DELETE", headers: teacherHeaders }));
      expect(storageFailure.status).toBe(500);
      expect(await sql`SELECT id FROM classroom.students WHERE id = ${studentC}`).toHaveLength(1);
      expect(await sql`SELECT student_id FROM classroom.attendance WHERE student_id = ${studentC}`).toHaveLength(1);
      expect(await sql`SELECT id FROM classroom.files WHERE id = ${removedFileId}`).toHaveLength(1);
      expect(await Bun.file(resolve(uploadDir, storageName)).exists()).toBe(true);
      expect(await Bun.file(resolve(uploadDir, "thumbnails", removedFileId + ".png")).exists()).toBe(true);
      await rm(blockedTombstone, { recursive: true, force: true });

      const suffix = randomUUID().replaceAll("-", "");
      deleteTriggerName = `test_delete_rollback_${suffix}`; deleteFunctionName = `test_delete_rollback_fn_${suffix}`;
      await sql.unsafe(`CREATE FUNCTION classroom.${deleteFunctionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id = '${studentC}'::uuid THEN RAISE EXCEPTION 'forced delete rollback'; END IF; RETURN OLD; END $$`).simple();
      await sql.unsafe(`CREATE TRIGGER ${deleteTriggerName} BEFORE DELETE ON classroom.students FOR EACH ROW EXECUTE FUNCTION classroom.${deleteFunctionName}()`).simple();
      deleteTriggerInstalled = true;
      const rolledBackDelete = await app.handle(new Request(`http://localhost/api/classrooms/${roomB}/students/${studentC}`, { method: "DELETE", headers: teacherHeaders }));
      expect(rolledBackDelete.status).toBe(500);
      expect(await sql`SELECT id FROM classroom.students WHERE id = ${studentC}`).toHaveLength(1);
      expect(await sql`SELECT id FROM classroom.files WHERE id = ${removedFileId}`).toHaveLength(1);
      expect(await Bun.file(resolve(uploadDir, storageName)).exists()).toBe(true);
      expect(await Bun.file(resolve(uploadDir, "thumbnails", removedFileId + ".png")).exists()).toBe(true);
      expect(await Bun.file(resolve(uploadDir, storageName + ".deleting")).exists()).toBe(false);
      expect(await Bun.file(resolve(uploadDir, "thumbnails", removedFileId + ".png.deleting")).exists()).toBe(false);
      await sql.unsafe(`DROP TRIGGER ${deleteTriggerName} ON classroom.students`).simple();
      await sql.unsafe(`DROP FUNCTION classroom.${deleteFunctionName}()`).simple();
      deleteTriggerInstalled = false;
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomB}/students/${studentC}`, { method: "DELETE", headers: studentHeaders }))).status).toBe(401);
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomB}/students/${studentC}`, {
        method: "DELETE", headers: { cookie: `classroom_session=${otherTeacherToken}`, origin: "http://localhost:3000" },
      }))).status).toBe(404);
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomB}/students/${studentC}`, {
        method: "DELETE", headers: { cookie: `classroom_session=${teacherToken}`, origin: "https://attacker.invalid" },
      }))).status).toBe(403);
      const concurrentUploadForm = new FormData();
      concurrentUploadForm.set("file", new File(["%PDF-1.7\nrace"], "race.pdf", { type: "application/pdf" }));
      const [removedStudent, concurrentUpload] = await Promise.all([
        app.handle(new Request(`http://localhost/api/classrooms/${roomB}/students/${studentC}`, { method: "DELETE", headers: teacherHeaders })),
        app.handle(new Request(`http://localhost/api/student/classrooms/${roomB}/assignments/${assignmentB}/files`, { method: "POST", headers: studentHeaders, body: concurrentUploadForm })),
      ]);
      expect(removedStudent.status).toBe(200);
      expect([200, 404]).toContain(concurrentUpload.status);
      const concurrentUploadData = concurrentUpload.status === 200 ? await concurrentUpload.json() as { id: string } : null;
      expect(await removedStudent.json()).toEqual({ ok: true, cleanupPending: false });
      expect(await Bun.file(resolve(uploadDir, storageName)).exists()).toBe(false);
      expect(await Bun.file(resolve(uploadDir, "thumbnails", removedFileId + ".png")).exists()).toBe(false);
      expect(await sql`SELECT id FROM classroom.students WHERE id = ${studentC}`).toHaveLength(0);
      expect(await sql`SELECT student_id FROM classroom.attendance WHERE student_id = ${studentC}`).toHaveLength(0);
      expect(await sql`SELECT id FROM classroom.files WHERE id = ${removedFileId}`).toHaveLength(0);
      expect(await sql`SELECT id FROM classroom.files WHERE id = ${missingFileId}`).toHaveLength(0);
      if (concurrentUploadData) expect(await sql`SELECT id FROM classroom.files WHERE id = ${concurrentUploadData.id}`).toHaveLength(0);
      expect(await sql`SELECT id FROM classroom.students WHERE id = ${studentA} AND account_id = ${accountId}`).toHaveLength(1);
      expect((await app.handle(new Request(`http://localhost/api/student/files/${removedFileId}/content`, { headers: studentHeaders }))).status).toBe(404);
      const membershipsAfterRemoval = await app.handle(new Request("http://localhost/api/student/assignments", { headers: studentHeaders }));
      expect((await membershipsAfterRemoval.json() as { assignmentId: string }[]).map((item) => item.assignmentId)).toEqual([assignmentA]);
    } finally {
      if (deleteTriggerInstalled) {
        await sql.unsafe(`DROP TRIGGER IF EXISTS ${deleteTriggerName} ON classroom.students`).simple().catch(() => {});
        await sql.unsafe(`DROP FUNCTION IF EXISTS classroom.${deleteFunctionName}()`).simple().catch(() => {});
      }
      const hash = (token: string) => createHash("sha256").update(token).digest("hex");
      if (teacherToken) await sql`DELETE FROM classroom.sessions WHERE token_hash = ${hash(teacherToken)}`;
      if (otherTeacherToken) await sql`DELETE FROM classroom.sessions WHERE token_hash = ${hash(otherTeacherToken)}`;
      if (studentToken) await sql`DELETE FROM classroom.student_sessions WHERE token_hash = ${hash(studentToken)}`;
      await sql.begin(async (tx) => {
        await tx`DELETE FROM classroom.files WHERE classroom_id IN (${roomA}, ${roomB}, ${emptyRoom})`;
        await tx`DELETE FROM classroom.assignments WHERE classroom_id IN (${roomA}, ${roomB}, ${emptyRoom})`;
        await tx`DELETE FROM classroom.attendance WHERE classroom_id IN (${roomA}, ${roomB}, ${emptyRoom})`;
        await tx`DELETE FROM classroom.lessons WHERE classroom_id IN (${roomA}, ${roomB}, ${emptyRoom})`;
        await tx`DELETE FROM classroom.weekly_timetables WHERE classroom_id IN (${roomA}, ${roomB}, ${emptyRoom})`;
        await tx`DELETE FROM classroom.students WHERE classroom_id IN (${roomA}, ${roomB}, ${emptyRoom})`;
        await tx`DELETE FROM classroom.classrooms WHERE id IN (${roomA}, ${roomB}, ${emptyRoom})`;
        if (peerAccountId) await tx`DELETE FROM classroom.student_accounts WHERE id = ${peerAccountId}`;
        await tx`DELETE FROM classroom.student_accounts WHERE id = ${accountId}`;
        await tx`DELETE FROM classroom.teachers WHERE id = ${otherTeacherId}`;
        await tx`DELETE FROM classroom.teachers WHERE id = ${teacherId}`;
      });
      await sql.end({ timeout: 5 });
      await rm(uploadDir, { recursive: true, force: true });
      verification.mockRestore();
    }
  }, 120000);
});
