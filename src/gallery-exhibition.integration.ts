import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, type Room } from "@colyseus/sdk";
import { Elysia } from "elysia";
import { BLOCK_DEPTH, blockPosition } from "../gallery-server/src/train-layout.mjs";
import { portal } from "../gallery-server/src/world-places.mjs";

const database = process.env.CLASSROOM_TEST_DATABASE_URL;

test.skipIf(!database)("group exhibitions use individual uploads and switch only at a safe train stop", async () => {
  const origin = "http://localhost:3000";
  const uploads = await mkdtemp(join(tmpdir(), "classroom-exhibition-"));
  Object.assign(process.env, { DATABASE_URL: database!, DATABASE_SSL: "disable", APP_URL: origin, UPLOAD_DIR: uploads });
  const { sql } = await import("./db/client");
  const { createSession, createStudentSession } = await import("./auth/session");
  const { galleryRoutes } = await import("./routes/gallery");
  const { courseworkRoutes } = await import("./routes/coursework");
  const { studentCourseworkRoutes } = await import("./routes/student-coursework");
  const { groupSetRoutes } = await import("./routes/group-sets");
  const { handleAppError } = await import("./error-handler");
  const app = new Elysia().onError(handleAppError).use(galleryRoutes).use(courseworkRoutes).use(studentCourseworkRoutes).use(groupSetRoutes);
  const [teacher, foreignTeacher, roomId, foreignRoom, setId, foreignSet, draftSet, teamA, teamB,
    first, second, visitor, firstRow, secondRow, visitorRow] = Array.from({ length: 15 }, () => crypto.randomUUID());
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const ws = "http://127.0.0.1:" + port;
  const server = spawn("node", ["src/server.mjs"], { cwd: "gallery-server", env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  let room: Room | undefined;
  const waitFor = async (condition: () => boolean | Promise<boolean>, limit = 7500) => {
    const end = Date.now() + limit;
    while (Date.now() < end) {
      if (await condition()) return;
      await Bun.sleep(70);
    }
    throw new Error("Timed out waiting for world state");
  };
  try {
    await waitFor(() => fetch(ws + "/__healthcheck").then((r) => r.ok).catch(() => false));
    expect(await fetch(ws + "/__gallery_protocol").then((r) => r.text())).toBe("team-exhibition-v1");
    await sql`INSERT INTO classroom.teachers(id,username,display_name,password_hash)
      VALUES(${teacher},${teacher},'Exhibition Teacher','unused'),(${foreignTeacher},${foreignTeacher},'Foreign Teacher','unused')`;
    await sql`INSERT INTO classroom.classrooms(id,owner_id,name)
      VALUES (${roomId},${teacher},'Exhibition Class'),(${foreignRoom},${foreignTeacher},'Other Class')`;
    await sql`INSERT INTO classroom.gallery_worlds(classroom_id,enabled,train_mode,train_station_wait_seconds)
      VALUES (${roomId},true,'manual','{"entrance":3,"row-1":3}')`;
    await sql`INSERT INTO classroom.group_sets(id,classroom_id,title,student_limit,status)
      VALUES (${setId},${roomId},'Teams',3,'open'),(${draftSet},${roomId},'Draft Teams',3,'draft'),(${foreignSet},${foreignRoom},'Other Teams',3,'locked')`;
    await sql`INSERT INTO classroom.student_groups(id,classroom_id,group_set_id,name,created_at)
      VALUES (${teamA},${roomId},${setId},'Blue Team',NOW()),(${teamB},${roomId},${setId},'Green Team',NOW()+INTERVAL '1 second')`;
    await sql`INSERT INTO classroom.student_accounts(id,email) VALUES
      (${first},${first + "@banjan.ac.th"}),(${second},${second + "@banjan.ac.th"}),(${visitor},${visitor + "@banjan.ac.th"})`;
    await sql`INSERT INTO classroom.students(id,classroom_id,student_number,display_name,account_id) VALUES
      (${firstRow},${roomId},3,'Model Author One',${first}),(${secondRow},${roomId},1,'Model Author Two',${second}),(${visitorRow},${roomId},2,'Exhibition Visitor',${visitor})`;
    await sql`INSERT INTO classroom.group_memberships(group_set_id,classroom_id,group_id,student_id) VALUES
      (${setId},${roomId},${teamA},${firstRow}),(${setId},${roomId},${teamA},${secondRow})`;
    const teacherSession = await createSession(teacher), foreignSession = await createSession(foreignTeacher);
    const firstSession = await createStudentSession(first), secondSession = await createStudentSession(second), visitorSession = await createStudentSession(visitor);
    const api = (path: string, session = teacherSession, method = "GET", body?: Record<string, unknown> | FormData) => {
      const headers = new Headers({ origin, cookie: "classroom_session=" + session });
      if (body && !(body instanceof FormData)) headers.set("Content-Type", "application/json");
      return app.handle(new Request(origin + "/api" + path, { method, headers, body: body instanceof FormData ? body : body && JSON.stringify(body) }));
    };
    const classPath = "/classrooms/" + roomId, assignmentPath = classPath + "/assignments", galleryPath = classPath + "/gallery";
    const setExhibition = (assignmentId: string | null, session = teacherSession) => api(galleryPath + "/exhibition", session, "PUT", { assignmentId });
    const newAssignment = (title: string, groupSetId?: string) => api(assignmentPath, teacherSession, "POST", { title, groupSetId });
    expect((await newAssignment("Foreign", foreignSet)).status).toBe(422);
    expect((await newAssignment("Draft", draftSet)).status).toBe(422);
    const personal = await (await newAssignment("Earlier work")).json();
    const groupAssignment = await newAssignment("Team project", setId);
    expect(groupAssignment.status).toBe(200);
    const { id: groupId } = await groupAssignment.json();
    expect((await api(assignmentPath + "/" + groupId, teacherSession, "PATCH", { title: "Team project revised" })).status).toBe(200);
    expect((await api("/student/assignments", firstSession).then((r) => r.json()))[0]).toMatchObject({ assignmentId: groupId, groupSetId: setId, groupName: "Blue Team" });
    expect((await api("/student/assignments", visitorSession).then((r) => r.json()))[0]).toMatchObject({ groupSetId: setId, groupName: null });

    async function upload(assignmentId: string, session: string, name: string) {
      const form = new FormData();
      form.set("file", new File(["v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"], name));
      const response = await api("/student" + assignmentPath + "/" + assignmentId + "/files", session, "POST", form);
      expect(response.status).toBe(200);
      return (await response.json()).id as string;
    }
    const before = await upload(personal.id, firstSession, "previous.obj");
    const one = await upload(groupId, firstSession, "one.obj"), two = await upload(groupId, secondSession, "two.obj");
    const unassigned = await upload(groupId, visitorSession, "unassigned.obj");
    const assessment = assignmentPath + "/" + groupId + "/students/" + firstRow + "/assessment";
    const draft = await api(assessment, teacherSession, "PUT", { score: 87.5, feedback: "Synthetic review", reviewedFileIds: [one], revision: 0 });
    expect(draft.status).toBe(200);
    expect((await api(assessment + "/publish", teacherSession, "POST", { revision: 1 })).status).toBe(200);
    expect((await api("/student/files/" + one + "/content", visitorSession)).status).toBe(404);
    expect((await api(galleryPath + "/files/" + one + "/content", visitorSession)).status).toBe(200);
    expect((await api(galleryPath + "/files/" + one + "/like", visitorSession, "PUT")).status).toBe(200);
    expect((await setExhibition(groupId, visitorSession)).status).toBe(401);
    expect((await setExhibition(groupId, foreignSession)).status).toBe(404);
    expect((await setExhibition(personal.id)).status).toBe(422);

    const { ticket } = await api(galleryPath + "/ticket", teacherSession, "POST").then((r) => r.json());
    room = await new Client(ws).joinOrCreate("classroom", { classroomId: roomId, ticket });
    room.onMessage("*", () => {});
    const train = () => (room!.state as any).train;
    await waitFor(() => train()?.active === true);
    expect(JSON.parse(train().layoutRoster).map((space: { studentId: string }) => space.studentId)).toEqual([secondRow, visitorRow, firstRow]);
    room.send("train-start", { revision: train().revision });
    await waitFor(() => train().phase === "moving");
    expect((await setExhibition(groupId)).status).toBe(200);
    const manifest = (token = visitorSession) => api(galleryPath, token).then((r) => r.json());
    const pending = await manifest();
    expect(pending.exhibition).toMatchObject({ requested: groupId, displayed: null });
    expect(pending.models.map((file: { id: string }) => file.id)).toContain(before);
    expect(train().exhibitionAssignmentId).toBe("");
    await waitFor(() => train().exhibitionAssignmentId === groupId, 16000);
    expect(train()).toMatchObject({ phase: "waiting", stopId: "entrance", startStudentId: "" });
    const shown = await manifest();
    expect(shown.blocks).toMatchObject([{ spaceId: teamA, displayName: "Blue Team" }]);
    expect(shown.models).toMatchObject([{ id: two, spaceId: teamA, studentId: secondRow }, { id: one, spaceId: teamA, studentId: firstRow, likes: 1 }]);
    expect(shown.models[1]).not.toHaveProperty("publishedScore");
    const player = () => (room!.state as any).players.get(room!.sessionId);
    for (let step = 0; step < 50; step++) {
      const { x, z, sequence, movementEpoch } = player();
      const dx = portal.x - x, dz = portal.z - z, distance = Math.hypot(dx, dz);
      if (distance <= 2.5) break;
      const speed = Math.min(1, 0.5 / distance);
      room.send("move", { dx: dx * speed, dz: dz * speed, sequence: sequence + 1, movementEpoch });
      await Bun.sleep(120);
    }
    room.send("teleport");
    const pavilion = blockPosition(0);
    await waitFor(() => player().x === pavilion.x && player().z === pavilion.z + BLOCK_DEPTH / 2 + 1.5);
    expect((await api(galleryPath + "/files/" + before + "/content", visitorSession)).status).toBe(404);
    expect((await api(galleryPath + "/files/" + before + "/like", visitorSession, "PUT")).status).toBe(404);
    expect((await api(galleryPath + "/files/" + unassigned + "/content", visitorSession)).status).toBe(404);
    expect((await api(galleryPath + "/files/" + unassigned + "/visibility", teacherSession, "PUT", { hidden: true })).status).toBe(200);

    const remaining = await upload(groupId, firstSession, "new-work.obj");
    expect((await manifest()).models).toContainEqual(expect.objectContaining({ id: remaining, spaceId: teamA, studentId: firstRow }));
    await sql`INSERT INTO classroom.group_memberships(group_set_id,classroom_id,group_id,student_id) VALUES (${setId},${roomId},${teamB},${visitorRow})`;
    await sql`UPDATE classroom.group_memberships SET group_id=${teamB} WHERE student_id=${firstRow} AND group_set_id=${setId}`;
    await sql`UPDATE classroom.student_groups SET name='New Green Team' WHERE id=${teamB}`;
    await waitFor(() => JSON.parse(train().layoutRoster).some((space: { displayName: string }) => space.displayName === "New Green Team"));
    expect((await manifest()).models).toContainEqual(expect.objectContaining({ id: one, spaceId: teamB, studentId: firstRow, likes: 1 }));
    expect((await manifest()).models.map((file: { id: string }) => file.id)).not.toContain(unassigned);
    expect((await manifest(teacherSession)).models).toContainEqual(expect.objectContaining({ id: unassigned, spaceId: teamB, hidden: true }));
    expect((await api("/student/assignments", firstSession).then((r) => r.json()))[0]).toMatchObject({ groupName: "New Green Team" });

    await sql`UPDATE classroom.group_sets SET status='archived' WHERE id=${setId}`;
    expect((await manifest()).exhibition).toMatchObject({ requested: null, displayed: groupId });
    expect((await api(galleryPath + "/files/" + one + "/content", visitorSession)).status).toBe(404);
    await waitFor(() => train().exhibitionAssignmentId === "");
    expect((await manifest()).exhibition).toMatchObject({ requested: null, displayed: null });
    expect((await manifest()).models).toContainEqual(expect.objectContaining({ id: one, spaceId: firstRow, likes: 1 }));
    expect((await api("/student/files/" + one + "/content", firstSession)).status).toBe(200);
    expect((await api("/student/assignments", firstSession).then((r) => r.json()))[0]).toMatchObject({ publishedScore: "87.50", publishedFeedback: "Synthetic review" });

    await sql`UPDATE classroom.group_sets SET status='locked' WHERE id=${setId}`;
    expect((await setExhibition(groupId)).status).toBe(200);
    expect((await api(assignmentPath + "/" + groupId, teacherSession, "PATCH", { archived: true })).status).toBe(200);
    expect((await api(assignmentPath + "/" + groupId, teacherSession, "PATCH", { archived: false })).status).toBe(200);
    expect((await manifest()).exhibition.requested).toBeNull();
    expect((await setExhibition(groupId)).status).toBe(200);
    expect((await api(assignmentPath + "/" + groupId, teacherSession, "PATCH", { groupSetId: null })).status).toBe(200);
    expect((await manifest()).exhibition.requested).toBeNull();
  } finally {
    if (room?.connection.isOpen) await room.leave();
    server.kill("SIGTERM");
    if (server.exitCode === null) await once(server, "exit");
    await sql`DELETE FROM classroom.assignments WHERE classroom_id IN (${roomId},${foreignRoom})`;
    await sql`DELETE FROM classroom.students WHERE classroom_id IN (${roomId},${foreignRoom})`;
    await sql`DELETE FROM classroom.classrooms WHERE id IN (${roomId},${foreignRoom})`;
    await sql`DELETE FROM classroom.student_accounts WHERE id IN (${first},${second},${visitor})`;
    await sql`DELETE FROM classroom.teachers WHERE id IN (${teacher},${foreignTeacher})`;
    await rm(uploads, { recursive: true, force: true });
  }
}, 45000);
