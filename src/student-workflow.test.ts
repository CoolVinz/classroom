import { syntheticGLB } from "./test-fixtures/gltf";
import { describe, expect, spyOn, test } from "bun:test";
import { OAuth2Client } from "google-auth-library";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, utimes } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { Elysia } from "elysia";
import sharp from "sharp";

const databaseUrl = process.env.CLASSROOM_TEST_DATABASE_URL;
type GalleryVoteSummaryTest = { limit: number; blockTotals: { studentId: string; votes: number }[]; usage: { assignmentId: string; used: number }[]; myVotes: { fileId: string; hidden: boolean }[] };

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
    const { createSession, createStudentSession } = await import("./auth/session");
    const { galleryRoutes } = await import("./routes/gallery");
    const [{ authRoutes }, { studentAuthRoutes }, { classroomRoutes }, { courseworkRoutes }, { studentCourseworkRoutes }, { attendanceScheduleRoutes }, { studentAttendanceRoutes }, { lessonPageApiRoutes }, { quizRoutes, studentQuizRoutes }, { gradebookRoutes }, { handleAppError }] = await Promise.all([
      import("./routes/auth"), import("./routes/student-auth"), import("./routes/classrooms"),
      import("./routes/coursework"), import("./routes/student-coursework"), import("./routes/attendance-schedule"), import("./routes/student-attendance"),
      import("./routes/lesson-pages"),
      import("./routes/quizzes"),
      import("./routes/gradebook"),
      import("./error-handler"),
    ]);
    const { ensureUploadRoot, cleanupUnusedLessonImages } = await import("./file-storage");
    const app = new Elysia().onError(handleAppError).use(authRoutes).use(studentAuthRoutes).use(classroomRoutes).use(attendanceScheduleRoutes).use(courseworkRoutes).use(studentCourseworkRoutes).use(studentAttendanceRoutes).use(quizRoutes).use(studentQuizRoutes).use(gradebookRoutes).use(lessonPageApiRoutes).use(galleryRoutes);
    const teacherId = randomUUID(); const accountId = randomUUID();
    const roomA = randomUUID(); const roomB = randomUUID(); const emptyRoom = randomUUID();
    const studentA = randomUUID(); const studentB = randomUUID(); const studentC = randomUUID(); const studentD = randomUUID();
    const assignmentA = randomUUID(); const assignmentB = randomUUID();
    const teacherFile = randomUUID(); const peerFile = randomUUID();
    let teacherToken = ""; let studentToken = ""; let otherTeacherToken = "";
    const lessonPageIds: string[] = [];
    const quizIds: string[] = [];
    const quizImageIds: string[] = [];
    const otherTeacherId = randomUUID();
    let deleteTriggerName = ""; let deleteFunctionName = ""; let deleteTriggerInstalled = false;
    let workingTriggerName = ""; let workingFunctionName = ""; let workingTriggerInstalled = false;
    let trashTriggerName = ""; let trashFunctionName = ""; let trashTriggerInstalled = false;
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
    async function googleLogin(value: string, cookie = "csrf-token", submitted = cookie, state = "/") {
      const body = new URLSearchParams({ credential: value, g_csrf_token: submitted, state });
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
        await tx`INSERT INTO classroom.assignment_assessments
          (assignment_id, classroom_id, student_id, published_score, published_max_score, published_feedback,
            published_reviewed_file_ids, published_revision, published_at)
          VALUES (${assignmentB}, ${roomB}, ${studentC}, 7.5, 10, '', '{}', 1, NOW())`;
        await tx`INSERT INTO classroom.files (id, classroom_id, assignment_id, uploaded_by, kind, original_name, storage_name, media_type, size_bytes)
          VALUES (${teacherFile}, ${roomA}, ${assignmentA}, ${teacherId}, 'worksheet', 'task.pdf', ${randomUUID()}, 'application/pdf', 8)`;
        await tx`INSERT INTO classroom.files (id, classroom_id, assignment_id, student_id, uploaded_by, kind, original_name, storage_name, media_type, size_bytes)
          VALUES (${peerFile}, ${roomA}, ${assignmentA}, ${studentB}, ${teacherId}, 'model', 'peer.stl', ${randomUUID()}, 'model/stl', 8)`;
      });
      teacherToken = await createSession(teacherId);
      otherTeacherToken = await createSession(otherTeacherId);
      studentToken = await createStudentSession(accountId);
      const defaultAppearance = {
        skinColor: "#f3c8a6", hairColor: "#3e2d27", shirtColor: "#4f9b86", trousersColor: "#435875", hairStyle: "short",
        hatStyle: "none", glassesStyle: "none", shoeStyle: "sneakers", hatColor: "#b84d4d", glassesColor: "#302721", shoeColor: "#303a4a",
      };
      const teacherAppearance = { ...defaultAppearance, shirtColor: "#123456", hairStyle: "long" };
      const studentAppearance = { ...defaultAppearance, skinColor: "#abcdef", hairStyle: "none" };
      const avatarRequest = (session: string, method = "GET", body?: unknown, origin = "http://localhost:3000") => app.handle(new Request("http://localhost/api/gallery/avatar", {
        method, headers: { cookie: `classroom_session=${session}`, origin, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
      }));
      expect((await avatarRequest("")).status).toBe(401);
      expect(await (await avatarRequest(teacherToken)).json()).toEqual(defaultAppearance);
      expect((await avatarRequest(teacherToken, "PUT", teacherAppearance)).status).toBe(200);
      expect(await (await avatarRequest(teacherToken)).json()).toEqual(teacherAppearance);
      expect(await (await avatarRequest(otherTeacherToken)).json()).toEqual(defaultAppearance);
      expect((await avatarRequest(studentToken, "PUT", studentAppearance)).status).toBe(200);
      expect(await (await avatarRequest(studentToken)).json()).toEqual(studentAppearance);
      expect(await (await avatarRequest(teacherToken)).json()).toEqual(teacherAppearance);
      expect((await avatarRequest(teacherToken, "PUT", { ...teacherAppearance, hairStyle: "unsupported" })).status).toBe(422);
      expect((await avatarRequest(teacherToken, "PUT", { ...teacherAppearance, shirtColor: "red" })).status).toBe(422);
      expect((await avatarRequest(teacherToken, "PUT", studentAppearance, "https://attacker.invalid")).status).toBe(403);
      expect(await (await avatarRequest(teacherToken)).json()).toEqual(teacherAppearance);
      await sql`DELETE FROM classroom.student_sessions WHERE account_id=${accountId}`;
      studentToken = "";
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
      const returnQuizId = randomUUID();
      const signedIn = await googleLogin(studentIdentityToken, "csrf-token", "csrf-token", `/quizzes/${returnQuizId}`);
      expect(signedIn.status).toBe(303);
      expect(new URL(signedIn.headers.get("location")!).pathname).toBe(`/quizzes/${returnQuizId}`);
      studentToken = signedIn.headers.get("set-cookie")!.split(";")[0].split("=")[1];
      let studentHeaders = { cookie: signedIn.headers.get("set-cookie")!.split(";")[0], origin: "http://localhost:3000" };
      const teacherHeaders = { cookie: `classroom_session=${teacherToken}`, origin: "http://localhost:3000" };

      const initialGradebook = await app.handle(new Request(`http://localhost/api/classrooms/${roomB}/gradebook`, { headers: teacherHeaders }));
      expect(initialGradebook.status).toBe(200);
      expect(await initialGradebook.json()).toMatchObject({ scores: [{ studentId: studentC, itemId: assignmentB, score: 7.5, maxScore: 10 }] });
      await sql`DELETE FROM classroom.assignment_assessments WHERE assignment_id = ${assignmentB} AND student_id = ${studentC}`;
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomB}/gradebook`, { headers: { cookie: `classroom_session=${otherTeacherToken}` } }))).status).toBe(404);
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomB}/gradebook`, { headers: studentHeaders }))).status).toBe(401);
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/gradebook/columns`, { method: "POST", headers: { ...teacherHeaders, origin: "https://attacker.invalid", "content-type": "application/json" }, body: JSON.stringify({ name: "Manual", maxScore: 10 }) }))).status).toBe(403);
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/gradebook/columns`, { method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ name: "   ", maxScore: 10 }) }))).status).toBe(422);
      const manualColumnResponse = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/gradebook/columns`, { method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ name: "Manual quiz", maxScore: 10 }) }));
      expect(manualColumnResponse.status).toBe(200);
      const manualColumn = await manualColumnResponse.json() as { id: string; revision: number };
      const saveManual = (revision: number, marks: { studentId: string; score: number | null }[]) => app.handle(new Request(`http://localhost/api/classrooms/${roomA}/gradebook/columns/${manualColumn.id}`, {
        method: "PUT", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ revision, marks }),
      }));
      expect((await saveManual(0, [{ studentId: studentA, score: 0 }, { studentId: studentB, score: 4 }])).status).toBe(200);
      expect((await saveManual(0, [{ studentId: studentA, score: 9 }, { studentId: studentB, score: 4 }])).status).toBe(409);
      expect((await saveManual(1, [{ studentId: studentA, score: 11 }, { studentId: studentB, score: 4 }])).status).toBe(422);
      expect((await saveManual(1, [{ studentId: studentA, score: 0 }, { studentId: studentC, score: 4 }])).status).toBe(422);
      expect((await saveManual(1, [{ studentId: studentA, score: null }, { studentId: studentB, score: 4 }])).status).toBe(200);
      expect(await sql`SELECT student_id FROM classroom.gradebook_marks WHERE column_id = ${manualColumn.id} AND student_id = ${studentA}`).toHaveLength(0);
      const savedManualScore = await sql<{ score: string | number }[]>`SELECT score FROM classroom.gradebook_marks WHERE column_id = ${manualColumn.id} AND student_id = ${studentB}`;
      expect(Number(savedManualScore[0]?.score)).toBe(4);
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/gradebook/columns/${manualColumn.id}/archive`, { method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ revision: 2 }) }))).status).toBe(200);
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/gradebook`, { headers: teacherHeaders })).then((response) => response.json()) as { items: { id: string; archived: boolean }[] }).items.find((item) => item.id === manualColumn.id)).toMatchObject({ archived: true });
      expect(await sql`SELECT student_id FROM classroom.gradebook_marks WHERE column_id = ${manualColumn.id} AND student_id = ${studentB}`).toHaveLength(1);
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/gradebook/columns/${manualColumn.id}/restore`, { method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ revision: 3 }) }))).status).toBe(200);

      const aiImport = await app.handle(new Request("http://localhost/api/quizzes/import", { method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" },
        body: JSON.stringify({ json: JSON.stringify({ format: "classroom-quiz", version: 1, title: "AI draft", description: "คำชี้แจง", questions: [
          { type: "multiple-choice", prompt: "คำถาม", points: 2, choices: ["หนึ่ง", "สอง"], correctAnswer: 2, explanation: "คำตอบ" },
        ] }) }) }));
      expect(aiImport.status).toBe(200);
      const aiDraft = await aiImport.json() as { id: string; title: string; publishedAt: string | null; content: { questions: { id: string; choices: { id: string }[]; correctChoiceId: string }[] } };
      quizIds.push(aiDraft.id);
      expect(aiDraft).toMatchObject({ title: "AI draft", publishedAt: null });
      expect(aiDraft.content.questions[0].correctChoiceId).toBe(aiDraft.content.questions[0].choices[1].id);
      expect((await app.handle(new Request(`http://localhost/api/quizzes/${aiDraft.id}`, { headers: { cookie: `classroom_session=${teacherToken}` } }))).status).toBe(200);
      expect((await app.handle(new Request("http://localhost/api/quizzes/import", { method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ json: "{}" }) }))).status).toBe(422);
      expect((await app.handle(new Request("http://localhost/api/quizzes/import", { method: "POST", headers: { ...studentHeaders, "content-type": "application/json" }, body: JSON.stringify({ json: "{}" }) }))).status).toBe(401);

      const quizId = randomUUID(); const questionId = randomUUID(); const correctChoiceId = randomUUID(); const wrongChoiceId = randomUUID();
      const quizTitle = "Quiz snapshot";
      const createdQuiz = await app.handle(new Request("http://localhost/api/quizzes", { method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ title: quizTitle }) }));
      expect(createdQuiz.status).toBe(200);
      const createdQuizBody = await createdQuiz.json() as { id: string; revision: number };
      quizIds.push(createdQuizBody.id);
      const quizImageBytes = await sharp({ create: { width: 4, height: 4, channels: 4, background: "#49a889" } }).png().toBuffer();
      const quizImageForm = new FormData(); quizImageForm.set("file", new File([quizImageBytes], "quiz-picture.png", { type: "image/png" }));
      const quizImageResponse = await app.handle(new Request(`http://localhost/api/quizzes/${createdQuizBody.id}/images`, { method: "POST", headers: teacherHeaders, body: quizImageForm }));
      expect(quizImageResponse.status).toBe(200);
      const quizImage = await quizImageResponse.json() as { id: string };
      quizImageIds.push(quizImage.id);
      const quizContent = { description: "Synthetic quiz", questions: [{ id: questionId, type: "multiple-choice", prompt: "Which answer?", imageId: quizImage.id, points: 1,
        choices: [{ id: correctChoiceId, text: "Correct", imageId: quizImage.id }, { id: wrongChoiceId, text: "Wrong", imageId: null }], correctChoiceId, explanation: "private solution" }] };
      const saveQuizDraft = (title: string, content: typeof quizContent, expectedRevision: number) => app.handle(new Request(`http://localhost/api/quizzes/${createdQuizBody.id}/publish`, {
        method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ title, content, expectedRevision }),
      }));
      const publishedQuiz = await saveQuizDraft(quizTitle, quizContent, createdQuizBody.revision);
      expect(publishedQuiz.status).toBe(200);
      const makeRound = (classroomId: string) => app.handle(new Request(`http://localhost/api/classrooms/${classroomId}/quizzes`, {
        method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ quizId: createdQuizBody.id, durationMinutes: null }),
      }));
      const firstRoundResponse = await makeRound(roomA); const secondRoundResponse = await makeRound(roomB);
      expect(firstRoundResponse.status).toBe(200); expect(secondRoundResponse.status).toBe(200);
      const firstRound = await firstRoundResponse.json() as { id: string; title: string };
      const secondRound = await secondRoundResponse.json() as { id: string; title: string };
      const lessonResponse = await app.handle(new Request("http://localhost/api/lesson-pages", {
        method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ title: "Quiz link lesson", editorMode: "blocks" }),
      }));
      expect(lessonResponse.status).toBe(200);
      const quizLesson = await lessonResponse.json() as { id: string; revision: number; blocks: unknown[] };
      lessonPageIds.push(quizLesson.id);
      const draftLessonBody = { title: "Quiz link lesson", blocks: [], quizLinks: [{ quizId: createdQuizBody.id, label: "Start quiz" }], expectedRevision: quizLesson.revision };
      const savedLessonDraft = await app.handle(new Request(`http://localhost/api/lesson-pages/${quizLesson.id}/draft`, {
        method: "PUT", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify(draftLessonBody),
      }));
      expect(savedLessonDraft.status).toBe(200);
      expect((await app.handle(new Request(`http://localhost/api/public/lesson-pages/${quizLesson.id}`))).status).toBe(404);
      const publishedLesson = await app.handle(new Request(`http://localhost/api/lesson-pages/${quizLesson.id}/publish`, {
        method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ ...draftLessonBody, expectedRevision: 1 }),
      }));
      expect(publishedLesson.status).toBe(200);
      expect(await (await app.handle(new Request(`http://localhost/api/public/lesson-pages/${quizLesson.id}`))).json()).toMatchObject({ quizLinks: [{ quizId: createdQuizBody.id, label: "Start quiz" }] });
      const changedContent = { ...quizContent, questions: [{ ...quizContent.questions[0], prompt: "Changed library prompt", points: 8 }] };
      const savedDraft = await app.handle(new Request(`http://localhost/api/quizzes/${createdQuizBody.id}/draft`, {
        method: "PUT", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ title: "Changed library title", content: changedContent, expectedRevision: 1 }),
      }));
      expect(savedDraft.status).toBe(200);
      expect((await saveQuizDraft("Changed library title", changedContent, 2)).status).toBe(200);
      expect((await app.handle(new Request(`http://localhost/api/quizzes/${createdQuizBody.id}`, { headers: { cookie: `classroom_session=${otherTeacherToken}` } }))).status).toBe(404);
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/quizzes/${firstRound.id}/results`, { headers: { cookie: `classroom_session=${otherTeacherToken}` } }))).status).toBe(404);
      const studentRoundsResponse = await app.handle(new Request(`http://localhost/api/student/quizzes/${createdQuizBody.id}`, { headers: studentHeaders }));
      expect(studentRoundsResponse.status).toBe(200);
      const eligibleRounds = await studentRoundsResponse.json() as { roundId: string }[];
      expect(eligibleRounds.map((round) => round.roundId)).toEqual(expect.arrayContaining([firstRound.id, secondRound.id]));
      expect((await app.handle(new Request(`http://localhost/api/student/quiz-rounds/${firstRound.id}/start`, { method: "POST", headers: studentHeaders }))).status).toBe(409);
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/quizzes/${firstRound.id}/open`, { method: "POST", headers: teacherHeaders }))).status).toBe(200);
      const startedQuiz = await app.handle(new Request(`http://localhost/api/student/quiz-rounds/${firstRound.id}/start`, { method: "POST", headers: studentHeaders }));
      expect(startedQuiz.status).toBe(200);
      const started = await startedQuiz.json() as { id: string; revision: number; questions: unknown[]; title: string; description: string };
      expect(started.title).toBe(quizTitle); expect(started.description).toBe("Synthetic quiz");
      expect(JSON.stringify(started)).not.toContain("correctChoiceId");
      expect(JSON.stringify(started)).not.toContain("private solution");
      const studentQuizImage = await app.handle(new Request(`http://localhost/api/student/quiz-attempts/${started.id}/images/${quizImage.id}`, { headers: studentHeaders }));
      expect(studentQuizImage.status).toBe(200);
      expect(studentQuizImage.headers.get("content-type")).toBe("image/webp");
      const answerBody = { expectedRevision: 0, answers: { [questionId]: correctChoiceId } };
      const savedAnswer = await app.handle(new Request(`http://localhost/api/student/quiz-attempts/${started.id}/answers`, {
        method: "PUT", headers: { ...studentHeaders, "content-type": "application/json" }, body: JSON.stringify(answerBody),
      }));
      expect(savedAnswer.status).toBe(200);
      expect((await savedAnswer.json()).revision).toBe(1);
      expect((await app.handle(new Request(`http://localhost/api/student/quiz-attempts/${started.id}/answers`, {
        method: "PUT", headers: { ...studentHeaders, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 0, answers: { [questionId]: wrongChoiceId } }),
      }))).status).toBe(409);
      const submittedResponse = await app.handle(new Request(`http://localhost/api/student/quiz-attempts/${started.id}/submit`, {
        method: "POST", headers: { ...studentHeaders, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 1, answers: { [questionId]: correctChoiceId } }),
      }));
      expect(submittedResponse.status).toBe(200);
      const submitted = await submittedResponse.json() as { score: string; questions: unknown[]; solutionsReleased: boolean };
      expect(Number(submitted.score)).toBe(1); expect(submitted.solutionsReleased).toBe(false);
      expect(JSON.stringify(submitted)).not.toContain("correctChoiceId");
      const quizGradebook = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/gradebook`, { headers: teacherHeaders }));
      expect(await quizGradebook.json()).toMatchObject({ scores: expect.arrayContaining([{ studentId: studentA, itemId: firstRound.id, score: 1, maxScore: 1 }]) });
      expect((await app.handle(new Request(`http://localhost/api/student/quiz-attempts/${started.id}/submit`, {
        method: "POST", headers: { ...studentHeaders, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 1, answers: { [questionId]: wrongChoiceId } }),
      })).then((response) => response.json()) as { score: string }).score).toBe(submitted.score);
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/quizzes/${firstRound.id}/close`, { method: "POST", headers: teacherHeaders }))).status).toBe(200);
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/quizzes/${firstRound.id}/release-solutions`, { method: "POST", headers: teacherHeaders }))).status).toBe(200);
      const released = await app.handle(new Request(`http://localhost/api/student/quiz-attempts/${started.id}`, { headers: studentHeaders }));
      expect(await released.json()).toMatchObject({ solutionsReleased: true, questions: [{ correctChoiceId, explanation: "private solution", isCorrect: true, awardedPoints: 1 }] });
      const results = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/quizzes/${firstRound.id}/results`, { headers: teacherHeaders }));
      expect(results.status).toBe(200);
      expect(await results.json()).toMatchObject({ round: { title: quizTitle, content: { questions: [{ prompt: "Which answer?" }] } } });
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomB}/quizzes/${secondRound.id}/open`, { method: "POST", headers: teacherHeaders }))).status).toBe(200);
      const secondStartedResponse = await app.handle(new Request(`http://localhost/api/student/quiz-rounds/${secondRound.id}/start`, { method: "POST", headers: studentHeaders }));
      expect(secondStartedResponse.status).toBe(200);
      const secondStarted = await secondStartedResponse.json() as { id: string; revision: number };
      expect((await app.handle(new Request(`http://localhost/api/student/quiz-attempts/${secondStarted.id}/answers`, {
        method: "PUT", headers: { ...studentHeaders, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 0, answers: { [questionId]: correctChoiceId } }),
      }))).status).toBe(200);

      const [quizBeforeTrash] = await sql<{ revision: number }[]>`SELECT draft_revision AS revision FROM classroom.quizzes WHERE id = ${createdQuizBody.id}`;
      expect((await app.handle(new Request(`http://localhost/api/quizzes/${createdQuizBody.id}/trash`, {
        method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: quizBeforeTrash.revision }),
      }))).status).toBe(200);
      const trashRevision = quizBeforeTrash.revision + 1;
      expect((await app.handle(new Request(`http://localhost/api/quizzes/${createdQuizBody.id}`, { headers: teacherHeaders }))).status).toBe(404);
      const hiddenRounds = await app.handle(new Request(`http://localhost/api/student/quizzes/${createdQuizBody.id}`, { headers: studentHeaders }));
      expect(await hiddenRounds.json()).toEqual([]);
      expect((await app.handle(new Request(`http://localhost/api/student/quiz-attempts/${started.id}`, { headers: studentHeaders }))).status).toBe(404);
      expect((await app.handle(new Request(`http://localhost/api/student/quiz-attempts/${secondStarted.id}`, { headers: studentHeaders }))).status).toBe(404);
      expect((await app.handle(new Request(`http://localhost/api/student/quiz-attempts/${secondStarted.id}/images/${quizImage.id}`, { headers: studentHeaders }))).status).toBe(404);
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/quizzes/${firstRound.id}/results`, { headers: teacherHeaders }))).status).toBe(404);
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/quizzes`, { headers: teacherHeaders })).then((response) => response.json()) as { quizId: string }[]).some((round) => round.quizId === createdQuizBody.id)).toBe(false);
      expect(await sql`SELECT id FROM classroom.quiz_attempts WHERE id = ${secondStarted.id} AND score = 1 AND finish_reason = 'closed'`).toHaveLength(1);
      expect((await app.handle(new Request("http://localhost/api/quizzes?trashed=true", { headers: teacherHeaders })).then((response) => response.json()) as { id: string; roundCount: number; attemptCount: number }[]).find((item) => item.id === createdQuizBody.id)).toMatchObject({ roundCount: 2, attemptCount: 2 });
      expect((await app.handle(new Request(`http://localhost/api/public/lesson-pages/${quizLesson.id}`)).then((response) => response.json())).quizLinks).toEqual([]);
      expect((await app.handle(new Request(`http://localhost/api/quizzes/${createdQuizBody.id}/restore`, {
        method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: trashRevision - 1 }),
      }))).status).toBe(409);
      expect((await app.handle(new Request(`http://localhost/api/quizzes/${createdQuizBody.id}/restore`, {
        method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: trashRevision }),
      }))).status).toBe(200);
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/quizzes`, { headers: teacherHeaders })).then((response) => response.json()) as { id: string; status: string }[]).filter((round) => [firstRound.id, secondRound.id].includes(round.id)).every((round) => round.status === "closed")).toBe(true);
      expect(await (await app.handle(new Request(`http://localhost/api/public/lesson-pages/${quizLesson.id}`))).json()).toMatchObject({ quizLinks: [{ quizId: createdQuizBody.id, label: "Start quiz" }] });
      expect((await app.handle(new Request(`http://localhost/api/quizzes/${createdQuizBody.id}`, { method: "DELETE", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: trashRevision + 1, confirmTitle: "wrong title" }) }))).status).toBe(404);

      const linkedLessonResponse = await app.handle(new Request("http://localhost/api/lesson-pages", { method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ title: "Lesson deletion preserves quiz" }) }));
      const linkedLesson = await linkedLessonResponse.json() as { id: string; revision: number };
      lessonPageIds.push(linkedLesson.id);
      const linkedBody = { title: "Lesson deletion preserves quiz", blocks: [], quizLinks: [{ quizId: createdQuizBody.id, label: "Open" }], expectedRevision: linkedLesson.revision };
      expect((await app.handle(new Request(`http://localhost/api/lesson-pages/${linkedLesson.id}/draft`, { method: "PUT", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify(linkedBody) }))).status).toBe(200);
      expect((await app.handle(new Request(`http://localhost/api/lesson-pages/${linkedLesson.id}/publish`, { method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ ...linkedBody, expectedRevision: 1 }) }))).status).toBe(200);
      expect((await app.handle(new Request(`http://localhost/api/lesson-pages/${linkedLesson.id}/trash`, { method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 2 }) }))).status).toBe(200);
      const deleteLessonResponse = await app.handle(new Request(`http://localhost/api/lesson-pages/${linkedLesson.id}`, { method: "DELETE", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 3, confirmTitle: linkedBody.title }) }));
      expect(deleteLessonResponse.status).toBe(200);
      const deletedLessonRead = await app.handle(new Request(`http://localhost/api/lesson-pages/${linkedLesson.id}`, { headers: teacherHeaders }));
      expect(deletedLessonRead.status).toBe(404);
      const retainedQuizRead = await app.handle(new Request(`http://localhost/api/quizzes/${createdQuizBody.id}`, { headers: teacherHeaders }));
      expect(retainedQuizRead.status).toBe(200);

      expect((await app.handle(new Request(`http://localhost/api/quizzes/${createdQuizBody.id}/trash`, {
        method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: trashRevision + 1 }),
      }))).status).toBe(200);
      const finalTrashRevision = trashRevision + 2;
      const wrongPermanentDelete = await app.handle(new Request(`http://localhost/api/quizzes/${createdQuizBody.id}`, { method: "DELETE", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: finalTrashRevision, confirmTitle: "wrong title" }) }));
      expect(wrongPermanentDelete.status).toBe(422);
      expect(await Bun.file(resolve(uploadDir, quizImage.id)).exists()).toBe(true);
      const triggerTag = randomUUID().replaceAll("-", "");
      trashTriggerName = "quiz_delete_fail_" + triggerTag; trashFunctionName = trashTriggerName + "_fn";
      await sql.unsafe(`CREATE FUNCTION classroom.${trashFunctionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced quiz delete failure'; END $$`).simple();
      await sql.unsafe(`CREATE TRIGGER ${trashTriggerName} BEFORE DELETE ON classroom.quizzes FOR EACH ROW EXECUTE FUNCTION classroom.${trashFunctionName}()`).simple();
      trashTriggerInstalled = true;
      const rolledBackQuizDelete = await app.handle(new Request(`http://localhost/api/quizzes/${createdQuizBody.id}`, { method: "DELETE", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: finalTrashRevision, confirmTitle: "Changed library title" }) }));
      expect(rolledBackQuizDelete.status).toBe(500);
      expect(await Bun.file(resolve(uploadDir, quizImage.id)).exists()).toBe(true);
      expect(await Bun.file(resolve(uploadDir, quizImage.id + ".deleting")).exists()).toBe(false);
      await sql.unsafe(`DROP TRIGGER ${trashTriggerName} ON classroom.quizzes`).simple();
      await sql.unsafe(`DROP FUNCTION classroom.${trashFunctionName}()`).simple();
      trashTriggerInstalled = false;
      const permanentDelete = await app.handle(new Request(`http://localhost/api/quizzes/${createdQuizBody.id}`, { method: "DELETE", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: finalTrashRevision, confirmTitle: "Changed library title" }) }));
      expect(permanentDelete.status).toBe(200);
      expect(await permanentDelete.json()).toEqual({ ok: true, cleanupPending: false });
      expect(await Bun.file(resolve(uploadDir, quizImage.id)).exists()).toBe(false);
      expect(await sql`SELECT id FROM classroom.quiz_attempts WHERE classroom_quiz_id IN (${firstRound.id}, ${secondRound.id})`).toHaveLength(0);
      expect(await sql`SELECT id FROM classroom.classroom_quizzes WHERE id IN (${firstRound.id}, ${secondRound.id})`).toHaveLength(0);
      expect(await sql`SELECT id FROM classroom.quiz_images WHERE id = ${quizImage.id}`).toHaveLength(0);
      expect(await (await (await app.handle(new Request(`http://localhost/api/lesson-pages/${quizLesson.id}`, { headers: teacherHeaders }))).json()).quizLinks).toEqual([]);

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

      const lessonCreate = await app.handle(new Request("http://localhost/api/lesson-pages", { method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ title: "Synthetic lesson" }) }));
      expect(lessonCreate.status).toBe(200);
      const lesson = await lessonCreate.json() as { id: string; revision: number };
      lessonPageIds.push(lesson.id);
      expect((await (await app.handle(new Request("http://localhost/api/lesson-pages", { headers: { cookie: `classroom_session=${otherTeacherToken}` } }))).json() as { id: string }[]).some((item) => item.id === lesson.id)).toBe(false);
      const png = await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 35, g: 120, b: 95 } } }).png().toBuffer();
      const invalidImageForm = new FormData(); invalidImageForm.set("file", new File(["not an image"], "fake.png", { type: "image/png" }));
      expect((await app.handle(new Request(`http://localhost/api/lesson-pages/${lesson.id}/images`, { method: "POST", headers: teacherHeaders, body: invalidImageForm }))).status).toBe(422);
      const failureTag = randomUUID().replaceAll("-", ""); const failureTrigger = "lesson_image_fail_" + failureTag; const failureFunction = failureTrigger + "_fn";
      await sql.unsafe(`CREATE FUNCTION classroom.${failureFunction}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced lesson image registration failure'; END $$`).simple();
      await sql.unsafe(`CREATE TRIGGER ${failureTrigger} BEFORE INSERT ON classroom.lesson_page_images FOR EACH ROW EXECUTE FUNCTION classroom.${failureFunction}()`).simple();
      const beforeFailedUpload = new Set(await readdir(uploadDir));
      const failingImageForm = new FormData(); failingImageForm.set("file", new File([png], "retry.png", { type: "image/png" }));
      expect((await app.handle(new Request(`http://localhost/api/lesson-pages/${lesson.id}/images`, { method: "POST", headers: teacherHeaders, body: failingImageForm }))).status).toBe(500);
      expect(await readdir(uploadDir)).toEqual([...beforeFailedUpload]);
      await sql.unsafe(`DROP TRIGGER ${failureTrigger} ON classroom.lesson_page_images`).simple();
      await sql.unsafe(`DROP FUNCTION classroom.${failureFunction}()`).simple();
      const imageForm = new FormData(); imageForm.set("file", new File([png], "lesson.png", { type: "image/png" }));
      const imageUpload = await app.handle(new Request(`http://localhost/api/lesson-pages/${lesson.id}/images`, { method: "POST", headers: teacherHeaders, body: imageForm }));
      expect(imageUpload.status).toBe(200);
      const image = await imageUpload.json() as { id: string };

      const codeCreate = await app.handle(new Request("http://localhost/api/lesson-pages", {
        method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ title: "Draft code title", editorMode: "code" }),
      }));
      expect(codeCreate.status).toBe(200);
      const codeLesson = await codeCreate.json() as { id: string; revision: number; editorMode: string; blocks: { type: string }[] };
      lessonPageIds.push(codeLesson.id);
      expect(codeLesson).toMatchObject({ editorMode: "code", blocks: [{ type: "code", framework: "none" }] });
      expect((await app.handle(new Request(`http://localhost/api/lesson-pages/${codeLesson.id}/images`, { headers: { cookie: `classroom_session=${otherTeacherToken}` } }))).status).toBe(404);
      const codeImageForm = new FormData(); codeImageForm.set("file", new File([png], "code-image.png", { type: "image/png" }));
      const codeImageResponse = await app.handle(new Request(`http://localhost/api/lesson-pages/${codeLesson.id}/images`, { method: "POST", headers: teacherHeaders, body: codeImageForm }));
      expect(codeImageResponse.status).toBe(200);
      const codeImage = await codeImageResponse.json() as { id: string; originalName: string };
      expect((await app.handle(new Request(`http://localhost/api/lesson-pages/${codeLesson.id}/images`, { headers: teacherHeaders })).then((response) => response.json()) as { id: string }[]).map((item) => item.id)).toContain(codeImage.id);
      const codePath = `/api/lesson-pages/${codeLesson.id}`;
      const codeSource = (html: string, imageId?: string) => ({ type: "code", html, css: "body { color: #234; }", javascript: "window.lessonReady = true;", ...(imageId ? { imageIds: [imageId] } : {}) });
      const saveCode = (expectedRevision: number, title: string, code: Record<string, unknown>) => app.handle(new Request(`http://localhost${codePath}/draft`, {
        method: "PUT", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ title, blocks: [code], expectedRevision }),
      }));
      expect((await saveCode(0, "Bad source", codeSource("<img src='lesson-image://not-a-uuid'>"))).status).toBe(422);
      expect((await saveCode(0, "Malformed UUID", codeSource("<img src='lesson-image://00000000-0000-0000-0000-000000000000'>"))).status).toBe(422);
      expect((await saveCode(0, "Foreign image", codeSource("<img src='lesson-image://" + image.id + "'>"))).status).toBe(422);
      expect((await saveCode(0, "Oversize", { ...codeSource(""), javascript: "x".repeat(1048576) })).status).toBe(413);
      expect((await saveCode(0, "Oversize UTF-8", { ...codeSource(""), javascript: "ก".repeat(349526) })).status).toBe(413);
      expect((await saveCode(0, "Mixed blocks", { type: "text", text: "not code" })).status).toBe(422);
      expect((await saveCode(0, "Unsupported framework", { ...codeSource(""), framework: "tailwind" })).status).toBe(422);
      const validCode = { ...codeSource(`<!doctype html><html><body><h1>Published source</h1><img src="lesson-image://${codeImage.id}"></body></html>`, codeImage.id), framework: "bootstrap" };
      const codeDraft = await saveCode(0, "Public code title", validCode);
      expect(codeDraft.status).toBe(200);
      expect(await codeDraft.json()).toMatchObject({ blocks: [{ imageIds: [codeImage.id], framework: "bootstrap" }] });
      expect(await (await app.handle(new Request(`http://localhost${codePath}`, { headers: teacherHeaders }))).json()).toMatchObject({ blocks: [{ framework: "bootstrap" }] });
      expect((await app.handle(new Request(`http://localhost/api/public/lesson-pages/${codeLesson.id}`))).status).toBe(404);
      const codePublish = await app.handle(new Request(`http://localhost${codePath}/publish`, {
        method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ title: "Public code title", blocks: [validCode], expectedRevision: 1 }),
      }));
      expect(codePublish.status).toBe(200);
      const publicCode = await app.handle(new Request(`http://localhost/api/public/lesson-pages/${codeLesson.id}`));
      expect(publicCode.status).toBe(200);
      expect(await publicCode.json()).toMatchObject({ title: "Public code title", editorMode: "code", blocks: [{ html: expect.stringContaining("Published source"), imageIds: [codeImage.id], framework: "bootstrap" }] });
      expect((await app.handle(new Request(`http://localhost/api/public/lesson-pages/${codeLesson.id}/images/${codeImage.id}/content`))).status).toBe(200);
      const nextCode = codeSource("<!doctype html><body>Draft only</body>");
      expect((await saveCode(2, "Private draft title", nextCode)).status).toBe(200);
      expect(await (await app.handle(new Request(`http://localhost${codePath}`, { headers: teacherHeaders }))).json()).toMatchObject({ blocks: [{ framework: "none" }] });
      expect(await (await app.handle(new Request(`http://localhost/api/public/lesson-pages/${codeLesson.id}`))).json()).toMatchObject({ title: "Public code title", blocks: [{ html: expect.stringContaining("Published source") }] });
      await sql`UPDATE classroom.lesson_page_images SET created_at = NOW() - INTERVAL '48 hours' WHERE id = ${codeImage.id}`;
      await cleanupUnusedLessonImages();
      expect(await sql`SELECT id FROM classroom.lesson_page_images WHERE id = ${codeImage.id}`).toHaveLength(1);
      expect((await app.handle(new Request(`http://localhost${codePath}/trash`, { method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 3 }) }))).status).toBe(200);
      expect((await app.handle(new Request(`http://localhost/api/public/lesson-pages/${codeLesson.id}`))).status).toBe(404);
      expect((await app.handle(new Request(`http://localhost/api/public/lesson-pages/${codeLesson.id}/images/${codeImage.id}/content`))).status).toBe(404);
      await cleanupUnusedLessonImages();
      expect(await sql`SELECT id FROM classroom.lesson_page_images WHERE id = ${codeImage.id}`).toHaveLength(1);
      expect((await app.handle(new Request(`http://localhost/api/lesson-pages/${codeLesson.id}/images/${codeImage.id}/content`, { headers: teacherHeaders }))).status).toBe(404);
      expect((await app.handle(new Request(`http://localhost/api/lesson-pages?trashed=true`, { headers: teacherHeaders })).then((response) => response.json()) as { id: string }[]).some((item) => item.id === codeLesson.id)).toBe(true);
      expect((await app.handle(new Request(`http://localhost/api/lesson-pages/${codeLesson.id}/restore`, { method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 4 }) }))).status).toBe(200);
      expect(await (await app.handle(new Request(`http://localhost/api/public/lesson-pages/${codeLesson.id}`))).json()).toMatchObject({ title: "Public code title" });
      expect((await app.handle(new Request(`http://localhost${codePath}/unpublish`, { method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 5 }) }))).status).toBe(200);
      await cleanupUnusedLessonImages();
      expect(await sql`SELECT id FROM classroom.lesson_page_images WHERE id = ${codeImage.id}`).toHaveLength(0);
      expect((await app.handle(new Request(`http://localhost/api/public/lesson-pages/${codeLesson.id}`))).status).toBe(404);
      expect((await app.handle(new Request(`http://localhost/api/public/lesson-pages/${codeLesson.id}/images/${codeImage.id}/content`))).status).toBe(404);

      const lessonBlocks = [
        { type: "text", heading: "Step one", text: "Synthetic lesson text" },
        { type: "image", imageId: image.id, alt: "Example", caption: "Sample image" },
        { type: "youtube", videoId: "dQw4w9WgXcQ", caption: "Demo" },
      ];
      const saveDraft = (expectedRevision: number, blocks: Record<string, unknown>[] = lessonBlocks) => app.handle(new Request(`http://localhost/api/lesson-pages/${lesson.id}/draft`, { method: "PUT", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ title: "Synthetic lesson", blocks, expectedRevision }) }));
      expect((await saveDraft(0)).status).toBe(200);
      const stagedImage = resolve(uploadDir, image.id + ".deleting");
      await rename(resolve(uploadDir, image.id), stagedImage);
      const imageOldTime = new Date(Date.now() - 48 * 60 * 60 * 1000); await utimes(stagedImage, imageOldTime, imageOldTime);
      await ensureUploadRoot();
      expect(await Bun.file(resolve(uploadDir, image.id)).exists()).toBe(true);
      expect((await app.handle(new Request(`http://localhost/api/public/lesson-pages/${lesson.id}`))).status).toBe(404);
      expect((await app.handle(new Request(`http://localhost/api/lesson-pages/${lesson.id}/images/${image.id}/content`, { headers: { cookie: `classroom_session=${otherTeacherToken}` } }))).status).toBe(404);
      expect((await app.handle(new Request(`http://localhost/api/lesson-pages/${lesson.id}/images/${image.id}/content`, { headers: studentHeaders }))).status).toBe(401);
      const privateImage = await app.handle(new Request(`http://localhost/api/lesson-pages/${lesson.id}/images/${image.id}/content`, { headers: teacherHeaders }));
      expect(privateImage.status).toBe(200);
      expect(privateImage.headers.get("content-type")).toBe("image/webp");
      expect((await sharp(Buffer.from(await privateImage.arrayBuffer())).metadata()).width).toBe(32);
      expect((await saveDraft(1, [{ type: "youtube", videoId: "invalid", caption: "" }])).status).toBe(422);
      const published = await app.handle(new Request(`http://localhost/api/lesson-pages/${lesson.id}/publish`, { method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ title: "Synthetic lesson", blocks: lessonBlocks, expectedRevision: 1 }) }));
      expect(published.status).toBe(200);
      const publicPage = await app.handle(new Request(`http://localhost/api/public/lesson-pages/${lesson.id}`));
      expect(publicPage.status).toBe(200);
      expect((await publicPage.json() as { blocks: { type: string }[] }).blocks.map((item) => item.type)).toEqual(["text", "image", "youtube"]);
      expect((await app.handle(new Request(`http://localhost/api/public/lesson-pages/${lesson.id}/images/${image.id}/content`))).status).toBe(200);
      const edited = await saveDraft(2, [{ type: "text", text: "New draft" }]);
      expect(edited.status).toBe(200);
      expect((await (await app.handle(new Request(`http://localhost/api/public/lesson-pages/${lesson.id}`))).json() as { blocks: { text?: string }[] }).blocks[0].text).toBe("Synthetic lesson text");
      const competingDrafts = await Promise.all([
        saveDraft(3, [{ type: "text", text: "Concurrent A" }]),
        saveDraft(3, [{ type: "text", text: "Concurrent B" }]),
      ]);
      expect(competingDrafts.map((response) => response.status).sort()).toEqual([200, 409]);
      expect((await app.handle(new Request(`http://localhost/api/lesson-pages/${lesson.id}/publish`, { method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ title: "Synthetic lesson", blocks: lessonBlocks, expectedRevision: 2 }) }))).status).toBe(409);
      expect((await app.handle(new Request(`http://localhost/api/lesson-pages/${lesson.id}/publish`, { method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ title: "Synthetic lesson", blocks: [{ type: "text", text: "Published again" }], expectedRevision: 4 }) }))).status).toBe(200);
      expect((await app.handle(new Request(`http://localhost/api/lesson-pages/${lesson.id}/trash`, { method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 5 }) }))).status).toBe(200);
      expect((await app.handle(new Request(`http://localhost/api/public/lesson-pages/${lesson.id}`))).status).toBe(404);
      expect((await app.handle(new Request(`http://localhost/api/lesson-pages/${lesson.id}/images/${image.id}/content`, { headers: teacherHeaders }))).status).toBe(404);
      expect((await app.handle(new Request(`http://localhost/api/lesson-pages/${lesson.id}/restore`, { method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 6 }) }))).status).toBe(200);
      expect(await (await app.handle(new Request(`http://localhost/api/public/lesson-pages/${lesson.id}`))).json()).toMatchObject({ blocks: [{ text: "Published again" }] });
      expect((await app.handle(new Request(`http://localhost/api/lesson-pages/${lesson.id}/unpublish`, { method: "POST", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 7 }) }))).status).toBe(200);
      expect((await app.handle(new Request(`http://localhost/api/public/lesson-pages/${lesson.id}`))).status).toBe(404);
      expect((await app.handle(new Request(`http://localhost/api/public/lesson-pages/${lesson.id}/images/${image.id}/content`))).status).toBe(404);
      const [{ sizeBytes }] = await sql<{ sizeBytes: string }[]>`SELECT size_bytes::text AS "sizeBytes" FROM classroom.lesson_page_images WHERE id = ${image.id}`;
      process.env.UPLOAD_MAX_TOTAL_BYTES = String(Number(sizeBytes) + 9);
      const overSharedQuota = new FormData(); overSharedQuota.set("file", new File(["%PDF-1.7\nquota"], "quota.pdf", { type: "application/pdf" }));
      expect((await app.handle(new Request(`http://localhost/api/student/classrooms/${roomA}/assignments/${assignmentA}/files`, { method: "POST", headers: studentHeaders, body: overSharedQuota }))).status).toBe(413);
      process.env.UPLOAD_MAX_TOTAL_BYTES = String(5 * 1024 * 1024);
      await sql`UPDATE classroom.lesson_page_images SET created_at = NOW() - INTERVAL '48 hours' WHERE id = ${image.id}`;
      await cleanupUnusedLessonImages();
      expect(await sql`SELECT id FROM classroom.lesson_page_images WHERE id = ${image.id}`).toHaveLength(0);
      expect(await Bun.file(resolve(uploadDir, image.id)).exists()).toBe(false);

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
      modelForm.set("file", new File(["v 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl blue\nf 1 2 3"], "model.obj", { type: "model/obj" }));
      const modelMaterial = "newmtl blue\nKd 0.1 0.3 0.9\nmap_Kd should-never-load.png";
      modelForm.set("materialFile", new File([modelMaterial], "model.mtl", { type: "text/plain" }));
      const modelUpload = await app.handle(new Request(`http://localhost/api/student/classrooms/${roomA}/assignments/${assignmentA}/files`, { method: "POST", headers: studentHeaders, body: modelForm }));
      expect(modelUpload.status).toBe(200);
      const uploadedModel = await modelUpload.json() as { id: string; materialAvailable: boolean };
      expect(uploadedModel.materialAvailable).toBe(true);
      const modelMaterialRead = await app.handle(new Request(`http://localhost/api/student/files/${uploadedModel.id}/material`, { headers: studentHeaders }));
      expect(modelMaterialRead.status).toBe(200);
      expect(await modelMaterialRead.text()).toBe(modelMaterial);
      expect((await app.handle(new Request(`http://localhost/api/student/files/${uploadedModel.id}/material`, { headers: { cookie: peerSessionCookie } }))).status).toBe(404);
      expect((await app.handle(new Request(`http://localhost/api/files/${uploadedModel.id}/material`, { headers: teacherHeaders }))).status).toBe(200);

      const glbBytes = syntheticGLB();
      const glbForm = new FormData(); glbForm.set("file", new File([glbBytes], "synthetic.glb"));
      const glbUpload = await app.handle(new Request(`http://localhost/api/student/classrooms/${roomA}/assignments/${assignmentA}/files`, { method: "POST", headers: studentHeaders, body: glbForm }));
      expect(glbUpload.status).toBe(200);
      const glbFile = await glbUpload.json() as { id: string };
      await sql`INSERT INTO classroom.gallery_worlds(classroom_id,enabled) VALUES(${roomA},true) ON CONFLICT(classroom_id) DO UPDATE SET enabled=true`;
      const voteFileIds = Array.from({ length: 11 }, () => randomUUID());
      const earlierAssignmentId = randomUUID(), earlierAssignmentModelId = randomUUID();
      await sql`INSERT INTO classroom.assignments(id,classroom_id,title,created_at) VALUES(${earlierAssignmentId},${roomA},'Earlier project',NOW()-INTERVAL '1 day')`;
      await sql`INSERT INTO classroom.files(id,classroom_id,assignment_id,student_id,uploaded_by,kind,original_name,storage_name,media_type,size_bytes)
        VALUES(${earlierAssignmentModelId},${roomA},${earlierAssignmentId},${studentB},${teacherId},'model','earlier.stl',${randomUUID()},'model/stl',8)`;
      for (const [index, id] of voteFileIds.entries()) await sql`INSERT INTO classroom.files
        (id,classroom_id,assignment_id,student_id,uploaded_by,kind,original_name,storage_name,media_type,size_bytes)
        VALUES(${id},${roomA},${assignmentA},${studentB},${teacherId},'model',${`vote-${index + 1}.stl`},${randomUUID()},'model/stl',8)`;
      const voteRequest = (suffix: string, method = "PUT", headers = studentHeaders) => app.handle(new Request(`http://localhost/api/classrooms/${roomA}/gallery/files/${suffix}/like`, { method, headers }));
      const voteSummary = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/gallery/votes`, { headers: studentHeaders }));
      expect(voteSummary.status).toBe(200);
      expect(await voteSummary.json()).toMatchObject({ limit: 10, blockTotals: [], usage: [], myVotes: [] });
      const concurrentVotes = await Promise.all(voteFileIds.map((id) => voteRequest(id)));
      expect(concurrentVotes.map((response) => response.status).sort()).toEqual([...Array(10).fill(200), 409].sort());
      const acceptedIds = voteFileIds.filter((_id, index) => concurrentVotes[index]?.status === 200);
      const rejectedId = voteFileIds.find((_id, index) => concurrentVotes[index]?.status === 409)!;
      const fullVoteSummary = await (await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/gallery/votes`, { headers: studentHeaders }))).json() as GalleryVoteSummaryTest;
      expect(fullVoteSummary).toMatchObject({ limit: 10, usage: [{ assignmentId: assignmentA, used: 10 }] });
      expect(fullVoteSummary.myVotes).toHaveLength(10);
      expect(fullVoteSummary.blockTotals).toContainEqual({ studentId: studentB, votes: 10 });
      expect((await voteRequest(acceptedIds[0]!, "PUT")).status).toBe(200); // Retries do not spend another slot.
      expect((await voteRequest(rejectedId)).status).toBe(409);
      expect(await (await voteRequest(earlierAssignmentModelId)).json()).toMatchObject({ likedByMe: true, remaining: 9 });
      expect((await (await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/gallery/votes`, { headers: studentHeaders }))).json() as GalleryVoteSummaryTest).usage).toEqual(expect.arrayContaining([
        { assignmentId: assignmentA, used: 10 }, { assignmentId: earlierAssignmentId, used: 1 },
      ]));
      const hiddenVote = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/gallery/files/${acceptedIds[0]}/visibility`, {
        method: "PUT", headers: { ...teacherHeaders, "content-type": "application/json" }, body: JSON.stringify({ hidden: true }),
      }));
      expect(hiddenVote.status).toBe(200);
      const hiddenVotes = await (await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/gallery/votes`, { headers: studentHeaders }))).json() as GalleryVoteSummaryTest;
      expect(hiddenVotes.myVotes.find((vote) => vote.fileId === acceptedIds[0])).toMatchObject({ hidden: true });
      const visibleManifest = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/gallery`, { headers: studentHeaders }));
      expect((await visibleManifest.json() as { models: { id: string }[] }).models.some((model) => model.id === acceptedIds[0])).toBe(false);
      const undoHiddenVote = await voteRequest(acceptedIds[0]!, "DELETE");
      expect(await undoHiddenVote.json()).toMatchObject({ likedByMe: false, remaining: 1 });
      expect((await (await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/gallery/votes`, { headers: studentHeaders }))).json() as GalleryVoteSummaryTest).myVotes).toHaveLength(10);
      expect((await voteRequest(rejectedId)).status).toBe(200);
      expect((await voteRequest(peerFile)).status).toBe(409);
      expect((await voteRequest(uploadedModel.id)).status).toBe(404); // Self-likes stay forbidden.
      const teacherVotes = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/gallery/votes`, { headers: teacherHeaders }));
      expect(teacherVotes.status).toBe(200);
      expect(await teacherVotes.json()).toMatchObject({ limit: 10, usage: [], myVotes: [] });
      expect((await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/gallery/votes`, { headers: { cookie: `classroom_session=${otherTeacherToken}` } }))).status).toBe(404);
      const worldContent = `http://localhost/api/classrooms/${roomA}/gallery/files/${glbFile.id}/content`;
      const glbRead = await app.handle(new Request(worldContent, { headers: studentHeaders }));
      expect(glbRead.status).toBe(200); expect(new Uint8Array(await glbRead.arrayBuffer())).toEqual(new Uint8Array(glbBytes));
      await sql`UPDATE classroom.gallery_worlds SET enabled=false WHERE classroom_id=${roomA}`;
      expect((await app.handle(new Request(worldContent, { headers: studentHeaders }))).status).toBe(404);
      expect((await app.handle(new Request(worldContent, { headers: teacherHeaders }))).status).toBe(200);
      expect((await app.handle(new Request(`http://localhost/api/files/${glbFile.id}`, { method: "DELETE", headers: teacherHeaders }))).status).toBe(200);
      expect((await app.handle(new Request(worldContent, { headers: teacherHeaders }))).status).toBe(404);

      const workingPath = `/api/student/classrooms/${roomA}/assignments/${assignmentA}/working-file`;
      const legacyBlend = Buffer.from("BLENDER-v300");
      const workingForm = (name: string, bytes: Buffer, replaceFileId?: string) => {
        const form = new FormData(); form.set("file", new File([Uint8Array.from(bytes)], name, { type: "application/octet-stream" }));
        if (replaceFileId) form.set("replaceFileId", replaceFileId);
        return form;
      };
      const rejectedBlendSubmission = await app.handle(new Request(`http://localhost/api/student/classrooms/${roomA}/assignments/${assignmentA}/files`, {
        method: "POST", headers: studentHeaders, body: workingForm("scene.blend", legacyBlend),
      }));
      expect(rejectedBlendSubmission.status).toBe(422);
      const firstWorking = await app.handle(new Request(`http://localhost${workingPath}`, { method: "PUT", headers: studentHeaders, body: workingForm("scene.blend", legacyBlend) }));
      expect(firstWorking.status).toBe(200);
      const firstWorkingData = await firstWorking.json() as { id: string; originalName: string; sizeBytes: number; cleanupPending: boolean };
      expect(firstWorkingData).toMatchObject({ originalName: "scene.blend", sizeBytes: legacyBlend.byteLength, cleanupPending: false });
      const peerFiles = await app.handle(new Request(`http://localhost/api/student/classrooms/${roomA}/assignments/${assignmentA}/files`, { headers: { cookie: peerSessionCookie } }));
      expect((await peerFiles.json() as { id: string }[]).some((file) => file.id === firstWorkingData.id)).toBe(false);
      expect((await app.handle(new Request(`http://localhost/api/student/files/${firstWorkingData.id}/content`, { headers: { cookie: peerSessionCookie } }))).status).toBe(404);
      expect((await app.handle(new Request(`http://localhost/api/student/files/${firstWorkingData.id}`, { method: "DELETE", headers: { cookie: peerSessionCookie, origin: "http://localhost:3000" } }))).status).toBe(404);
      const ownFiles = await app.handle(new Request(`http://localhost/api/student/classrooms/${roomA}/assignments/${assignmentA}/files`, { headers: studentHeaders }));
      expect((await ownFiles.json() as { id: string; kind: string; studentSubmission: boolean; thumbnailAvailable: boolean }[]).find((file) => file.id === firstWorkingData.id))
        .toMatchObject({ kind: "working", studentSubmission: false, thumbnailAvailable: false });
      const workingRead = await app.handle(new Request(`http://localhost/api/student/files/${firstWorkingData.id}/content`, { headers: studentHeaders }));
      expect(workingRead.status).toBe(200);
      expect(Buffer.from(await workingRead.arrayBuffer())).toEqual(legacyBlend);
      expect((await app.handle(new Request(`http://localhost/api/files/${firstWorkingData.id}/content`, { headers: teacherHeaders }))).status).toBe(200);
      const workingInTeacherList = await app.handle(new Request(`http://localhost/api/classrooms/${roomA}/assignments/${assignmentA}/files?studentId=${studentA}`, { headers: teacherHeaders }));
      expect((await workingInTeacherList.json() as { id: string; kind: string; studentSubmission: boolean }[]).find((file) => file.id === firstWorkingData.id)).toMatchObject({ kind: "working", studentSubmission: false });
      const assignmentWithWorking = await app.handle(new Request("http://localhost/api/student/assignments", { headers: studentHeaders }));
      expect((await assignmentWithWorking.json() as { assignmentId: string; submissionCount: number }[]).find((item) => item.assignmentId === assignmentA)?.submissionCount).toBe(2);

      const workingSuffix = randomUUID().replaceAll("-", "");
      workingTriggerName = `test_working_rollback_${workingSuffix}`; workingFunctionName = `test_working_rollback_fn_${workingSuffix}`;
      await sql.unsafe(`CREATE FUNCTION classroom.${workingFunctionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind = 'working' AND NEW.original_name = 'fail.blend' THEN RAISE EXCEPTION 'forced working file rollback'; END IF; RETURN NEW; END $$`).simple();
      await sql.unsafe(`CREATE TRIGGER ${workingTriggerName} BEFORE INSERT ON classroom.files FOR EACH ROW EXECUTE FUNCTION classroom.${workingFunctionName}()`).simple();
      workingTriggerInstalled = true;
      const beforeFailedReplacement = (await readdir(uploadDir)).sort();
      const failedReplacement = await app.handle(new Request(`http://localhost${workingPath}`, { method: "PUT", headers: studentHeaders, body: workingForm("fail.blend", Buffer.from("BLENDER-v301"), firstWorkingData.id) }));
      expect(failedReplacement.status).toBe(500);
      const afterFailedReplacement = await sql<{ id: string; storageName: string }[]>`SELECT id, storage_name AS "storageName" FROM classroom.files WHERE kind = 'working' AND assignment_id = ${assignmentA} AND student_id = ${studentA}`;
      expect([...afterFailedReplacement]).toEqual([{ id: firstWorkingData.id, storageName: firstWorkingData.id }]);
      expect(await Bun.file(resolve(uploadDir, firstWorkingData.id)).exists()).toBe(true);
      expect((await readdir(uploadDir)).sort()).toEqual(beforeFailedReplacement);
      await sql.unsafe(`DROP TRIGGER ${workingTriggerName} ON classroom.files`).simple();
      await sql.unsafe(`DROP FUNCTION classroom.${workingFunctionName}()`).simple();
      workingTriggerInstalled = false;

      const currentBlend = Buffer.from("BLENDER17-01v0502");
      const replaced = await app.handle(new Request(`http://localhost${workingPath}`, { method: "PUT", headers: studentHeaders, body: workingForm("scene-new.blend", currentBlend, firstWorkingData.id) }));
      expect(replaced.status).toBe(200);
      const replacedData = await replaced.json() as { id: string };
      expect(replacedData.id).not.toBe(firstWorkingData.id);
      expect((await app.handle(new Request(`http://localhost/api/student/files/${firstWorkingData.id}/content`, { headers: studentHeaders }))).status).toBe(404);
      const staleReplacement = await app.handle(new Request(`http://localhost${workingPath}`, { method: "PUT", headers: studentHeaders, body: workingForm("stale.blend", legacyBlend, firstWorkingData.id) }));
      expect(staleReplacement.status).toBe(409);
      const [concurrentWorkingA, concurrentWorkingB] = await Promise.all([
        app.handle(new Request(`http://localhost${workingPath}`, { method: "PUT", headers: studentHeaders, body: workingForm("race-a.blend", legacyBlend, replacedData.id) })),
        app.handle(new Request(`http://localhost${workingPath}`, { method: "PUT", headers: studentHeaders, body: workingForm("race-b.blend", legacyBlend, replacedData.id) })),
      ]);
      expect([concurrentWorkingA.status, concurrentWorkingB.status].sort()).toEqual([200, 409]);
      const concurrentWorkingSuccess = concurrentWorkingA.status === 200 ? concurrentWorkingA : concurrentWorkingB;
      const finalWorking = await concurrentWorkingSuccess.json() as { id: string };
      const teacherWorkingRead = await app.handle(new Request(`http://localhost/api/files/${finalWorking.id}/content`, { headers: teacherHeaders }));
      expect(teacherWorkingRead.status).toBe(200);
      expect(Buffer.from(await teacherWorkingRead.arrayBuffer())).toEqual(legacyBlend);
      expect((await app.handle(new Request(`http://localhost/api/student/files/${finalWorking.id}`, { method: "DELETE", headers: teacherHeaders }))).status).toBe(401);
      const removeWorking = await app.handle(new Request(`http://localhost/api/student/files/${finalWorking.id}`, { method: "DELETE", headers: studentHeaders }));
      expect(removeWorking.status).toBe(200);
      expect(await removeWorking.json()).toEqual({ ok: true, cleanupPending: false });
      expect((await app.handle(new Request(`http://localhost/api/student/files/${finalWorking.id}/content`, { headers: studentHeaders }))).status).toBe(404);

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
      const storageName = randomUUID(); const materialStorageName = randomUUID() + ".mtl"; const removedFileId = randomUUID(); const missingFileId = randomUUID(); const missingStorageName = randomUUID();
      await Bun.write(resolve(uploadDir, storageName), "synthetic student model");
      await Bun.write(resolve(uploadDir, materialStorageName), "newmtl red\nKd 1 0 0");
      const removedThumbnail = syntheticThumbnail();
      await mkdir(resolve(uploadDir, "thumbnails"), { recursive: true });
      await Bun.write(resolve(uploadDir, "thumbnails", removedFileId + ".png"), removedThumbnail);
      await sql.begin(async (tx) => {
        if (lessonPageIds.length) await tx`DELETE FROM classroom.lesson_pages WHERE id = ANY(${lessonPageIds}::uuid[])`;
        await tx`INSERT INTO classroom.attendance (classroom_id, student_id, attendance_date, status) VALUES (${roomB}, ${studentC}, '2025-01-15', 'present')`;
        await tx`INSERT INTO classroom.files (id, classroom_id, assignment_id, student_id, uploaded_by, kind, original_name, storage_name, media_type, size_bytes, thumbnail_size_bytes, thumbnail_media_type, material_storage_name, material_original_name, material_size_bytes)
          VALUES (${removedFileId}, ${roomB}, ${assignmentB}, ${studentC}, ${teacherId}, 'model', 'student.obj', ${storageName}, 'model/obj', 23, ${removedThumbnail.byteLength}, 'image/png', ${materialStorageName}, 'student.mtl', 19)`;
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
      expect(await Bun.file(resolve(uploadDir, materialStorageName)).exists()).toBe(true);
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
      expect(await Bun.file(resolve(uploadDir, materialStorageName)).exists()).toBe(true);
      expect(await Bun.file(resolve(uploadDir, "thumbnails", removedFileId + ".png")).exists()).toBe(true);
      expect(await Bun.file(resolve(uploadDir, storageName + ".deleting")).exists()).toBe(false);
      expect(await Bun.file(resolve(uploadDir, materialStorageName + ".deleting")).exists()).toBe(false);
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
      expect(await Bun.file(resolve(uploadDir, materialStorageName)).exists()).toBe(false);
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
      if (workingTriggerInstalled) {
        await sql.unsafe(`DROP TRIGGER IF EXISTS ${workingTriggerName} ON classroom.files`).simple().catch(() => {});
        await sql.unsafe(`DROP FUNCTION IF EXISTS classroom.${workingFunctionName}()`).simple().catch(() => {});
      }
      if (trashTriggerInstalled) {
        await sql.unsafe(`DROP TRIGGER IF EXISTS ${trashTriggerName} ON classroom.quizzes`).simple().catch(() => {});
        await sql.unsafe(`DROP FUNCTION IF EXISTS classroom.${trashFunctionName}()`).simple().catch(() => {});
      }
      if (deleteTriggerInstalled) {
        await sql.unsafe(`DROP TRIGGER IF EXISTS ${deleteTriggerName} ON classroom.students`).simple().catch(() => {});
        await sql.unsafe(`DROP FUNCTION IF EXISTS classroom.${deleteFunctionName}()`).simple().catch(() => {});
      }
      const hash = (token: string) => createHash("sha256").update(token).digest("hex");
      if (teacherToken) await sql`DELETE FROM classroom.sessions WHERE token_hash = ${hash(teacherToken)}`;
      if (otherTeacherToken) await sql`DELETE FROM classroom.sessions WHERE token_hash = ${hash(otherTeacherToken)}`;
      if (studentToken) await sql`DELETE FROM classroom.student_sessions WHERE token_hash = ${hash(studentToken)}`;
      await sql.begin(async (tx) => {
        if (lessonPageIds.length) await tx`DELETE FROM classroom.lesson_pages WHERE id = ANY(${lessonPageIds}::uuid[])`;
        if (quizIds.length) {
          await tx`DELETE FROM classroom.classroom_quizzes WHERE quiz_id = ANY(${quizIds}::uuid[])`;
          await tx`DELETE FROM classroom.quizzes WHERE id = ANY(${quizIds}::uuid[])`;
        }
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
