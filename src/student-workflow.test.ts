import { describe, expect, spyOn, test } from "bun:test";
import { OAuth2Client } from "google-auth-library";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
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
    process.env.GOOGLE_CLIENT_ID = "classroom-test-client";
    process.env.GOOGLE_WORKSPACE_DOMAIN = "banjan.ac.th";
    process.env.UPLOAD_MAX_FILE_BYTES = String(1024 * 1024);
    process.env.UPLOAD_MAX_TOTAL_BYTES = String(5 * 1024 * 1024);
    const uploadDir = "/private/tmp/classroom-student-test-" + randomUUID();
    process.env.UPLOAD_DIR = uploadDir;

    const { sql } = await import("./db/client");
    const { createSession } = await import("./auth/session");
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
        await tx`INSERT INTO classroom.classrooms (id, owner_id, name) VALUES (${roomA}, ${teacherId}, 'Room A'), (${roomB}, ${teacherId}, 'Room B')`;
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

      await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/assignments/${assignmentA}`, {
        method: "PATCH", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ archived: false }),
      }));
      const storageName = randomUUID(); const removedFileId = randomUUID(); const missingFileId = randomUUID(); const missingStorageName = randomUUID();
      await Bun.write(resolve(uploadDir, storageName), "synthetic student model");
      await sql.begin(async (tx) => {
        await tx`INSERT INTO classroom.attendance (classroom_id, student_id, attendance_date, status) VALUES (${roomB}, ${studentC}, '2025-01-15', 'present')`;
        await tx`INSERT INTO classroom.files (id, classroom_id, assignment_id, student_id, uploaded_by, kind, original_name, storage_name, media_type, size_bytes)
          VALUES (${removedFileId}, ${roomB}, ${assignmentB}, ${studentC}, ${teacherId}, 'model', 'student.stl', ${storageName}, 'model/stl', 23)`;
        await tx`INSERT INTO classroom.files (id, classroom_id, assignment_id, student_id, uploaded_by, kind, original_name, storage_name, media_type, size_bytes)
          VALUES (${missingFileId}, ${roomB}, ${assignmentB}, ${studentC}, ${teacherId}, 'model', 'missing.stl', ${missingStorageName}, 'model/stl', 1)`;
      });
      const blockedTombstone = resolve(uploadDir, storageName + ".deleting");
      await mkdir(blockedTombstone);
      await Bun.write(resolve(blockedTombstone, "keep"), "block the staged rename");
      const storageFailure = await app.handle(new Request(`http://localhost/api/classrooms/${roomB}/students/${studentC}`, { method: "DELETE", headers: teacherHeaders }));
      expect(storageFailure.status).toBe(500);
      expect(await sql`SELECT id FROM classroom.students WHERE id = ${studentC}`).toHaveLength(1);
      expect(await sql`SELECT student_id FROM classroom.attendance WHERE student_id = ${studentC}`).toHaveLength(1);
      expect(await sql`SELECT id FROM classroom.files WHERE id = ${removedFileId}`).toHaveLength(1);
      expect(await Bun.file(resolve(uploadDir, storageName)).exists()).toBe(true);
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
      expect(await Bun.file(resolve(uploadDir, storageName + ".deleting")).exists()).toBe(false);
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
        await tx`DELETE FROM classroom.files WHERE classroom_id IN (${roomA}, ${roomB})`;
        await tx`DELETE FROM classroom.assignments WHERE classroom_id IN (${roomA}, ${roomB})`;
        await tx`DELETE FROM classroom.students WHERE classroom_id IN (${roomA}, ${roomB})`;
        await tx`DELETE FROM classroom.classrooms WHERE id IN (${roomA}, ${roomB})`;
        if (peerAccountId) await tx`DELETE FROM classroom.student_accounts WHERE id = ${peerAccountId}`;
        await tx`DELETE FROM classroom.student_accounts WHERE id = ${accountId}`;
        await tx`DELETE FROM classroom.teachers WHERE id = ${otherTeacherId}`;
        await tx`DELETE FROM classroom.teachers WHERE id = ${teacherId}`;
      });
      await sql.end({ timeout: 5 });
      await rm(uploadDir, { recursive: true, force: true });
      verification.mockRestore();
    }
  });
});
