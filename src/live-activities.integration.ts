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
import { activitySpawn, choiceZones, zoneCenter, zoneChoice } from "../gallery-server/src/live-activity-layout.mjs";

const database = process.env.CLASSROOM_TEST_DATABASE_URL;
test.skipIf(!database)("hosts a 50-student live quiz and moderated discussion", async () => {
  process.env.DATABASE_URL = database!;
  process.env.DATABASE_SSL = "disable";
  process.env.APP_URL = "http://localhost:3000";
  const root = await mkdtemp(join(tmpdir(), "classroom-live-test-"));
  process.env.UPLOAD_DIR = root;
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  process.env.GALLERY_WS_URL = "http://127.0.0.1:" + port;
  const { sql } = await import("./db/client");
  const { createSession, createStudentSession, deleteSession } = await import("./auth/session");
  const { liveActivityRoutes } = await import("./routes/live-activities");
  const { gradebookRoutes } = await import("./routes/gradebook");
  const { quizRoutes } = await import("./routes/quizzes");
  const { handleAppError } = await import("./error-handler");
  const { cleanupUnusedLessonImages } = await import("./file-storage");
  const app = new Elysia().onError(handleAppError).use(liveActivityRoutes).use(gradebookRoutes).use(quizRoutes);
  const server = spawn("node", ["src/server.mjs"], { cwd: "gallery-server", env: { ...process.env, PORT: String(port) }, stdio: "inherit" });
  const rooms: Room[] = [];
  const request = (token: string | null, path: string, method = "GET", body?: object) => app.handle(new Request("http://localhost/api" + path, {
    method, headers: { cookie: token ? "classroom_session=" + token : "", origin: "http://localhost:3000", "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }));
  const read = async (token: string, path: string, method = "GET", body?: object) => {
    const response = await request(token, path, method, body);
    const result = await response.json();
    if (!response.ok) throw new Error(`${method} ${path} ${response.status}: ${JSON.stringify(result)}`);
    return result;
  };
  async function waitFor(condition: () => boolean | Promise<boolean>) {
    for (let i = 0; i < 120; i++) {
      if (await condition()) return;
      await Bun.sleep(35);
    }
    throw new Error("Timed out waiting for activity state");
  }
  const teacher = randomUUID(), outsider = randomUUID(), classroom = randomUUID(), quiz = randomUUID(), lesson = randomUUID(), image = randomUUID();
  const first = { id: randomUUID(), text: "ถูก", imageId: image };
  const second = { id: randomUUID(), text: "ผิด", imageId: null };
  const content = { description: "", questions: [
    { id: randomUUID(), type: "true-false", prompt: "คำถามที่หนึ่ง", choices: [first, second], correctChoiceId: first.id, imageId: null, points: 3, explanation: "เฉลยหนึ่ง" },
    { id: randomUUID(), type: "true-false", prompt: "คำถามที่สอง", choices: [first, second], correctChoiceId: second.id, imageId: null, points: 2, explanation: "เฉลยสอง" },
  ] };
  const studentRows = Array.from({ length: 51 }, (_, index) => ({
    id: randomUUID(), account_id: randomUUID(), student_number: index + 1, display_name: "Synthetic Student " + (index + 1),
  }));
  const createPath = `/classrooms/${classroom}/live-activities`;
  try {
    for (let i = 0; i < 70; i++) {
      try {
        if ((await fetch(process.env.GALLERY_WS_URL + "/__healthcheck")).ok) break;
      } catch {}
      await Bun.sleep(50);
    }
    await sql`INSERT INTO classroom.teachers(id,username,display_name,password_hash) VALUES
      (${teacher},${teacher},'Test Teacher','unused'),(${outsider},${outsider},'Other Teacher','unused')`;
    await sql`INSERT INTO classroom.classrooms(id,owner_id,name) VALUES(${classroom},${teacher},'Live QA')`;
    await sql`INSERT INTO classroom.student_accounts(id,email)
      SELECT account_id, account_id::text || '@banjan.ac.th' FROM jsonb_to_recordset(${sql.json(studentRows)}::jsonb) x(account_id uuid)`;
    await sql`INSERT INTO classroom.students(id,account_id,classroom_id,student_number,display_name)
      SELECT id,account_id,${classroom},student_number,display_name FROM jsonb_to_recordset(${sql.json(studentRows)}::jsonb)
      x(id uuid,account_id uuid,student_number integer,display_name text)`;
    await sql`UPDATE classroom.student_accounts SET avatar_settings=avatar_settings || '{"hatStyle":"wizard","hatColor":"#448822"}' WHERE id=${studentRows[0].account_id}`;
    await sql`INSERT INTO classroom.quizzes(id, owner_id, title, published_title, published_at, published_content)
      VALUES(${quiz},${teacher},'Synthetic Quiz','Synthetic Quiz',NOW(),${sql.json(content)})`;
    await sql`INSERT INTO classroom.quiz_images(id,quiz_id,original_name,storage_name,size_bytes,created_at)
      VALUES(${image},${quiz},'test.webp',${image},4,NOW()-INTERVAL '2 days')`;
    await Bun.write(join(root, image), "WebP");
    await sql`INSERT INTO classroom.lesson_pages(id,owner_id,title,published_title,published_at,published_blocks)
      VALUES(${lesson},${teacher},'Synthetic Lesson','Synthetic Lesson',NOW(),'[]')`;
    await sql`INSERT INTO classroom.classroom_lessons(classroom_id,lesson_id) VALUES(${classroom},${lesson})`;
    const hostToken = await createSession(teacher);
    const outsiderToken = await createSession(outsider);
    const studentTokens = await Promise.all(studentRows.map((student) => createStudentSession(student.account_id)));
    const firstToken = studentTokens[0];
    const { id } = await read(hostToken, createPath, "POST", { kind: "quiz", quizId: quiz, lessonId: lesson, questionSeconds: 120 });
    const path = "/live-activities/" + id;
    expect(await read(firstToken, `/student/live-activities?lessonId=${lesson}`)).toMatchObject([{ id }]);
    expect((await request(outsiderToken, path)).status).toBe(404);
    expect((await request(null, path)).status).toBe(401);
    expect((await request(outsiderToken, createPath, "POST", { kind: "discussion", title: "Other", prompt: "Other" })).status).toBe(404);
    expect((await request(hostToken, createPath, "POST", { kind: "discussion", title: "Second", prompt: "Duplicate" })).status).toBe(409);
    expect((await request(firstToken, path + "/images/" + image)).status).toBe(404);
    await sql`UPDATE classroom.quizzes SET published_content='{"description":"","questions":[]}' WHERE id=${quiz}`;
    await cleanupUnusedLessonImages();
    expect(await Bun.file(join(root, image)).exists()).toBe(true);

    const ws = new Client(process.env.GALLERY_WS_URL);
    async function connect(token: string, activityId = id) {
      const { ticket } = await read(token, "/live-activities/" + activityId + "/ticket", "POST");
      const room = await ws.joinOrCreate("live-activity", { activityId, ticket });
      room.onMessage("*", () => {});
      rooms.push(room);
      return { room, ticket };
    }

    const { room: host, ticket } = await connect(hostToken);
    await expect(ws.joinOrCreate("live-activity", { activityId: id, ticket })).rejects.toThrow();
    const players = await Promise.all(studentTokens.slice(0, 50).map((token) => connect(token).then((result) => result.room)));
    await waitFor(() => host.state?.players?.size === 51);
    await expect(connect(studentTokens[50])).rejects.toThrow();
    const stateOf = (room: Room) => host.state.players.get(room.sessionId);
    expect(stateOf(players[0])).toMatchObject({ displayName: studentRows[0].display_name, hatStyle: "wizard", hatColor: "#448822" });

    const command = async (action: string, recap?: string, target = path) => {
      const state = await read(hostToken, target);
      return read(hostToken, target + "/command", "POST", { action, recap, revision: state.revision });
    };
    await command("next");
    await waitFor(() => host.state.questionIndex === 0);
    const answering = await read(firstToken, path);
    expect(answering.question).toMatchObject({ prompt: content.questions[0].prompt });
    expect(answering.question).not.toHaveProperty("correctChoiceId");
    expect(answering.question).not.toHaveProperty("explanation");
    expect(answering.reveal).toBeNull();
    expect((await request(firstToken, path + "/images/" + image)).status).toBe(200);
    expect((await request(studentTokens[50], path + "/images/" + image)).status).toBe(404);
    expect((await request(firstToken, path + "/command", "POST", { action: "lock", revision: answering.revision })).status).toBe(401);
    await expect(connect(firstToken)).rejects.toThrow();

    const startY = stateOf(players[0]).y;
    for (const room of players) room.send("step", { questionIndex: 0, dx: 0, dy: -1 });
    await waitFor(() => stateOf(players[0]).y < startY);
    await Bun.sleep(90);
    players.forEach((room, index) => room.send("area", { questionIndex: 0, choice: index % 2 }));
    await waitFor(() => players.every((room, index) => stateOf(room).selected === index % 2));
    await Bun.sleep(90);
    players[0].send("area", { questionIndex: 0, choice: 1 });
    await waitFor(() => stateOf(players[0]).selected === 1);
    await Bun.sleep(90);
    players[0].send("area", { questionIndex: 0, choice: 0 });
    await waitFor(() => stateOf(players[0]).selected === 0);
    await players[0].leave();
    await waitFor(() => host.state.players.size === 50);
    const { room: returned } = await connect(firstToken);
    await waitFor(() => stateOf(returned)?.selected === 0);
    expect((await request(hostToken, path + "/command", "POST", { action: "lock", revision: answering.revision - 1 })).status).toBe(409);
    await command("lock");
    expect(await read(firstToken, path)).toMatchObject({ phase: "revealed", score: 3, reveal: { correctChoiceId: first.id, counts: [25, 25] } });
    await command("next");
    await waitFor(() => host.state.questionIndex === 1);
    returned.send("area", { questionIndex: 0, choice: 1 });
    await Bun.sleep(130);
    expect(stateOf(returned).selected).toBe(-1);
    returned.send("area", { questionIndex: 1, choice: 1 });
    await waitFor(() => stateOf(returned).selected === 1);
    await sql`UPDATE classroom.live_activities SET deadline=clock_timestamp()-INTERVAL '1 second' WHERE id=${id}`;
    players[1].send("area", { questionIndex: 1, choice: 1 });
    expect(await read(firstToken, path)).toMatchObject({ phase: "revealed", score: 5, reveal: { counts: [0, 1] } });
    await command("finish");
    const book = () => read(hostToken, `/classrooms/${classroom}/gradebook`);
    expect((await book()).items.find((item: { id: string }) => item.id === id)).toBeUndefined();
    expect((await read(hostToken, path + "/results")).slice(0, 2)).toMatchObject([{ score: 5 }, { score: 0 }]);
    expect((await read(hostToken, path + "/results")).at(-1)).toMatchObject({ joined: false, score: null });
    await read(hostToken, path + "/gradebook", "PUT", { include: true });
    const graded = await book();
    expect(graded.items).toContainEqual(expect.objectContaining({ id, maxScore: 5 }));
    expect(graded.scores).toContainEqual(expect.objectContaining({ itemId: id, studentId: studentRows[1].id, score: 0 }));
    expect(graded.scores.find((score: { studentId: string }) => score.studentId === studentRows[50].id)).toBeUndefined();
    await read(hostToken, path + "/gradebook", "PUT", { include: false });
    expect((await book()).items.find((item: { id: string }) => item.id === id)).toBeUndefined();

    const discussion = await read(hostToken, createPath, "POST", { kind: "discussion", title: "Synthetic recap", prompt: "เรารู้อะไรแล้ว?", lessonId: lesson });
    const discussionPath = "/live-activities/" + discussion.id;
    const { room: contributor } = await connect(firstToken, discussion.id);
    const secondToken = studentTokens[1];
    await command("open", undefined, discussionPath);
    expect((await request(secondToken, discussionPath + "/ideas", "POST", { text: "ยังไม่เข้าห้อง" })).status).toBe(403);
    const ideas = await Promise.all(Array.from({ length: 4 }, (_, index) => request(firstToken, discussionPath + "/ideas", "POST", { text: "ความคิด " + index })));
    expect(ideas.map((response) => response.status).sort()).toEqual([200, 200, 200, 409]);
    expect((await read(secondToken, discussionPath)).ideas).toEqual([]);
    const pending = (await read(hostToken, discussionPath)).ideas[0];
    expect(pending.author).toBe(studentRows[0].display_name);
    await read(hostToken, discussionPath + "/ideas/" + pending.id, "PUT", { approved: true });
    expect((await read(secondToken, discussionPath)).ideas).toMatchObject([{ id: pending.id, author: null }]);
    await command("finish", "สรุปภาษาไทย", discussionPath);
    expect(await read(secondToken, discussionPath)).toMatchObject({ phase: "finished", recap: "สรุปภาษาไทย" });
    expect(await read(secondToken, `/student/live-activities?lessonId=${lesson}`)).toContainEqual(expect.objectContaining({ id: discussion.id }));
    await deleteSession(firstToken);
    expect((await request(firstToken, discussionPath)).status).toBe(401);
    if (contributor.connection.isOpen) await contributor.leave().catch(() => {});
    await sql`UPDATE classroom.students SET archived_at=NOW() WHERE id=${studentRows[1].id}`;
    expect((await request(secondToken, discussionPath)).status).toBe(401);
    expect((await request(hostToken, "/quizzes/" + quiz + "/trash", "POST", { expectedRevision: 0 })).status).toBe(200);
    expect((await request(hostToken, path)).status).toBe(404);
    expect((await request(hostToken, "/quizzes/" + quiz + "/restore", "POST", { expectedRevision: 1 })).status).toBe(200);
    expect(await read(hostToken, path)).toMatchObject({ phase: "finished" });
    expect(choiceZones(8)).toHaveLength(8);
    const zone = zoneCenter(8, 7);
    expect(zoneChoice(8, zone.x, zone.y)).toBe(7);
    expect(zoneChoice(8, activitySpawn.x, activitySpawn.y)).toBe(-1);
  } finally {
    await Promise.allSettled(rooms.filter((room) => room.connection.isOpen).map((room) => room.leave()));
    server.kill();
    await sql`DELETE FROM classroom.live_activities WHERE classroom_id=${classroom}`;
    await sql`DELETE FROM classroom.classroom_lessons WHERE classroom_id=${classroom}`;
    await sql`DELETE FROM classroom.lesson_pages WHERE id=${lesson}`;
    await sql`DELETE FROM classroom.quizzes WHERE id=${quiz}`;
    await sql`DELETE FROM classroom.students WHERE classroom_id=${classroom}`;
    await sql`DELETE FROM classroom.student_accounts WHERE id=ANY(${studentRows.map((row) => row.account_id)}::uuid[])`;
    await sql`DELETE FROM classroom.classrooms WHERE id=${classroom}`;
    await sql`DELETE FROM classroom.teachers WHERE id=ANY(${[teacher, outsider]}::uuid[])`;
    await sql.end();
    await rm(root, { recursive: true, force: true });
  }
}, 40000);
