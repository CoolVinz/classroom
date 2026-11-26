import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { Client, type Room } from "@colyseus/sdk";
import { Elysia } from "elysia";
import { defaultPatrolSettings, jailCell, jailGate } from "../gallery-server/src/patrol.mjs";
import { depot, portal, shop } from "../gallery-server/src/world-places.mjs";

const database = process.env.CLASSROOM_TEST_DATABASE_URL;
test.skipIf(!database)("checks gallery admission, rides, and patrol in a live room", async () => {
  process.env.DATABASE_URL = database!;
  process.env.DATABASE_SSL = process.env.CLASSROOM_TEST_DATABASE_SSL ?? "disable";
  process.env.APP_URL = "http://localhost:3000";
  const uploadDir = await mkdtemp(joinPath(tmpdir(), "classroom-gallery-test-"));
  process.env.UPLOAD_DIR = uploadDir;
  const { sql } = await import("./db/client");
  const { galleryRoutes } = await import("./routes/gallery");
  const { studentCourseworkRoutes } = await import("./routes/student-coursework");
  const { handleAppError } = await import("./error-handler");
  const { createSession, createStudentSession } = await import("./auth/session");
  const app = new Elysia().onError(handleAppError).use(galleryRoutes).use(studentCourseworkRoutes);
  const teacher = randomUUID(), student = randomUUID(), classroom = randomUUID(), other = randomUUID(), member = randomUUID(), assignment = randomUUID(), nextAssignment = randomUUID();
  const foreignTeacher = randomUUID(), peer = randomUUID(), peerMember = randomUUID(), otherMember = randomUUID(), otherAssignment = randomUUID();
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
    await sql`INSERT INTO classroom.teachers(id,username,display_name,password_hash)
      VALUES(${teacher},${teacher},'Synthetic Teacher','unused'),(${foreignTeacher},${foreignTeacher},'Outside Teacher','unused')`;
    await sql`INSERT INTO classroom.student_accounts(id,email) VALUES(${student},${student + "@banjan.ac.th"})`;
    await sql`INSERT INTO classroom.classrooms(id,owner_id,name) VALUES(${classroom},${teacher},'Synthetic World'),(${other},${teacher},'Other World')`;
    await sql`INSERT INTO classroom.students(id,classroom_id,student_code,student_number,display_name,account_id) VALUES(${member},${classroom},'0001',1,'Synthetic Student',${student})`;
    await sql`INSERT INTO classroom.assignments(id,classroom_id,title) VALUES(${assignment},${classroom},'Synthetic current assignment')`;
    const teacherToken = await createSession(teacher), studentToken = await createStudentSession(student);
    const studentHeaders = { cookie: "classroom_session=" + studentToken, origin: "http://localhost:3000" };
    const worldStatus = async () => (await app.handle(new Request("http://localhost/api/student/worlds", { headers: studentHeaders }))).json();
    const request = (token: string, suffix = "", method = "GET", body?: unknown, id = classroom) => app.handle(new Request("http://localhost/api/classrooms/" + id + "/gallery" + suffix, { method, headers: { cookie: "classroom_session=" + token, origin: "http://localhost:3000", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }));
    const client = new Client("http://127.0.0.1:" + port);
    const join = async (token: string, roomId = classroom) => {
      for (let attempt = 0; ; attempt++) {
        const response = await request(token, "/ticket", "POST", undefined, roomId);
        expect(response.status).toBe(200);
        const { ticket } = await response.json();
        try {
          const room = await client.joinOrCreate("classroom", { classroomId: roomId, ticket });
          rooms.push(room);
          for (let patch = 0; patch < 80 && !(room.state as any)?.players?.has(room.sessionId); patch++) await Bun.sleep(25);
          expect((room.state as any)?.players?.has(room.sessionId)).toBe(true);
          return room;
        } catch (error) {
          if ((error as { code?: number }).code !== 4009 || attempt >= 15) throw error;
          // The leave reply can arrive just before Colyseus removes the previous session.
          await Bun.sleep(80);
        }
      }
    };
    const initialManifest = await (await request(teacherToken)).json();
    expect(initialManifest.enabled).toBe(false);
    expect(initialManifest.shop).toEqual({ wand: 5, license: 10 });
    expect(initialManifest.patrol).toEqual(defaultPatrolSettings);
    const patrolSettings = { ...defaultPatrolSettings, car: 1, broom: 4, baseSeconds: 5, extraSeconds: 2, maxSeconds: 10, helicopterFuelSeconds: 14, broomFuelSeconds: 5 };
    expect((await request(studentToken, "/patrol", "PUT", patrolSettings)).status).toBe(401);
    expect((await request(await createSession(foreignTeacher), "/patrol", "PUT", patrolSettings)).status).toBe(404);
    expect((await request(teacherToken, "/patrol", "PUT", { ...patrolSettings, helicopter: 21 })).status).toBe(422);
    expect((await request(teacherToken, "/patrol", "PUT", { ...patrolSettings, baseSeconds: 20 })).status).toBe(422);
    expect((await request(teacherToken, "/patrol", "PUT", { ...patrolSettings, helicopterFuelSeconds: 4 })).status).toBe(422);
    expect((await request(teacherToken, "/patrol", "PUT", { ...patrolSettings, broomFuelSeconds: 181 })).status).toBe(422);
    expect(await (await request(teacherToken, "/patrol", "PUT", patrolSettings)).json()).toEqual(patrolSettings);
    const { helicopterFuelSeconds, broomFuelSeconds, ...olderPatrolSettings } = patrolSettings;
    expect(await (await request(teacherToken, "/patrol", "PUT", olderPatrolSettings)).json()).toMatchObject({ helicopterFuelSeconds, broomFuelSeconds });
    expect((await (await request(teacherToken, "", "GET", undefined, other)).json()).patrol).toEqual(defaultPatrolSettings);
    expect((await (await request(teacherToken)).json()).patrol).toEqual(patrolSettings);
    expect((await request(studentToken, "/santa", "PUT", { fuseSeconds: 1, respawnSeconds: 10 })).status).toBe(401);
    expect((await request(teacherToken, "/santa", "PUT", { fuseSeconds: 0, respawnSeconds: 10 })).status).toBe(422);
    expect(await (await request(teacherToken, "/santa", "PUT", { fuseSeconds: 1, respawnSeconds: 10 })).json()).toEqual({ ok: true, fuseSeconds: 1, respawnSeconds: 10 });
    expect((await request(studentToken, "/shop", "PUT", { wand: 5, license: 10 })).status).toBe(401);
    expect((await request(teacherToken, "/shop", "PUT", { wand: 0, license: 10 })).status).toBe(422);
    expect(initialManifest.train).toEqual({ mode: "auto", intervalSeconds: 120, startStudentId: null, stationWaitSeconds: {} });
    expect(initialManifest.blocks[0]).toMatchObject({ studentId: member, studentNumber: 1, layoutIndex: 0 });
    const entrySettings = await (await request(teacherToken, "/access")).json();
    expect(entrySettings).toMatchObject({ mode: "submission", requiredAssignmentId: assignment, requiredAssignmentTitle: "Synthetic current assignment" });
    expect((await request(studentToken)).status).toBe(404);
    expect((await request(studentToken, "", "PUT", { enabled: true })).status).toBe(401);
    expect((await request(teacherToken, "", "PUT", { enabled: true })).status).toBe(200);
    expect((await request(studentToken)).status).toBe(403);
    expect((await request(studentToken, "/ticket", "POST")).status).toBe(403);
    await sql`INSERT INTO classroom.files(classroom_id,assignment_id,student_id,uploaded_by,kind,original_name,storage_name,media_type,size_bytes) VALUES(${classroom},${assignment},${member},${teacher},'model','teacher.obj',${randomUUID()},'model/obj',12)`;
    await sql`INSERT INTO classroom.files(classroom_id,assignment_id,student_id,uploaded_by,kind,original_name,storage_name,media_type,size_bytes) VALUES(${classroom},${assignment},${member},NULL,'working','student.blend',${randomUUID()},'application/octet-stream',12)`;
    expect((await request(studentToken)).status).toBe(403);
    expect((await request(teacherToken, `/access/${member}`, "PUT", { assignmentId: assignment, approved: true })).status).toBe(400);
    expect(await worldStatus()).toMatchObject([{ classroomId: classroom, requiredAssignmentId: assignment, hasSubmission: false, entryAllowed: false }]);
    const form = new FormData();
    form.set("file", new File(["v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"], "student.obj"));
    const upload = await app.handle(new Request(`http://localhost/api/student/classrooms/${classroom}/assignments/${assignment}/files`, { method: "POST", headers: studentHeaders, body: form }));
    expect(upload.status).toBe(200);
    const { id: uploadedModel } = await upload.json();
    expect(await sql`SELECT kind FROM classroom.files WHERE id=${uploadedModel}`).toMatchObject([{ kind: "model" }]);
    expect(await worldStatus()).toMatchObject([{ classroomId: classroom, hasSubmission: true, entryAllowed: true }]);
    await (await join(studentToken)).leave();
    expect((await request(teacherToken, "/access", "PUT", { mode: "approval" })).status).toBe(200);
    expect(await worldStatus()).toMatchObject([{ classroomId: classroom, entryMode: "approval", hasSubmission: true, approved: false, entryAllowed: false }]);
    expect((await request(studentToken, "/ticket", "POST")).status).toBe(403);
    expect((await request(teacherToken, `/access/${member}`, "PUT", { assignmentId: assignment, approved: true })).status).toBe(200);
    expect((await request(studentToken)).status).toBe(200);
    await sql`INSERT INTO classroom.assignments(id,classroom_id,title,created_at) VALUES(${nextAssignment},${classroom},'New current assignment',NOW() + INTERVAL '1 second')`;
    expect((await request(studentToken)).status).toBe(403);
    expect((await request(teacherToken, `/access/${member}`, "PUT", { assignmentId: assignment, approved: true })).status).toBe(409);
    await sql`INSERT INTO classroom.files(classroom_id,assignment_id,student_id,uploaded_by,kind,original_name,storage_name,media_type,size_bytes,submitted_by_account_id) VALUES(${classroom},${nextAssignment},${member},NULL,'submission','synthetic-final.pdf',${randomUUID()},'application/pdf',12,${student})`;
    expect((await request(studentToken)).status).toBe(403);
    expect((await request(teacherToken, `/access/${member}`, "PUT", { assignmentId: nextAssignment, approved: true })).status).toBe(200);
    expect((await request(studentToken)).status).toBe(200);
    await sql`UPDATE classroom.assignments SET archived_at=NOW() WHERE id=${nextAssignment}`;
    const fallback = await (await request(teacherToken, "/access")).json();
    expect(fallback.requiredAssignmentId).toBe(assignment);
    expect((await request(studentToken)).status).toBe(200);
    const currentAssignment = assignment;
    expect((await request(studentToken, "/train", "PUT", { mode: "manual", intervalSeconds: 60, startStudentId: member })).status).toBe(401);
    const waits = { entrance: 5, "row-1": 7 };
    expect((await request(teacherToken, "/train", "PUT", { mode: "manual", intervalSeconds: 60, startStudentId: member, stationWaitSeconds: waits })).status).toBe(200);
    const configured = await (await request(teacherToken)).json();
    expect(configured.train).toEqual({ mode: "manual", intervalSeconds: 60, startStudentId: member, stationWaitSeconds: waits });
    expect((await request(teacherToken, "/train", "PUT", { mode: "auto", intervalSeconds: 30, startStudentId: member })).status).toBe(422);
    expect((await request(teacherToken, "/train", "PUT", { mode: "manual", intervalSeconds: 60, stationWaitSeconds: { entrance: 2 } })).status).toBe(422);
    expect((await request(teacherToken, "/train", "PUT", { mode: "manual", intervalSeconds: 60, stationWaitSeconds: { "row-2": 12 } })).status).toBe(400);
    expect((await (await request(teacherToken, "", "GET", undefined, other)).json()).train.stationWaitSeconds).toEqual({});
    await request(teacherToken, "/train", "PUT", { mode: "manual", intervalSeconds: 60, startStudentId: null });
    expect((await request(studentToken, "/ticket", "POST", undefined, other)).status).toBe(404);
    const teacherRoom = await join(teacherToken), studentRoom = await join(studentToken);
    const scene = (room: Room) => room.state as any;
    const rider = (room: Room) => scene(room).players.get(room.sessionId);
    const train = scene(teacherRoom).train;
    const waitFor = async (condition: () => boolean, limit = 4000) => {
      const deadline = Date.now() + limit;
      while (!condition() && Date.now() < deadline) await Bun.sleep(30);
      expect(condition()).toBe(true);
    };
    const command = async (room: Room, action: string, resultName: string, message?: object) => {
      let stopListening = () => {};
      const result = new Promise<any>((resolve) => { stopListening = room.onMessage(resultName, resolve); });
      room.send(action, message);
      try {
        const value = await Promise.race([result, Bun.sleep(3000).then(() => null)]);
        expect(value).not.toBeNull();
        return value;
      } finally { stopListening(); }
    };
    const vehicleCommand = async (room: Room, action: string, kind: string, confirmedDriverId?: string) => {
      const vehicle = scene(room).vehicles.get(kind);
      const result = new Promise<{ ok: boolean }>((resolve) => room.onMessage("vehicle-result", resolve));
      room.send("vehicle-" + action, { kind, revision: vehicle?.revision ?? 0, confirmedDriverId: confirmedDriverId ?? vehicle?.driverId ?? "" });
      return (await Promise.race([result, Bun.sleep(2000).then(() => null)]))?.ok;
    };
    const moveTo = async (room: Room, x: number, z: number) => {
      for (let step = 0; step < 110; step++) {
        const player = rider(room);
        const dx = x - player.x, dz = z - player.z, distance = Math.hypot(dx, dz);
        if (distance < 0.35) return;
        const scale = Math.min(1, 0.5 / distance);
        room.send("move", { dx: dx * scale, dz: dz * scale, sequence: player.sequence + 1, movementEpoch: player.movementEpoch });
        await Bun.sleep(120);
      }
      throw new Error("Could not move the synthetic avatar");
    };
    expect(train?.active).toBe(true);
    expect(await vehicleCommand(studentRoom, "reset", "bike")).toBe(false);
    expect(await vehicleCommand(teacherRoom, "reset", "car")).toBe(false);
    const trainStartResult = new Promise<{ ok: boolean }>((resolve) => teacherRoom.onMessage("train-result", resolve));
    teacherRoom.send("train-start", { revision: train.revision });
    expect((await Promise.race([trainStartResult, Bun.sleep(2000).then(() => ({ ok: false }))])).ok).toBe(true);
    await waitFor(() => train.phase === "boarding");
    const departure = train.departureAt;
    expect(departure - Date.now()).toBeGreaterThan(4500);
    await Bun.sleep(550);
    const boardResult = new Promise<{ ok: boolean }>((resolve) => teacherRoom.onMessage("train-result", resolve));
    teacherRoom.send("train-board", { revision: train.revision });
    expect((await Promise.race([boardResult, Bun.sleep(2000).then(() => ({ ok: false }))])).ok).toBe(true);
    await Bun.sleep(300);
    const duplicateBoard = new Promise<{ ok: boolean }>((resolve) => teacherRoom.onMessage("train-result", resolve));
    teacherRoom.send("train-board", { revision: train.revision });
    expect((await Promise.race([duplicateBoard, Bun.sleep(2000).then(() => ({ ok: true }))])).ok).toBe(false);
    await Bun.sleep(300);
    const leaveResult = new Promise<{ ok: boolean }>((resolve) => teacherRoom.onMessage("train-result", resolve));
    teacherRoom.send("train-leave", { revision: train.revision });
    expect((await Promise.race([leaveResult, Bun.sleep(2000).then(() => ({ ok: false }))])).ok).toBe(true);
    const studentCast = new Promise<{ ok: boolean }>((resolve) => studentRoom.onMessage("cast-result", resolve));
    studentRoom.send("cast", { shotId: randomUUID(), dx: 0, dy: 0, dz: 1 });
    expect((await Promise.race([studentCast, Bun.sleep(2000).then(() => ({ ok: true }))])).ok).toBe(false);
    expect((await request(teacherToken, "/train", "PUT", { mode: "manual", intervalSeconds: 60, stationWaitSeconds: { entrance: 3, "row-1": 4 } })).status).toBe(200);
    expect(train.departureAt).toBe(departure);
    await moveTo(studentRoom, 0, -4);
    await waitFor(() => rider(studentRoom).knockCause === "train", 6500);
    const respawnAt = rider(studentRoom).respawnAt;
    await studentRoom.leave();
    const afterTrainHit = await join(studentToken);
    expect(rider(afterTrainHit)).toMatchObject({ knocked: true, knockCause: "train", respawnAt });
    await waitFor(() => scene(teacherRoom).train.phase === "dwell");
    expect(train.departureAt - train.arrivalAt).toBe(7000);
    await waitFor(() => !rider(afterTrainHit).knocked, 11000);
    expect(rider(afterTrainHit)).toMatchObject({ x: -8, z: 11 });
    expect(rider(afterTrainHit).protectedUntil).toBeGreaterThan(Date.now());

    await sql`UPDATE classroom.teachers SET role='owner' WHERE id=${teacher}`;
    expect(await vehicleCommand(teacherRoom, "reset", "car")).toBe(true);
    await waitFor(() => scene(afterTrainHit).vehicles.has("car"));
    expect(await vehicleCommand(afterTrainHit, "enter", "car")).toBe(false);
    await Promise.all([moveTo(teacherRoom, 11, 11), moveTo(afterTrainHit, 12, 11)]);
    expect(await vehicleCommand(teacherRoom, "enter", "car")).toBe(true);
    expect(await vehicleCommand(afterTrainHit, "enter", "car")).toBe(false);
    await waitFor(() => Boolean(scene(teacherRoom).vehicles.get("car").driverId));
    const driver = teacherRoom;
    await waitFor(() => rider(driver).vehicleId === "car");
    const car = scene(driver).vehicles.get("car");
    const initialZ = car.z;
    for (let step = 0; step < 6; step++) {
      driver.send("vehicle-input", { revision: car.revision, epoch: rider(driver).movementEpoch, throttle: 1, turn: 0, lift: 0 });
      await Bun.sleep(80);
    }
    await waitFor(() => car.z < initialZ - 1);
    await Bun.sleep(450);
    const stoppedZ = car.z;
    await Bun.sleep(250);
    expect(car.z).toBe(stoppedZ);
    expect(await vehicleCommand(teacherRoom, "reset", "car", "")).toBe(false);
    await Bun.sleep(320);
    expect(await vehicleCommand(teacherRoom, "reset", "car")).toBe(true);
    await waitFor(() => !rider(driver).vehicleId);
    expect(rider(driver)).toMatchObject({ x: 14.5, z: 11 });
    await Bun.sleep(320);
    expect(await vehicleCommand(teacherRoom, "reset", "helicopter")).toBe(true);
    await sql`UPDATE classroom.teachers SET role='teacher' WHERE id=${teacher}`;
    await Bun.sleep(320);
    expect(await vehicleCommand(teacherRoom, "reset", "bike")).toBe(false);
    const { ticket: preRevocationTicket } = await (await request(studentToken, "/ticket", "POST")).json();
    const revoked = new Promise<number>((resolve) => afterTrainHit.onLeave(resolve));
    expect((await request(teacherToken, `/access/${member}`, "PUT", { assignmentId: currentAssignment, approved: false })).status).toBe(200);
    afterTrainHit.send("refresh-avatar");
    expect(await Promise.race([revoked, Bun.sleep(3000).then(() => -1)])).toBe(4003);
    expect((await request(studentToken, "/ticket", "POST")).status).toBe(403);
    await expect(client.joinOrCreate("classroom", { classroomId: classroom, ticket: preRevocationTicket })).rejects.toThrow();
    expect((await request(teacherToken, `/access/${member}`, "PUT", { assignmentId: currentAssignment, approved: true })).status).toBe(200);
    let studentRoomAgain = await join(studentToken);
    expect(studentRoomAgain.connection.isOpen).toBe(true);
    const santaStarted = new Promise<{ ok: boolean; enabled: boolean }>((resolve) => teacherRoom.onMessage("santa-result", resolve));
    teacherRoom.send("santa-toggle", { enabled: true });
    expect(await Promise.race([santaStarted, Bun.sleep(2500).then(() => ({ ok: false, enabled: false }))])).toMatchObject({ ok: true, enabled: true });
    await waitFor(() => scene(studentRoomAgain).santa.enabled === true);
    await waitFor(() => scene(studentRoomAgain).presents.size > 0, 10500);
    const present = [...scene(studentRoomAgain).presents.values()][0];
    expect(present).not.toHaveProperty("kind");
    const deniedOpen = new Promise<{ ok: boolean }>((resolve) => teacherRoom.onMessage("present-result", resolve));
    teacherRoom.send("open-present", { id: present.id });
    expect(await Promise.race([deniedOpen, Bun.sleep(1500).then(() => ({ ok: true }))])).toMatchObject({ ok: false });
    await moveTo(studentRoomAgain, present.x, present.z);
    const failedDuplicate = new Promise<{ ok: boolean }>((resolve) => studentRoomAgain.onMessage("present-result", resolve));
    const foundGift = new Promise<{ kind: "bomb" | "points"; balance?: number; detonateAt?: number }>((resolve) => studentRoomAgain.onMessage("gift-result", resolve));
    const openedAt = Date.now();
    studentRoomAgain.send("open-present", { id: present.id });
    studentRoomAgain.send("open-present", { id: present.id });
    const duplicateResult = await Promise.race([failedDuplicate, Bun.sleep(2000).then(() => null)]);
    expect(duplicateResult?.ok).toBe(false);
    const giftResult = await Promise.race([foundGift, Bun.sleep(2500).then(() => null)]);
    expect(giftResult?.kind === "bomb" || giftResult?.kind === "points").toBe(true);
    if (giftResult?.kind === "points") {
      expect(giftResult.balance).toBe(1);
      expect(await (await app.handle(new Request("http://localhost/api/student/gallery-points", { headers: studentHeaders }))).json()).toEqual({ balance: 1 });
    } else {
      expect(giftResult?.detonateAt).toBeGreaterThanOrEqual(openedAt + 1000);
      expect(giftResult?.detonateAt).toBeLessThan(openedAt + 1550);
      await waitFor(() => rider(studentRoomAgain).knockCause === "santa", 7000);
      expect(rider(studentRoomAgain).respawnAt).toBeGreaterThan(Date.now());
    }
    const santaStopped = new Promise<{ ok: boolean; enabled: boolean }>((resolve) => teacherRoom.onMessage("santa-result", resolve));
    teacherRoom.send("santa-toggle", { enabled: false });
    expect(await Promise.race([santaStopped, Bun.sleep(2500).then(() => ({ ok: false, enabled: true }))])).toMatchObject({ ok: true, enabled: false });
    await waitFor(() => !scene(studentRoomAgain).santa.enabled && scene(studentRoomAgain).presents.size === 0 && scene(studentRoomAgain).blasts.size === 0);
    const teacherCasts: { ok: boolean }[] = [];
    const teacherCastResults = new Promise<{ ok: boolean }[]>((resolve) => teacherRoom.onMessage("cast-result", (value: { ok: boolean }) => { teacherCasts.push(value); if (teacherCasts.length === 2) resolve(teacherCasts); }));
    const shotId = randomUUID();
    teacherRoom.send("cast", { shotId, dx: 0, dy: 0, dz: -1 });
    teacherRoom.send("cast", { shotId, dx: 0, dy: 0, dz: -1 });
    const outcomes = await Promise.race([teacherCastResults, Bun.sleep(3000).then(() => [])]);
    expect(outcomes.map((result) => result.ok).sort()).toEqual([false, true]);
    expect(scene(studentRoomAgain).activities).toBe(true);
    expect((await command(studentRoomAgain, "teleport", "teleport-result")).ok).toBe(false);
    expect((await command(studentRoomAgain, "shop-open", "shop-result")).ok).toBe(false);
    await moveTo(studentRoomAgain, portal.x, portal.z);
    const oldEpoch = rider(studentRoomAgain).movementEpoch;
    expect((await command(studentRoomAgain, "teleport", "teleport-result")).ok).toBe(true);
    await waitFor(() => rider(studentRoomAgain).movementEpoch === oldEpoch + 1);
    expect(rider(studentRoomAgain)).toMatchObject({ x: -30, z: -7.5 });
    studentRoomAgain.send("move", { dx: 0.3, dz: 0, sequence: rider(studentRoomAgain).sequence + 1, movementEpoch: oldEpoch });
    await Bun.sleep(130);
    expect(rider(studentRoomAgain).x).toBe(-30);

    await sql`INSERT INTO classroom.student_accounts(id,email) VALUES(${peer},${peer + "@banjan.ac.th"})`;
    await sql`INSERT INTO classroom.students(id,classroom_id,student_code,student_number,display_name,account_id)
      VALUES(${peerMember},${classroom},'0002',2,'Synthetic Peer',${peer}),(${otherMember},${other},'0001',1,'Other Membership',${student})`;
    await sql`INSERT INTO classroom.assignments(id,classroom_id,title) VALUES(${otherAssignment},${other},'Other assignment')`;
    await sql`INSERT INTO classroom.files(classroom_id,assignment_id,student_id,kind,original_name,storage_name,media_type,size_bytes,submitted_by_account_id)
      VALUES(${classroom},${assignment},${peerMember},'submission','peer.pdf',${randomUUID()},'application/pdf',12,${peer}),
        (${other},${otherAssignment},${otherMember},'submission','other.pdf',${randomUUID()},'application/pdf',12,${student})`;
    expect((await request(teacherToken, "/access/" + peerMember, "PUT", { assignmentId: assignment, approved: true })).status).toBe(200);
    expect((await request(teacherToken, "", "PUT", { enabled: true }, other)).status).toBe(200);
    const peerToken = await createStudentSession(peer);
    const otherRoom = await join(studentToken, other), peerRoom = await join(peerToken);
    const issued = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM classroom.gallery_point_claims WHERE account_id=${student}`;
    await sql`INSERT INTO classroom.gallery_point_claims(gift_id,account_id,classroom_id)
      SELECT gen_random_uuid(), ${student}::uuid, ${classroom}::uuid FROM generate_series(1,16-${issued[0]!.count})
      UNION ALL SELECT gen_random_uuid(), ${peer}::uuid, ${classroom}::uuid FROM generate_series(1,10)`;
    await Promise.all([moveTo(studentRoomAgain, shop.x, shop.z), moveTo(peerRoom, shop.x, shop.z), moveTo(otherRoom, shop.x, shop.z)]);
    const openShop = (room: Room) => command(room, "shop-open", "shop-result");
    const buy = (room: Room, item: string, price: number, requestId = randomUUID()) => command(room, "shop-buy", "shop-result", { item, price, requestId });
    expect(await openShop(studentRoomAgain)).toMatchObject({ ok: true, wallet: { balance: 16, spells: 0, license: false }, prices: { wand: 5, license: 10 } });
    expect((await request(teacherToken, "/shop", "PUT", { wand: 6, license: 10 })).status).toBe(200);
    expect(await buy(studentRoomAgain, "wand", 5)).toMatchObject({ ok: false, prices: { wand: 6 }, wallet: { balance: 16 } });
    await Bun.sleep(220);
    const wandRequest = randomUUID();
    expect(await buy(studentRoomAgain, "wand", 6, wandRequest)).toMatchObject({ ok: true, wallet: { balance: 10, spells: 15 } });
    await Bun.sleep(220);
    expect(await buy(studentRoomAgain, "wand", 6, wandRequest)).toMatchObject({ ok: true, wallet: { balance: 10, spells: 15 } });
    await Bun.sleep(220);
    const otherPrice = await request(teacherToken, "/shop", "PUT", { wand: 5, license: 10 }, other);
    expect(otherPrice.status).toBe(200);
    const concurrent = await Promise.all([buy(studentRoomAgain, "license", 10), buy(otherRoom, "license", 10)]);
    expect(concurrent.filter(({ ok }) => ok)).toHaveLength(1);
    if (!concurrent[0].ok) {
      await sql`INSERT INTO classroom.gallery_point_claims(gift_id,account_id,classroom_id)
        SELECT gen_random_uuid(), ${student}, ${classroom} FROM generate_series(1,10)`;
      await Bun.sleep(220);
      expect(await buy(studentRoomAgain, "license", 10)).toMatchObject({ ok: true });
    }
    expect(await buy(peerRoom, "license", 10)).toMatchObject({ ok: true, wallet: { balance: 0, license: true } });
    expect(await command(otherRoom, "wallet-read", "wallet")).toMatchObject({ wallet: { spells: 0, balance: 0 } });
    await otherRoom.leave();
    const startRide = (room: Room, requestId = randomUUID()) => command(room, "ride-start", "vehicle-result", { kind: "broom", requestId });
    expect((await startRide(studentRoomAgain)).ok).toBe(false);
    expect(await command(studentRoomAgain, "wallet-read", "wallet")).toMatchObject({ wallet: { spells: 15, license: true } });
    await Promise.all([moveTo(studentRoomAgain, depot.x, depot.z), moveTo(peerRoom, depot.x, depot.z)]);
    const rideRequest = randomUUID();
    const rides = await Promise.all([startRide(studentRoomAgain, rideRequest), startRide(peerRoom)]);
    expect(rides.map(({ ok }) => ok)).toEqual([true, true]);
    await waitFor(() => Boolean(rider(studentRoomAgain).vehicleId && rider(peerRoom).vehicleId));
    const rentalId = rider(studentRoomAgain).vehicleId, peerRental = rider(peerRoom).vehicleId;
    expect(rentalId).not.toBe(peerRental);
    const broom = scene(studentRoomAgain).vehicles.get(rentalId);
    const peerBroom = scene(peerRoom).vehicles.get(peerRental);
    expect(broom).toMatchObject({ kind: "broom", rental: true, hitLimit: 4, hitsRemaining: 4, fuelCapacity: 5, fuelRemaining: 5 });
    expect(peerBroom.fuelRemaining).toBe(5);
    const peerLift = () => peerRoom.send("vehicle-input", { revision: peerBroom.revision, epoch: rider(peerRoom).movementEpoch, throttle: 0, turn: 0, lift: 1 });
    for (let i = 0; i < 4; i++) {
      studentRoomAgain.send("vehicle-input", { revision: broom.revision, epoch: rider(studentRoomAgain).movementEpoch, throttle: 0, turn: 0, lift: 1 });
      peerLift();
      await Bun.sleep(85);
    }
    expect(broom.y).toBeGreaterThan(0.3);
    expect(await vehicleCommand(studentRoomAgain, "exit", rentalId)).toBe(false);
    for (let i = 0; i < 8; i++) {
      studentRoomAgain.send("vehicle-input", { revision: broom.revision, epoch: rider(studentRoomAgain).movementEpoch, throttle: 0, turn: 0, lift: -1 });
      await Bun.sleep(85);
    }
    expect(broom.y).toBe(0);
    expect(await vehicleCommand(studentRoomAgain, "exit", rentalId)).toBe(true);
    await waitFor(() => !scene(studentRoomAgain).vehicles.has(rentalId));
    await waitFor(() => peerBroom.fuelRemaining === 0 && peerBroom.landing, 5500);
    await waitFor(() => peerBroom.y === 0 && !peerBroom.landing);
    peerLift(); await Bun.sleep(270);
    expect(peerBroom.y).toBe(0);
    await peerRoom.leave();
    await waitFor(() => !scene(studentRoomAgain).vehicles.has(peerRental));
    await moveTo(studentRoomAgain, depot.x, depot.z);
    expect((await startRide(studentRoomAgain, rideRequest)).ok).toBe(false);
    expect(await command(studentRoomAgain, "wallet-read", "wallet")).toMatchObject({ wallet: { spells: 15, license: false, balance: 0 } });

    expect((await command(studentRoomAgain, "cast", "cast-result", { shotId: randomUUID(), dx: 0, dy: 0, dz: 0 })).ok).toBe(false);
    const returningPeer = await join(peerToken);
    await Promise.all([moveTo(teacherRoom, 16, 18), moveTo(returningPeer, 20, 18)]);
    const studentShot = randomUUID();
    const castAsStudent = (shotId = randomUUID()) => command(studentRoomAgain, "cast", "cast-result", { shotId, dx: 1, dy: 0, dz: 0 });
    expect(await castAsStudent(studentShot)).toMatchObject({ ok: true, spells: 14 });
    await waitFor(() => rider(returningPeer).knockCause === "wand");
    expect(rider(teacherRoom).knocked).toBe(false);
    expect(rider(studentRoomAgain).knocked).toBe(false);
    await waitFor(() => rider(studentRoomAgain).wantedCount === 1 && scene(studentRoomAgain).officer.targetId === studentRoomAgain.sessionId);
    await studentRoomAgain.leave();
    studentRoomAgain = await join(studentToken);
    expect(rider(studentRoomAgain).wantedCount).toBe(1);
    await waitFor(() => rider(studentRoomAgain).jailedUntil > Date.now(), 10000);
    const jailedUntil = rider(studentRoomAgain).jailedUntil;
    expect(rider(studentRoomAgain)).toMatchObject({ ...jailCell, wantedCount: 0, vehicleId: "" });
    await studentRoomAgain.leave();
    studentRoomAgain = await join(studentToken);
    expect(rider(studentRoomAgain)).toMatchObject({ ...jailCell, jailedUntil });
    const custodyPlayer = rider(studentRoomAgain);
    studentRoomAgain.send("move", { dx: 0.3, dz: 0, sequence: custodyPlayer.sequence + 1, movementEpoch: custodyPlayer.movementEpoch });
    studentRoomAgain.send("jump", {});
    expect((await castAsStudent()).ok).toBe(false);
    expect((await command(studentRoomAgain, "teleport", "teleport-result")).ok).toBe(false);
    expect((await startRide(studentRoomAgain)).ok).toBe(false);
    const otherWhileJailed = await join(studentToken, other);
    expect(rider(otherWhileJailed)).toMatchObject({ wantedCount: 0, jailedUntil: 0 });
    await otherWhileJailed.leave();
    expect(rider(studentRoomAgain)).toMatchObject({ ...jailCell, jump: 0 });
    await waitFor(() => rider(studentRoomAgain).jailedUntil === 0, 5500);
    expect(rider(studentRoomAgain)).toMatchObject({ ...jailGate, wantedCount: 0 });
    expect((await castAsStudent(studentShot)).ok).toBe(false);
    for (let remaining = 13; remaining >= 0; remaining--) {
      expect(await castAsStudent()).toMatchObject({ ok: true, spells: remaining });
      await Bun.sleep(2010);
    }
    expect((await castAsStudent()).ok).toBe(false);
    expect(await command(studentRoomAgain, "wallet-read", "wallet")).toMatchObject({ wallet: { spells: 0 } });
    await sql`INSERT INTO classroom.gallery_point_claims (gift_id,account_id,classroom_id)
      SELECT gen_random_uuid(), ${student}, ${classroom} FROM generate_series(1,10)`;
    await moveTo(studentRoomAgain, shop.x, shop.z);
    expect(await buy(studentRoomAgain, "license", 10)).toMatchObject({ ok: true });
    await Promise.all([moveTo(studentRoomAgain, depot.x, depot.z), moveTo(teacherRoom, 11, 17)]);
    expect((await command(studentRoomAgain, "ride-start", "vehicle-result", { kind: "car", requestId: randomUUID() })).ok).toBe(true);
    await waitFor(() => Boolean(rider(studentRoomAgain).vehicleId));
    const newCarId = rider(studentRoomAgain).vehicleId;
    const newCar = scene(studentRoomAgain).vehicles.get(newCarId);
    expect(newCar).toMatchObject({ hitLimit: 1, hitsRemaining: 1 });
    let carBroke = false;
    const unlisten = studentRoomAgain.onMessage("vehicle-break", ({ driverId }: { driverId: string }) => { carBroke = driverId === studentRoomAgain.sessionId; });
    for (let step = 0; step < 12 && !carBroke; step++) {
      studentRoomAgain.send("vehicle-input", { revision: newCar.revision, epoch: rider(studentRoomAgain).movementEpoch, throttle: 1, turn: 0, lift: 0 });
      await Bun.sleep(80);
    }
    await waitFor(() => carBroke && !scene(studentRoomAgain).vehicles.has(newCarId));
    unlisten();
    expect(rider(studentRoomAgain).vehicleId).toBe("");
    expect(rider(teacherRoom).knockCause).toBe("car");
    expect(await command(studentRoomAgain, "wallet-read", "wallet")).toMatchObject({ wallet: { license: false } });
    await sql`DELETE FROM classroom.assignments WHERE classroom_id=${other}`;
    await sql`DELETE FROM classroom.students WHERE classroom_id=${other}`;
    await sql`DELETE FROM classroom.classrooms WHERE id=${other}`;
    expect(await (await app.handle(new Request("http://localhost/api/student/gallery-points", { headers: studentHeaders }))).json()).toEqual({ balance: 0 });
    const stale = await (await request(studentToken, "/ticket", "POST")).json();
    const departed = new Promise<number>((resolve) => studentRoomAgain.onLeave(resolve));
    expect((await request(teacherToken, "", "PUT", { enabled: false })).status).toBe(200);
    // Closing entry can be observed by either the world-status poll or the session check.
    expect([4403, 4003]).toContain(await Promise.race([departed, Bun.sleep(4000).then(() => -1)]));
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
    const removed = new Promise<number>((resolve) => rejoined.onLeave(resolve));
    await sql`DELETE FROM classroom.files WHERE id=${uploadedModel}`;
    rejoined.send("refresh-avatar");
    expect(await Promise.race([removed, Bun.sleep(3000).then(() => -1)])).toBe(4003);
    expect(await worldStatus()).toEqual(expect.arrayContaining([expect.objectContaining({ classroomId: classroom, hasSubmission: false, approved: true, entryAllowed: false })]));
    expect((await request(studentToken, "/ticket", "POST")).status).toBe(403);
  } finally {
    await Promise.all(rooms.filter((room) => room.connection.isOpen).map((room) => room.leave()));
    server.kill("SIGTERM"); if (server.exitCode === null) await once(server, "exit");
    await sql`DELETE FROM classroom.assignments WHERE classroom_id IN (${classroom},${other})`;
    await sql`DELETE FROM classroom.students WHERE classroom_id IN (${classroom},${other})`;
    await sql`DELETE FROM classroom.classrooms WHERE id IN (${classroom},${other})`;
    await sql`DELETE FROM classroom.student_accounts WHERE id IN (${student},${peer})`;
    await sql`DELETE FROM classroom.teachers WHERE id IN (${teacher},${foreignTeacher})`;
    await rm(uploadDir, { recursive: true, force: true });
  }
}, 165000);
