import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { Client, type Room } from "@colyseus/sdk";
import { Elysia } from "elysia";

const database = process.env.CLASSROOM_TEST_DATABASE_URL;
test.skipIf(!database)("stopping a world revokes students and old tickets while retaining its teacher", async () => {
  process.env.DATABASE_URL = database!;
  process.env.DATABASE_SSL = process.env.CLASSROOM_TEST_DATABASE_SSL ?? "disable";
  process.env.APP_URL = "http://localhost:3000";
  const { sql } = await import("./db/client");
  const { galleryRoutes } = await import("./routes/gallery");
  const { handleAppError } = await import("./error-handler");
  const { createSession, createStudentSession } = await import("./auth/session");
  const app = new Elysia().onError(handleAppError).use(galleryRoutes);
  const teacher = randomUUID(), student = randomUUID(), classroom = randomUUID(), other = randomUUID(), member = randomUUID();
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = spawn("node", ["src/server.mjs"], { cwd: "gallery-server", env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  const rooms: Room[] = [];
  try {
    for (let n = 0; n < 50; n++) {
      try { if ((await fetch("http://127.0.0.1:" + port + "/__healthcheck")).ok) break; } catch {}
      await Bun.sleep(100);
    }
    await sql`INSERT INTO classroom.teachers(id,username,display_name,password_hash) VALUES(${teacher},${teacher},'Synthetic Teacher','unused')`;
    await sql`INSERT INTO classroom.student_accounts(id,email) VALUES(${student},${student + "@banjan.ac.th"})`;
    await sql`INSERT INTO classroom.classrooms(id,owner_id,name) VALUES(${classroom},${teacher},'Synthetic World'),(${other},${teacher},'Other World')`;
    await sql`INSERT INTO classroom.students(id,classroom_id,student_code,display_name,account_id) VALUES(${member},${classroom},'0001','Synthetic Student',${student})`;
    const teacherToken = await createSession(teacher), studentToken = await createStudentSession(student);
    const request = (token: string, suffix = "", method = "GET", body?: unknown, id = classroom) => app.handle(new Request("http://localhost/api/classrooms/" + id + "/gallery" + suffix, { method, headers: { cookie: "classroom_session=" + token, origin: "http://localhost:3000", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }));
    expect((await (await request(teacherToken)).json()).enabled).toBe(false);
    expect((await request(studentToken)).status).toBe(404);
    expect((await request(studentToken, "", "PUT", { enabled: true })).status).toBe(401);
    expect((await request(teacherToken, "", "PUT", { enabled: true })).status).toBe(200);
    expect((await request(studentToken)).status).toBe(200);
    expect((await request(studentToken, "/ticket", "POST", undefined, other)).status).toBe(404);
    const client = new Client("http://127.0.0.1:" + port);
    const join = async (token: string) => {
      const ticket = await (await request(token, "/ticket", "POST")).json();
      const room = await client.joinOrCreate("classroom", { classroomId: classroom, ticket: ticket.ticket }); rooms.push(room); return room;
    };
    const teacherRoom = await join(teacherToken), studentRoom = await join(studentToken);
    const studentCast = new Promise<{ ok: boolean }>((resolve) => studentRoom.onMessage("cast-result", resolve));
    studentRoom.send("cast", { shotId: randomUUID(), dx: 0, dy: 0, dz: 1 });
    expect((await Promise.race([studentCast, Bun.sleep(2000).then(() => ({ ok: true }))])).ok).toBe(false);
    const teacherCasts: { ok: boolean }[] = [];
    const teacherCastResults = new Promise<{ ok: boolean }[]>((resolve) => teacherRoom.onMessage("cast-result", (value: { ok: boolean }) => { teacherCasts.push(value); if (teacherCasts.length === 2) resolve(teacherCasts); }));
    const shotId = randomUUID();
    teacherRoom.send("cast", { shotId, dx: 0, dy: 0, dz: -1 });
    teacherRoom.send("cast", { shotId, dx: 0, dy: 0, dz: -1 });
    const outcomes = await Promise.race([teacherCastResults, Bun.sleep(3000).then(() => [])]);
    expect(outcomes.map((result) => result.ok).sort()).toEqual([false, true]);
    const stale = await (await request(studentToken, "/ticket", "POST")).json();
    const departed = new Promise<number>((resolve) => studentRoom.onLeave(resolve));
    expect((await request(teacherToken, "", "PUT", { enabled: false })).status).toBe(200);
    expect(await Promise.race([departed, Bun.sleep(4000).then(() => -1)])).toBe(4403);
    expect(teacherRoom.connection.isOpen).toBe(true);
    expect((await request(studentToken, "/ticket", "POST")).status).toBe(404);
    expect((await request(studentToken, "/files/" + randomUUID() + "/content")).status).toBe(404);
    await expect(client.joinOrCreate("classroom", { classroomId: classroom, ticket: stale.ticket })).rejects.toThrow();
    expect((await (await request(teacherToken)).json()).enabled).toBe(false);
    await teacherRoom.leave();
    const inspecting = await join(teacherToken);
    expect(inspecting.connection.isOpen).toBe(true);
    expect((await request(teacherToken, "", "PUT", { enabled: true })).status).toBe(200);
    const rejoined = await join(studentToken);
    expect(rejoined.connection.isOpen).toBe(true);
  } finally {
    await Promise.all(rooms.filter((room) => room.connection.isOpen).map((room) => room.leave()));
    server.kill("SIGTERM"); if (server.exitCode === null) await once(server, "exit");
    await sql`DELETE FROM classroom.students WHERE classroom_id IN (${classroom},${other})`;
    await sql`DELETE FROM classroom.classrooms WHERE id IN (${classroom},${other})`;
    await sql`DELETE FROM classroom.student_accounts WHERE id=${student}`;
    await sql`DELETE FROM classroom.teachers WHERE id=${teacher}`;
  }
}, 20000);
