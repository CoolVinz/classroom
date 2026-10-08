import { describe, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { Elysia } from "elysia";

const databaseUrl = process.env.CLASSROOM_TEST_DATABASE_URL;

describe("student submission API", () => {
  if (!databaseUrl) {
    test.skip("set CLASSROOM_TEST_DATABASE_URL to an isolated migrated PostgreSQL database", () => {});
    return;
  }

  test("keeps class membership and file access private while accepting append-only uploads", async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.DATABASE_SSL = "disable";
    process.env.APP_URL = "http://localhost:3000";
    process.env.UPLOAD_MAX_FILE_BYTES = String(1024 * 1024);
    process.env.UPLOAD_MAX_TOTAL_BYTES = String(5 * 1024 * 1024);
    const uploadDir = "/private/tmp/classroom-student-test-" + randomUUID();
    process.env.UPLOAD_DIR = uploadDir;

    const { sql } = await import("./db/client");
    const { createSession, createStudentSession } = await import("./auth/session");
    const [{ authRoutes }, { studentAuthRoutes }, { classroomRoutes }, { courseworkRoutes }, { studentCourseworkRoutes }] = await Promise.all([
      import("./routes/auth"), import("./routes/student-auth"), import("./routes/classrooms"),
      import("./routes/coursework"), import("./routes/student-coursework"),
    ]);
    const app = new Elysia().use(authRoutes).use(studentAuthRoutes).use(classroomRoutes).use(courseworkRoutes).use(studentCourseworkRoutes);
    const teacherId = randomUUID(); const accountId = randomUUID();
    const roomA = randomUUID(); const roomB = randomUUID();
    const studentA = randomUUID(); const studentB = randomUUID(); const studentC = randomUUID();
    const assignmentA = randomUUID(); const assignmentB = randomUUID();
    const teacherFile = randomUUID(); const peerFile = randomUUID();
    let teacherToken = ""; let studentToken = "";
    let peerAccountId: string | null = null;

    try {
      const passwordHash = await Bun.password.hash("temporary-test-password", { algorithm: "argon2id" });
      await sql.begin(async (tx) => {
        await tx`INSERT INTO classroom.teachers (id, username, display_name, password_hash) VALUES (${teacherId}, ${"it-" + teacherId.slice(0, 8)}, 'Teacher', ${passwordHash})`;
        await tx`INSERT INTO classroom.student_accounts (id, email, password_hash) VALUES (${accountId}, ${"student-" + accountId.slice(0, 8) + "@example.test"}, ${passwordHash})`;
        await tx`INSERT INTO classroom.classrooms (id, owner_id, name) VALUES (${roomA}, ${teacherId}, 'Room A'), (${roomB}, ${teacherId}, 'Room B')`;
        await tx`INSERT INTO classroom.students (id, classroom_id, student_code, display_name, email, account_id)
          VALUES (${studentA}, ${roomA}, '001', 'Student One', ${"student-" + accountId.slice(0, 8) + "@example.test"}, ${accountId}),
            (${studentB}, ${roomA}, '002', 'Student Two', 'peer-' || ${accountId.slice(0, 8)} || '@example.test', NULL),
            (${studentC}, ${roomB}, '001', 'Student One', ${"student-" + accountId.slice(0, 8) + "@example.test"}, NULL)`;
        await tx`INSERT INTO classroom.assignments (id, classroom_id, title) VALUES (${assignmentA}, ${roomA}, 'Build'), (${assignmentB}, ${roomB}, 'Draw')`;
        await tx`INSERT INTO classroom.files (id, classroom_id, assignment_id, uploaded_by, kind, original_name, storage_name, media_type, size_bytes)
          VALUES (${teacherFile}, ${roomA}, ${assignmentA}, ${teacherId}, 'worksheet', 'task.pdf', ${randomUUID()}, 'application/pdf', 8)`;
        await tx`INSERT INTO classroom.files (id, classroom_id, assignment_id, student_id, uploaded_by, kind, original_name, storage_name, media_type, size_bytes)
          VALUES (${peerFile}, ${roomA}, ${assignmentA}, ${studentB}, ${teacherId}, 'model', 'peer.stl', ${randomUUID()}, 'model/stl', 8)`;
      });
      teacherToken = await createSession(teacherId);
      studentToken = await createStudentSession(accountId);
      let studentHeaders = { cookie: `classroom_session=${studentToken}`, origin: "http://localhost:3000" };
      const teacherHeaders = { cookie: `classroom_session=${teacherToken}`, origin: "http://localhost:3000" };

      const list = await app.handle(new Request("http://localhost/api/student/assignments", { headers: studentHeaders }));
      expect(list.status).toBe(200);
      expect((await list.json() as { assignmentId: string }[]).map((item) => item.assignmentId)).toEqual([assignmentA]);

      const accountEmail = "student-" + accountId.slice(0, 8) + "@example.test";
      const emailEdit = await app.handle(new Request("http://localhost/api/classrooms/" + roomB + "/students/" + studentC, {
        method: "PATCH", headers: { ...teacherHeaders, "content-type": "application/json" },
        body: JSON.stringify({ email: "  " + accountEmail.toUpperCase() + "  " }),
      }));
      expect(emailEdit.status).toBe(200);
      const importResult = await app.handle(new Request("http://localhost/api/classrooms/" + roomB + "/roster/import", {
        method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" },
        body: JSON.stringify({ students: [
          { studentCode: "001", displayName: "Changed Name", email: "changed@example.test" },
          { studentCode: "0002", displayName: "นักเรียนใหม่", email: "new@example.test" },
        ] }),
      }));
      expect(await importResult.json()).toEqual({ added: 1, skipped: 1 });
      const roomRoster = await app.handle(new Request("http://localhost/api/classrooms/" + roomB + "/students", { headers: teacherHeaders }));
      const rosterRows = await roomRoster.json() as { id: string; studentCode: string; displayName: string; email: string | null }[];
      expect(rosterRows.find((row) => row.id === studentC)).toMatchObject({
        id: studentC, studentCode: "001", displayName: "Student One", email: accountEmail,
      });
      expect(rosterRows.find((row) => row.studentCode === "0002")?.email).toBe("new@example.test");
      const existingAccountInvite = randomBytes(32).toString("base64url");
      await sql`INSERT INTO classroom.student_auth_tokens (token_hash, token_kind, email, student_id, expires_at)
        VALUES (${createHash("sha256").update(existingAccountInvite).digest("hex")}, 'invite', ${accountEmail}, ${studentC}, NOW() + INTERVAL '24 hours')`;
      const inviteStatus = await app.handle(new Request("http://localhost/api/auth/student/invite/status", {
        method: "POST", headers: { ...studentHeaders, "content-type": "application/json" }, body: JSON.stringify({ token: existingAccountInvite }),
      }));
      expect(await inviteStatus.json()).toEqual({ needsPassword: false });
      const joined = await app.handle(new Request("http://localhost/api/auth/student/invite/accept", {
        method: "POST", headers: { ...studentHeaders, "content-type": "application/json" }, body: JSON.stringify({ token: existingAccountInvite }),
      }));
      expect(joined.status).toBe(200);
      studentHeaders = { ...studentHeaders, cookie: joined.headers.get("set-cookie")!.split(";")[0] };
      expect((await app.handle(new Request("http://localhost/api/auth/student/invite/status", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: existingAccountInvite }),
      }))).status).toBe(410);
      const linkedAssignments = await app.handle(new Request("http://localhost/api/student/assignments", { headers: studentHeaders }));
      expect((await linkedAssignments.json() as { assignmentId: string }[]).map((item) => item.assignmentId)).toEqual([assignmentA, assignmentB]);

      const peerEmail = "peer-" + accountId.slice(0, 8) + "@example.test";
      const newAccountInvite = randomBytes(32).toString("base64url");
      await sql`INSERT INTO classroom.student_auth_tokens (token_hash, token_kind, email, student_id, expires_at)
        VALUES (${createHash("sha256").update(newAccountInvite).digest("hex")}, 'invite', ${peerEmail}, ${studentB}, NOW() + INTERVAL '24 hours')`;
      const newAccountStatus = await app.handle(new Request("http://localhost/api/auth/student/invite/status", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: newAccountInvite }),
      }));
      expect(await newAccountStatus.json()).toEqual({ needsPassword: true });
      const activated = await app.handle(new Request("http://localhost/api/auth/student/invite/accept", {
        method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ token: newAccountInvite, password: "temporary-student-password" }),
      }));
      expect(activated.status).toBe(200);
      const peerSessionCookie = activated.headers.get("set-cookie")!.split(";")[0];
      const [peerAccount] = await sql<{ id: string }[]>`SELECT account_id AS id FROM classroom.students WHERE id = ${studentB}`;
      peerAccountId = peerAccount.id;
      const resetToken = randomBytes(32).toString("base64url");
      await sql`INSERT INTO classroom.student_auth_tokens (token_hash, token_kind, email, account_id, expires_at)
        VALUES (${createHash("sha256").update(resetToken).digest("hex")}, 'password_reset', ${peerEmail}, ${peerAccount.id}, NOW() + INTERVAL '1 hour')`;
      const reset = await app.handle(new Request("http://localhost/api/auth/student/password-reset/confirm", {
        method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ token: resetToken, password: "replacement-student-password" }),
      }));
      expect(reset.status).toBe(200);
      const resetAgain = await app.handle(new Request("http://localhost/api/auth/student/password-reset/confirm", {
        method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ token: resetToken, password: "replacement-student-password" }),
      }));
      expect(resetAgain.status).toBe(410);
      expect((await app.handle(new Request("http://localhost/api/student/assignments", { headers: { cookie: peerSessionCookie } }))).status).toBe(401);
      const peerLogin = await app.handle(new Request("http://localhost/api/auth/student/login", {
        method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ email: peerEmail, password: "replacement-student-password" }),
      }));
      expect(peerLogin.status).toBe(200);

      const filesResponse = await app.handle(new Request(`http://localhost/api/student/classrooms/${roomA}/assignments/${assignmentA}/files`, { headers: studentHeaders }));
      const files = await filesResponse.json() as { id: string }[];
      expect(filesResponse.status).toBe(200);
      expect(files.map((file) => file.id)).toEqual([teacherFile]);
      expect((await app.handle(new Request(`http://localhost/api/student/files/${peerFile}/content`, { headers: studentHeaders }))).status).toBe(404);
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/students`, { headers: studentHeaders }))).status).toBe(401);

      const form = new FormData();
      form.set("file", new File(["%PDF-1.7\nstudent work"], "work.pdf", { type: "application/pdf" }));
      process.env.UPLOAD_MAX_TOTAL_BYTES = "20";
      const rejectedUpload = await app.handle(new Request(`http://localhost/api/student/classrooms/${roomA}/assignments/${assignmentA}/files`, { method: "POST", headers: studentHeaders, body: form }));
      expect(rejectedUpload.status).toBe(413);
      expect(await readdir(uploadDir)).toEqual([]);
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

      const teacherFiles = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/assignments/${assignmentA}/files`, { headers: teacherHeaders }));
      expect(teacherFiles.status).toBe(200);
      expect((await teacherFiles.json() as unknown[]).length).toBe(4);
      expect((await app.handle(new Request(`http://localhost/api/files/${uploaded.id}/content`, { headers: studentHeaders }))).status).toBe(401);
      expect((await app.handle(new Request(`http://localhost/api/files/${uploaded.id}`, { method: "DELETE", headers: studentHeaders }))).status).toBe(401);

      const archiveMember = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/students/${studentA}`, {
        method: "PATCH", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ archived: true }),
      }));
      expect(archiveMember.status).toBe(200);
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
    } finally {
      const hash = (token: string) => createHash("sha256").update(token).digest("hex");
      if (teacherToken) await sql`DELETE FROM classroom.sessions WHERE token_hash = ${hash(teacherToken)}`;
      if (studentToken) await sql`DELETE FROM classroom.student_sessions WHERE token_hash = ${hash(studentToken)}`;
      await sql.begin(async (tx) => {
        await tx`DELETE FROM classroom.files WHERE classroom_id IN (${roomA}, ${roomB})`;
        await tx`DELETE FROM classroom.assignments WHERE classroom_id IN (${roomA}, ${roomB})`;
        await tx`DELETE FROM classroom.students WHERE classroom_id IN (${roomA}, ${roomB})`;
        await tx`DELETE FROM classroom.classrooms WHERE id IN (${roomA}, ${roomB})`;
        if (peerAccountId) await tx`DELETE FROM classroom.student_accounts WHERE id = ${peerAccountId}`;
        await tx`DELETE FROM classroom.student_accounts WHERE id = ${accountId}`;
        await tx`DELETE FROM classroom.teachers WHERE id = ${teacherId}`;
      });
      await sql.end({ timeout: 5 });
      await rm(uploadDir, { recursive: true, force: true });
    }
  });
});
