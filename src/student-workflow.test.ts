import { describe, expect, spyOn, test } from "bun:test";
import { OAuth2Client } from "google-auth-library";
import { createHash, randomUUID } from "node:crypto";
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
    let teacherToken = ""; let studentToken = "";
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
        body: JSON.stringify({ displayName: "Roster Email Test", studentCode: "TEMP" }),
      }));
      const addedStudentData = await addedStudent.json() as { id: string; email: string | null };
      expect(addedStudentData.email).toBeNull();
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
          { studentCode: "001", displayName: "Changed Name", email: "changed@example.test" },
          { studentCode: "0002", displayName: "นักเรียนใหม่", email: "new@example.test" },
          { studentCode: "0003", displayName: "เลขศูนย์นำหน้า" },
        ] }),
      }));
      expect(await importResult.json()).toEqual({ added: 2, skipped: 1 });
      const roomRoster = await app.handle(new Request("http://localhost/api/classrooms/" + roomB + "/students", { headers: teacherHeaders }));
      const rosterRows = await roomRoster.json() as { id: string; studentCode: string; displayName: string; email: string | null }[];
      expect(rosterRows.find((row) => row.id === studentC)).toMatchObject({
        id: studentC, studentCode: "001", displayName: "Student One", email: accountEmail,
      });
      expect(rosterRows.find((row) => row.studentCode === "0002")?.email).toBe("new@example.test");
      expect(rosterRows.find((row) => row.studentCode === "0003")?.email).toBe("0003@banjan.ac.th");
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
      verification.mockRestore();
    }
  });
});
