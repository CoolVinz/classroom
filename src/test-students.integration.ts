import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, type Room } from "@colyseus/sdk";
import { Elysia } from "elysia";

const database = process.env.CLASSROOM_TEST_DATABASE_URL;
test.skipIf(!database)("isolates passwordless test student sessions and supports the student workflows", async () => {
  process.env.DATABASE_URL = database!;
  process.env.DATABASE_SSL = "disable";
  process.env.APP_URL = "http://localhost:3000";
  const root = await mkdtemp(join(tmpdir(), "classroom-testers-"));
  process.env.UPLOAD_DIR = root;
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  process.env.GALLERY_WS_URL = "http://127.0.0.1:" + port;
  const { sql } = await import("./db/client");
  const { ensureUploadRoot } = await import("./file-storage");
  const { createSession, createStudentSession, readSessionUser, hashToken } = await import("./auth/session");
  const { handleAppError } = await import("./error-handler");
  const { classroomRoutes } = await import("./routes/classrooms");
  const { courseworkRoutes } = await import("./routes/coursework");
  const { testStudentRoutes } = await import("./routes/test-students");
  const { studentCourseworkRoutes } = await import("./routes/student-coursework");
  const { studentAttendanceRoutes } = await import("./routes/student-attendance");
  const { lessonPageApiRoutes } = await import("./routes/lesson-pages");
  const { galleryRoutes } = await import("./routes/gallery");
  const { liveActivityRoutes } = await import("./routes/live-activities");
  const app = new Elysia().onError(handleAppError).use(testStudentRoutes).use(classroomRoutes).use(courseworkRoutes)
    .use(studentCourseworkRoutes).use(studentAttendanceRoutes).use(lessonPageApiRoutes).use(galleryRoutes).use(liveActivityRoutes);
  const server = spawn("node", ["src/server.mjs"], { cwd: "gallery-server", env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  const rooms: Room[] = [];
  const owner = randomUUID(), teacher = randomUUID(), normalAccount = randomUUID(), schoolId = randomUUID();
  const testAssignment = randomUUID(), realAssignment = randomUUID(), testLesson = randomUUID(), realLesson = randomUUID(), quizId = randomUUID();
  const classroomIds: string[] = [];
  const headers = (token?: string) => ({ origin: "http://localhost:3000", ...(token ? { cookie: "classroom_session=" + token } : {}) });
  const call = (path: string, token?: string, method = "GET", body?: object, origin = "http://localhost:3000") => app.handle(new Request("http://localhost/api" + path, {
    method, headers: { ...headers(token), origin, ...(body && { "content-type": "application/json" }) }, body: body ? JSON.stringify(body) : undefined,
  }));
  async function read(path: string, token?: string, method = "GET", body?: object) {
    const response = await call(path, token, method, body);
    if (!response.ok) throw new Error(`${method} ${path} ${response.status} ${await response.text()}`);
    return response.json();
  }
  const redeem = (path: string, token?: string, origin?: string) =>
    call("/auth/test-student/redeem", token, "POST", { token: path.split("#")[1] }, origin);
  async function waitFor(condition: () => boolean | Promise<boolean>, timeout = 4000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await Bun.sleep(50);
    }
    throw new Error("Timed out waiting for the room state");
  }
  function cookieToken(response: Response) {
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain("Max-Age=7200");
    expect(cookie).toContain("HttpOnly; SameSite=Lax");
    return cookie!.split(";")[0].split("=")[1];
  }
  try {
    await ensureUploadRoot();
    await waitFor(async () => {
      try { return (await fetch(process.env.GALLERY_WS_URL + "/__healthcheck")).ok; } catch { return false; }
    });
    await sql`INSERT INTO classroom.teachers (id,username,display_name,password_hash,role) VALUES
      (${owner},${owner},'Test Owner','unused','owner'),(${teacher},${teacher},'Ordinary Teacher','unused','teacher')`;
    const ownerToken = await createSession(owner), teacherToken = await createSession(teacher);
    const createRoom = async (name: string, isTest?: boolean) => {
      const room = await read("/classrooms", ownerToken, "POST", { name, isTest });
      classroomIds.push(room.id);
      return room;
    };
    const regular = await createRoom("Regular synthetic classroom");
    const testRoom = await createRoom("Test classroom", true);
    const secondRoom = await createRoom("Other test classroom", true);
    expect(regular.isTest).toBe(false);
    expect(testRoom.isTest).toBe(true);
    expect((await call("/classrooms", teacherToken, "POST", { name: "Denied", isTest: true })).status).toBe(403);
    const base = "/classrooms/" + testRoom.id;
    expect((await call(base + "/testers", teacherToken, "POST", { displayName: "Denied" })).status).toBe(403);
    expect((await call("/classrooms/" + regular.id + "/testers", ownerToken, "POST", { displayName: "Denied" })).status).toBe(404);
    expect((await call(base + "/students", ownerToken, "POST", { displayName: "Denied" })).status).toBe(422);
    expect((await call(base + "/roster/import", ownerToken, "POST", { students: [{ studentCode: "01", displayName: "Denied" }] })).status).toBe(422);
    expect((await call(base + "/testers", ownerToken, "POST", { displayName: "Denied" }, "https://example.test")).status).toBe(403);
    const { id: testerId } = await read(base + "/testers", ownerToken, "POST", { displayName: "Tester One", studentNumber: 1 });
    expect((await call(base + "/testers", ownerToken, "POST", { displayName: "Duplicate", studentNumber: 1 })).status).toBe(409);
    const patchPath = base + "/students/" + testerId;
    expect((await call(patchPath, ownerToken, "PATCH", { email: "unsafe@banjan.ac.th" })).status).toBe(422);
    await read(patchPath, ownerToken, "PATCH", { displayName: "Updated Tester", studentNumber: 7 });
    const [tester] = await sql`SELECT s.account_id AS id, a.email, a.google_subject, a.password_hash FROM classroom.students s
      JOIN classroom.student_accounts a ON a.id = s.account_id WHERE s.id = ${testerId}`;
    expect(tester).toMatchObject({ email: null, google_subject: null, password_hash: null });
    const schoolEmail = schoolId + "@banjan.ac.th";
    await sql`INSERT INTO classroom.student_accounts(id,email,google_subject) VALUES(${normalAccount},${schoolEmail},${schoolId})`;
    await sql`INSERT INTO classroom.students(classroom_id,display_name,email) VALUES(${regular.id},'Real roster fixture',${schoolEmail})`;
    await expect(Promise.resolve(sql`INSERT INTO classroom.students(classroom_id,account_id,display_name) VALUES (${regular.id},${tester.id},'Blocked')`)).rejects.toMatchObject({ code: "23514" });
    await expect(Promise.resolve(sql`INSERT INTO classroom.students(classroom_id,account_id,display_name) VALUES (${secondRoom.id},${tester.id},'Blocked')`)).rejects.toMatchObject({ code: "23514" });
    await expect(Promise.resolve(sql`INSERT INTO classroom.students(classroom_id,account_id,display_name) VALUES (${testRoom.id},${normalAccount},'Blocked')`)).rejects.toMatchObject({ code: "23514" });
    const normalToken = await createStudentSession(normalAccount);
    // An already-linked membership lets a regular Google-backed student refresh their other classrooms.
    await sql`UPDATE classroom.students SET account_id = ${normalAccount} WHERE classroom_id = ${regular.id}`;
    expect(await read("/student/classrooms/refresh", normalToken, "POST")).toMatchObject([{ classroomId: regular.id }]);

    const accessPath = base + "/testers/" + testerId;
    const issue = () => read(accessPath + "/link", ownerToken, "POST");
    expect((await call(accessPath + "/link", teacherToken, "POST")).status).toBe(403);
    const initial = await issue();
    const replacement = await issue();
    expect((await redeem(initial.path)).status).toBe(410);
    expect((await redeem(replacement.path, ownerToken)).status).toBe(409);
    expect((await redeem(replacement.path, normalToken)).status).toBe(409);
    expect((await redeem(replacement.path, undefined, "https://example.test")).status).toBe(403);
    await sql`UPDATE classroom.test_student_links SET expires_at = NOW() - INTERVAL '1 second' WHERE account_id = ${tester.id}`;
    expect((await redeem(replacement.path)).status).toBe(410);
    const valid = await issue();
    const results = await Promise.all([redeem(valid.path), redeem(valid.path)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 410]);
    const good = results.find((result) => result.ok)!;
    const studentToken = cookieToken(good);
    expect(await good.json()).toEqual({ path: base + "/join" });
    expect(await readSessionUser(new Request("http://localhost", { headers: headers(studentToken) })))
      .toMatchObject({ role: "student", displayName: "Updated Tester", isTester: true });
    const [lifetime] = await sql`SELECT EXTRACT(EPOCH FROM expires_at-created_at)::int AS duration
      FROM classroom.student_sessions WHERE token_hash = ${hashToken(studentToken)}`;
    expect(lifetime.duration).toBe(7200);
    expect((await call("/overview", studentToken)).status).toBe(401);
    expect(await read("/student/classrooms/refresh", studentToken, "POST")).toEqual([{ classroomId: testRoom.id, classroomName: testRoom.name }]);

    await sql`INSERT INTO classroom.assignments(id,classroom_id,title) VALUES
      (${testAssignment},${testRoom.id},'Test work'),(${realAssignment},${regular.id},'Restricted work')`;
    expect(await read("/student/assignments", studentToken)).toMatchObject([{ assignmentId: testAssignment }]);
    const filesPath = (room: string, work: string) => `/student/classrooms/${room}/assignments/${work}/files`;
    expect((await call(filesPath(regular.id, realAssignment), studentToken)).status).toBe(404);
    const upload = new FormData();
    upload.set("file", new File(["v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"], "model.obj"));
    const uploadResponse = await app.handle(new Request("http://localhost/api" + filesPath(testRoom.id, testAssignment), {
      method: "POST", headers: headers(studentToken), body: upload,
    }));
    expect(uploadResponse.status).toBe(200);

    await sql`INSERT INTO classroom.lesson_pages(id,owner_id,title,published_title,published_at,published_blocks) VALUES
      (${testLesson},${owner},'Test lesson','Test lesson',NOW(),'[]'),(${realLesson},${owner},'Real lesson','Real lesson',NOW(),'[]')`;
    await sql`INSERT INTO classroom.classroom_lessons(classroom_id,lesson_id) VALUES(${testRoom.id},${testLesson}),(${regular.id},${realLesson})`;
    expect((await call("/student" + base + "/lesson-pages/" + testLesson, studentToken)).status).toBe(200);
    expect((await call("/student/classrooms/" + regular.id + "/lesson-pages/" + realLesson, studentToken)).status).toBe(404);

    const [day] = await sql`INSERT INTO classroom.lessons(classroom_id,lesson_date,starts_at,ends_at,grace_minutes)
      VALUES(${testRoom.id}, (NOW() AT TIME ZONE 'Asia/Bangkok')::date, NOW() - INTERVAL '1 minute', NOW() + INTERVAL '10 minutes', 5)
      RETURNING to_char(lesson_date,'YYYY-MM-DD') AS date`;
    const presence = { lessonDate: day.date, viewId: randomUUID(), active: true, sequence: 1 };
    expect(await read("/student" + base + "/attendance/presence", studentToken, "POST", presence)).toMatchObject({ accepted: true });
    const overview = await read("/overview", ownerToken);
    expect(overview).toMatchObject({ classrooms: 1, students: 1, present: 0 });

    await read(base + "/gallery", ownerToken, "PUT", { enabled: true });
    const world = await read(base + "/gallery/ticket", studentToken, "POST");
    const ws = new Client(process.env.GALLERY_WS_URL);
    const worldRoom = await ws.joinOrCreate("classroom", { classroomId: testRoom.id, ticket: world.ticket });
    rooms.push(worldRoom);
    worldRoom.onMessage("*", () => {});
    await waitFor(() => worldRoom.state?.players?.has(worldRoom.sessionId));
    expect((await call("/classrooms/" + regular.id + "/gallery/ticket", studentToken, "POST")).status).toBe(404);

    const answer = randomUUID();
    await sql`INSERT INTO classroom.quizzes(id,owner_id,title,published_title,published_content,published_at)
      VALUES(${quizId},${owner},'Tester quiz','Tester quiz',${sql.json({ description: "", questions: [{
        id: randomUUID(), type: "true-false", prompt: "Choose true", correctChoiceId: answer,
        points: 1, explanation: "", imageId: null, choices: [
          { id: answer, text: "True", imageId: null }, { id: randomUUID(), text: "False", imageId: null },
        ],
      }] })},NOW())`;
    const live = await read(base + "/live-activities", ownerToken, "POST", { kind: "quiz", quizId });
    const livePath = "/live-activities/" + live.id;
    expect((await call(livePath + "/ticket", normalToken, "POST")).status).toBe(404);
    const liveAdmission = await read(livePath + "/ticket", studentToken, "POST");
    const liveRoom = await ws.joinOrCreate("live-activity", { activityId: live.id, ticket: liveAdmission.ticket });
    rooms.push(liveRoom);
    liveRoom.onMessage("*", () => {});
    await waitFor(() => liveRoom.state?.players?.has(liveRoom.sessionId));
    await read(livePath + "/command", ownerToken, "POST", { action: "next", revision: 0 });
    await waitFor(() => liveRoom.state?.phase === "answering");
    liveRoom.send("area", { questionIndex: 0, choice: 0 });
    await waitFor(() => liveRoom.state.players.get(liveRoom.sessionId)?.selected === 0);
    await read(livePath + "/command", ownerToken, "POST", { action: "lock", revision: 1 });
    expect(await read(livePath, studentToken)).toMatchObject({ score: 1 });

    const oneMore = await issue();
    expect((await call("/student/assignments", studentToken)).status).toBe(200);
    const secondToken = cookieToken(await redeem(oneMore.path));
    expect((await call("/student/assignments", studentToken)).status).toBe(401);
    await waitFor(() => !liveRoom.connection.isOpen);
    await waitFor(() => !worldRoom.connection.isOpen, 17000);
    await call(accessPath + "/access", ownerToken, "DELETE");
    expect((await call("/student/assignments", secondToken)).status).toBe(401);
    const shouldExpire = await issue();
    const expiredToken = cookieToken(await redeem(shouldExpire.path));
    await sql`UPDATE classroom.student_sessions SET expires_at = NOW() - INTERVAL '1 second' WHERE token_hash = ${hashToken(expiredToken)}`;
    expect((await call("/student/assignments", expiredToken)).status).toBe(401);
    const archivePending = await issue();
    await read(patchPath, ownerToken, "PATCH", { archived: true });
    expect((await redeem(archivePending.path)).status).toBe(410);
    await read(patchPath, ownerToken, "PATCH", { archived: false });
    expect((await redeem(archivePending.path)).status).toBe(410);
    const archiveSession = cookieToken(await redeem((await issue()).path));
    const archiveLink = await issue();
    await read(base, ownerToken, "PATCH", { archived: true });
    expect((await redeem(archiveLink.path)).status).toBe(410);
    expect((await call("/student/assignments", archiveSession)).status).toBe(401);
    const [attendance] = await sql`SELECT status FROM classroom.attendance WHERE student_id = ${testerId}`;
    expect(attendance.status).toBe("present");
    expect((await call("/student/assignments", normalToken)).status).toBe(200);
    expect((await call(patchPath, ownerToken, "DELETE")).status).toBe(200);
    expect(await sql`SELECT id FROM classroom.student_accounts WHERE id = ${tester.id}`).toHaveLength(0);
  } finally {
    await Promise.allSettled(rooms.filter((room) => room.connection.isOpen).map((room) => room.leave()));
    server.kill();
    await sql`DELETE FROM classroom.attendance WHERE classroom_id = ANY(${classroomIds}::uuid[])`;
    await sql`DELETE FROM classroom.lessons WHERE classroom_id = ANY(${classroomIds}::uuid[])`;
    await sql`DELETE FROM classroom.files WHERE classroom_id = ANY(${classroomIds}::uuid[])`;
    await sql`DELETE FROM classroom.assignments WHERE classroom_id = ANY(${classroomIds}::uuid[])`;
    await sql`DELETE FROM classroom.classroom_lessons WHERE classroom_id = ANY(${classroomIds}::uuid[])`;
    await sql`DELETE FROM classroom.lesson_pages WHERE id = ANY(${[testLesson, realLesson]}::uuid[])`;
    await sql`DELETE FROM classroom.quizzes WHERE id = ${quizId}`;
    await sql`DELETE FROM classroom.students WHERE classroom_id = ANY(${classroomIds}::uuid[])`;
    await sql`DELETE FROM classroom.student_accounts WHERE id = ${normalAccount} OR test_classroom_id = ANY(${classroomIds}::uuid[])`;
    await sql`DELETE FROM classroom.classrooms WHERE id = ANY(${classroomIds}::uuid[])`;
    await sql`DELETE FROM classroom.teachers WHERE id = ANY(${[owner, teacher]}::uuid[])`;
    await sql.end();
    await rm(root, { recursive: true, force: true });
  }
}, 40000);
