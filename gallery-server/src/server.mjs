import { createHash } from "node:crypto";
import { Server, Room, ServerError } from "colyseus";
import { schema, t } from "@colyseus/schema";
import pg from "pg";
import { boundedMove } from "./movement.mjs";
import { applyAppearance } from "./avatar.mjs";
import { advanceBolt, knockPlayer, playerHitFraction, respawnPlayer, validAim } from "./combat.mjs";
import { databaseConfig } from "./database-config.mjs";
import { distanceToNextStation, TRAIN_BOARDING_MS, TRAIN_DWELL_MS, TRAIN_SPEED, trainTrack } from "./train-layout.mjs";
import { canBoardTrain, firstDepartureAt, nextDepartureAt } from "./train-rules.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool(databaseConfig());
const Player = schema({ displayName: t.string(), role: t.string(), skinColor: t.string(), hairColor: t.string(), shirtColor: t.string(), trousersColor: t.string(), hairStyle: t.string(), hatStyle: t.string(), glassesStyle: t.string(), shoeStyle: t.string(), hatColor: t.string(), glassesColor: t.string(), shoeColor: t.string(), x: t.number().default(0), z: t.number().default(0), rotation: t.number().default(0), sequence: t.number().default(0), jump: t.number().default(0), movementEpoch: t.number().default(0), knocked: t.boolean().default(false), respawnAt: t.number().default(0), protectedUntil: t.number().default(0), trainSeat: t.number().default(-1) });
const Bolt = schema({ id: t.string(), x: t.number(), y: t.number(), z: t.number() });
const Train = schema({ active: t.boolean().default(false), x: t.number().default(0), z: t.number().default(2), rotation: t.number().default(0), phase: t.string().default("waiting"), stopId: t.string().default("entrance"), nextStopId: t.string().default(""), departureAt: t.number().default(0), arrivalAt: t.number().default(0), mode: t.string().default("auto"), intervalSeconds: t.number().default(120), seats: t.number().default(0), revision: t.number().default(0), startStudentId: t.string().default(""), layoutRoster: t.string().default("[]") });
const GalleryState = schema({ players: t.map(Player), bolts: t.map(Bolt), train: Train });
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function consumeTicket(token, classroomId) {
  if (typeof token !== "string" || token.length > 100) throw new ServerError(4001, "Invalid room ticket");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT gt.*, c.name AS classroom_name
      FROM classroom.gallery_tickets gt JOIN classroom.classrooms c ON c.id=gt.classroom_id
      JOIN classroom.gallery_worlds w ON w.classroom_id=c.id
      WHERE gt.token_hash=$1 AND gt.classroom_id=$2 AND gt.expires_at>NOW() AND gt.consumed_at IS NULL AND (w.enabled OR (gt.actor_kind='teacher' AND c.owner_id=gt.account_id)) AND c.archived_at IS NULL
      FOR UPDATE OF gt`, [sha256(token), classroomId]);
    const ticket = rows[0];
    if (!ticket) throw new ServerError(4001, "Room ticket expired or already used");
    const sessionQuery = ticket.actor_kind === "teacher"
      ? `SELECT t.id, t.display_name AS "displayName", t.active, t.avatar_settings AS appearance FROM classroom.sessions s JOIN classroom.teachers t ON t.id=s.teacher_id WHERE s.token_hash=$1 AND s.teacher_id=$2 AND s.expires_at>NOW() AND t.active`
      : `SELECT a.id, s.display_name AS "displayName", a.avatar_settings AS appearance, TRUE AS active FROM classroom.student_sessions ss JOIN classroom.student_accounts a ON a.id=ss.account_id JOIN classroom.students s ON s.id=$3 AND s.account_id=a.id JOIN classroom.classrooms c ON c.id=s.classroom_id WHERE ss.token_hash=$1 AND a.id=$2 AND ss.expires_at>NOW() AND s.archived_at IS NULL AND c.archived_at IS NULL`;
    const sessionValues = ticket.actor_kind === "teacher" ? [ticket.session_hash, ticket.account_id] : [ticket.session_hash, ticket.account_id, ticket.student_id];
    const { rows: sessions } = await client.query(sessionQuery, sessionValues);
    const account = sessions[0];
    if (!account) throw new ServerError(4001, "Session is no longer active");
    await client.query("UPDATE classroom.gallery_tickets SET consumed_at=NOW() WHERE token_hash=$1", [ticket.token_hash]);
    await client.query("COMMIT");
    return { classroomId, accountId: ticket.account_id, sessionHash: ticket.session_hash, studentId: ticket.student_id, role: ticket.actor_kind, displayName: account.displayName, appearance: account.appearance };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function stillAllowed(auth) {
  const query = auth.role === "teacher"
    ? `SELECT EXISTS(SELECT 1 FROM classroom.sessions s JOIN classroom.teachers t ON t.id=s.teacher_id JOIN classroom.classrooms c ON c.id=$3 JOIN classroom.gallery_worlds w ON w.classroom_id=c.id WHERE s.token_hash=$1 AND s.teacher_id=$2 AND s.expires_at>NOW() AND t.active AND c.owner_id=t.id AND c.archived_at IS NULL) AS allowed`
    : `SELECT EXISTS(SELECT 1 FROM classroom.student_sessions ss JOIN classroom.students s ON s.id=$4 JOIN classroom.classrooms c ON c.id=s.classroom_id JOIN classroom.gallery_worlds w ON w.classroom_id=c.id WHERE ss.token_hash=$1 AND ss.account_id=$2 AND ss.expires_at>NOW() AND s.classroom_id=$3 AND s.account_id=ss.account_id AND s.archived_at IS NULL AND c.archived_at IS NULL AND w.enabled) AS allowed`;
  const values = auth.role === "teacher" ? [auth.sessionHash, auth.accountId, auth.classroomId] : [auth.sessionHash, auth.accountId, auth.classroomId, auth.studentId];
  const { rows } = await pool.query(query, values);
  return rows[0]?.allowed === true;
}

class ClassroomGallery extends Room {
  maxClients = 50;
  state = new GalleryState();
  members = new Map();
  movementTimes = new Map();
  movementMessages = new Map();
  appearanceTimes = new Map();
  jumpTimes = new Map();
  accessTimer;
  galleryTimer;
  worldTimer;
  jumpStarts = new Map();
  castTimes = new Map();
  usedShotIds = new Set();
  lifeStates = new Map();
  combatTimer;
  trainRoute = [];
  trainConfig = null;
  pendingTrainConfig = null;
  trainLegIndex = 0;
  trainCircuitActive = false;
  trainLastTick = 0;
  trainLastDeparture = 0;
  trainSeats = new Map();
  trainCommandTimes = new Map();

  async onAuth(_client, options) {
    if (typeof options.classroomId !== "string") throw new ServerError(4001, "Classroom is required");
    const auth = await consumeTicket(options.ticket, options.classroomId);
    this.classroomId = options.classroomId;
    return auth;
  }

  async onCreate(options) {
    this.classroomId ??= options.classroomId;
    this.setMetadata({ classroomId: this.classroomId });
    this.onMessage("move", (client, message) => this.move(client, message));
    this.onMessage("jump", (client) => {
      const player = this.state.players.get(client.sessionId), now = Date.now();
      if (!player || player.knocked || player.trainSeat >= 0 || now - (this.jumpTimes.get(client.sessionId) ?? 0) < 900) return;
      this.jumpTimes.set(client.sessionId, now); this.jumpStarts.set(client.sessionId, now); player.jump++;
    });
    this.onMessage("cast", (client, message) => { void this.cast(client, message).catch(() => client.send("cast-result", { ok: false })); });
    this.onMessage("refresh-avatar", (client) => { void this.refreshAvatar(client).catch(() => {}); });
    this.onMessage("train-start", (client, message) => { void this.startTrain(client, message).catch(() => client.send("train-result", { ok: false, message: "เริ่มรถไฟไม่ได้" })); });
    this.onMessage("train-board", (client, message) => { void this.boardTrain(client, message).catch(() => client.send("train-result", { ok: false, message: "ขึ้นรถไฟไม่ได้" })); });
    this.onMessage("train-leave", (client, message) => { void this.leaveTrain(client, message).catch(() => client.send("train-result", { ok: false, message: "ลงจากรถไฟไม่ได้" })); });
    this.state.train = new Train();
    await this.refreshTrainConfiguration(true).catch(() => {});
    const readSignature = async () => {
      const { rows } = await pool.query(`SELECT
        (SELECT COUNT(*)::int FROM classroom.files f JOIN classroom.students s ON s.id=f.student_id JOIN classroom.assignments a ON a.id=f.assignment_id WHERE f.classroom_id=$1 AND f.kind IN ('model','submission') AND lower(f.original_name) ~ '\\.(stl|obj|glb|gltf)$' AND s.archived_at IS NULL AND a.archived_at IS NULL) AS files,
        (SELECT COALESCE(MAX(f.created_at)::text,'') FROM classroom.files f WHERE f.classroom_id=$1 AND f.kind IN ('model','submission')) AS latest,
        (SELECT COUNT(*)::int FROM classroom.gallery_hidden_models WHERE classroom_id=$1) AS hidden,
        (SELECT COUNT(*)::int FROM classroom.gallery_likes WHERE classroom_id=$1) AS likes,
        (SELECT COALESCE(json_agg(json_build_array(id,student_number,display_name) ORDER BY student_number NULLS LAST,display_name,id)::text,'[]') FROM classroom.students WHERE classroom_id=$1 AND archived_at IS NULL) AS roster,
        (SELECT enabled FROM classroom.gallery_worlds WHERE classroom_id=$1) AS enabled`, [this.classroomId]);
      return JSON.stringify(rows[0]);
    };
    let signature = await readSignature().catch(() => "");
    this.galleryTimer = setInterval(async () => {
      const next = await readSignature().catch(() => signature);
      if (next !== signature) { signature = next; this.broadcast("gallery-refresh"); }
      await this.refreshAppearances().catch(() => {});
    }, 20000);
    let checkingWorld = false;
    this.worldTimer = setInterval(async () => {
      if (checkingWorld) return;
      checkingWorld = true;
      try {
        const { rows } = await pool.query("SELECT enabled FROM classroom.gallery_worlds WHERE classroom_id=$1", [this.classroomId]);
        if (!rows[0]?.enabled) for (const client of [...this.clients]) {
          if (this.members.get(client.sessionId)?.role === "student") client.leave(4403, "Teacher stopped student access");
        }
      } catch { /* Existing session checks fail closed if the database stays unavailable. */ }
      finally { checkingWorld = false; }
    }, 2000);
    this.accessTimer = setInterval(async () => {
      for (const client of [...this.clients]) {
        const auth = this.members.get(client.sessionId);
        if (auth && !(await stillAllowed(auth).catch(() => false))) client.leave(4003, "Classroom access expired");
      }
    }, 15000);
    this.combatTimer = setInterval(() => { this.updateCombat(); this.updateTrain(); }, 50);
    this.trainSettingsTimer = setInterval(() => { void this.refreshTrainConfiguration().catch(() => {}); }, 5000);
  }

  async onJoin(client, _options, auth) {
    if (!(await stillAllowed(auth).catch(() => false))) { client.leave(4003, "Classroom access expired"); return; }
    if ([...this.members.values()].some((member) => member.accountId === auth.accountId)) {
      client.leave(4009, "This account is already in the classroom world");
      return;
    }
    this.members.set(client.sessionId, auth);
    const player = new Player();
    player.displayName = auth.displayName;
    player.role = auth.role;
    applyAppearance(player, auth.appearance);
    let life = this.lifeStates.get(auth.accountId);
    if (life?.knocked && life.respawnAt <= Date.now()) {
      life = { x: 0, z: 0, rotation: 0, knocked: false, respawnAt: 0, protectedUntil: Date.now() + 3000, movementEpoch: life.movementEpoch + 1 };
      this.lifeStates.set(auth.accountId, life);
    }
    if (life && (life.knocked || life.protectedUntil > Date.now())) Object.assign(player, life);
    else { player.x = Math.random() * 4 - 2; player.z = Math.random() * 4 - 2; }
    player.trainSeat = -1;
    this.state.players.set(client.sessionId, player);
    this.movementTimes.set(client.sessionId, Date.now());
  }

  move(client, message) {
    const player = this.state.players.get(client.sessionId);
    if (!player || !message || player.knocked || player.trainSeat >= 0 || message.movementEpoch !== player.movementEpoch) return;
    const now = Date.now();
    const count = this.movementMessages.get(client.sessionId) ?? { start: now, total: 0 };
    if (now - count.start > 1000) { count.start = now; count.total = 0; }
    if (++count.total > 20) return;
    this.movementMessages.set(client.sessionId, count);
    const elapsed = Math.min(1, Math.max(0.05, (now - (this.movementTimes.get(client.sessionId) ?? now)) / 1000));
    const next = boundedMove(player, message, elapsed, Math.max(2000, this.trainRoute.length ? Math.abs(Math.min(...this.trainRoute.map((point) => point.z))) + 100 : 2000));
    if (!next) return;
    if (Number.isSafeInteger(message.sequence) && message.sequence > player.sequence) player.sequence = message.sequence;
    this.movementTimes.set(client.sessionId, now);
    player.x = next.x;
    player.z = next.z;
    player.rotation = next.rotation;
  }

  async readTrainConfiguration() {
    const [{ rows: worlds }, { rows: roster }] = await Promise.all([
      pool.query(`SELECT w.train_mode AS mode, w.train_interval_seconds AS "intervalSeconds", CASE WHEN s.id IS NOT NULL THEN s.id ELSE NULL END AS "startStudentId"
        FROM classroom.gallery_worlds w LEFT JOIN classroom.students s ON s.id=w.train_start_student_id AND s.classroom_id=w.classroom_id AND s.archived_at IS NULL AND s.student_number IS NOT NULL WHERE w.classroom_id=$1`, [this.classroomId]),
      pool.query(`SELECT id, student_number AS "studentNumber", display_name AS "displayName" FROM classroom.students WHERE classroom_id=$1 AND archived_at IS NULL ORDER BY student_number NULLS LAST, display_name, id`, [this.classroomId]),
    ]);
    const world = worlds[0] ?? { mode: "auto", intervalSeconds: 120, startStudentId: null };
    const startIndex = world.startStudentId ? roster.findIndex((student) => student.id === world.startStudentId) : -1;
    const route = trainTrack(roster.length, startIndex < 0 ? null : startIndex);
    return { mode: world.mode, intervalSeconds: Number(world.intervalSeconds), startStudentId: startIndex < 0 ? null : world.startStudentId, roster: roster.map((student) => ({ studentId: student.id, studentNumber: student.studentNumber, displayName: student.displayName })), route };
  }

  async refreshTrainConfiguration(initial = false) {
    const config = await this.readTrainConfiguration();
    const signature = JSON.stringify(config);
    if (signature === this.trainConfig?.signature) return;
    config.signature = signature;
    if (initial || (!this.trainCircuitActive && this.trainSeats.size === 0)) this.applyTrainConfiguration(config);
    else this.pendingTrainConfig = config;
  }

  applyTrainConfiguration(config, schedule = true) {
    this.trainConfig = config;
    this.trainRoute = config.route;
    const train = this.state.train;
    train.revision++;
    train.active = this.trainRoute.length > 0;
    train.mode = config.mode;
    train.intervalSeconds = config.intervalSeconds;
    train.startStudentId = config.startStudentId ?? "";
    train.layoutRoster = JSON.stringify(config.roster);
    train.seats = this.trainSeats.size;
    this.trainLegIndex = 0;
    this.trainCircuitActive = false;
    this.trainLastTick = Date.now();
    if (!train.active) { train.phase = "waiting"; train.stopId = ""; train.nextStopId = ""; train.departureAt = 0; train.arrivalAt = 0; train.x = 0; train.z = 2; return; }
    train.x = this.trainRoute[0].x; train.z = this.trainRoute[0].z; train.rotation = 0;
    train.stopId = this.trainRoute[0].id; train.phase = schedule && config.mode === "auto" ? "boarding" : "waiting";
    train.departureAt = firstDepartureAt(Date.now(), config.mode);
    train.arrivalAt = 0;
    this.updateTrainNextStop();
  }

  updateTrainNextStop() {
    const train = this.state.train, route = this.trainRoute;
    if (!route.length) { train.nextStopId = ""; return; }
    for (let step = 1; step <= route.length; step++) {
      const point = route[(this.trainLegIndex + step) % route.length];
      if (point.id) { train.nextStopId = point.id; return; }
    }
    train.nextStopId = "";
  }

  async startTrain(client, message) {
    const auth = this.members.get(client.sessionId), train = this.state.train, now = Date.now();
    const commandKey = auth ? `start:${auth.accountId}` : "";
    if (!auth || auth.role !== "teacher" || !message || message.revision !== train.revision || train.mode !== "manual" || train.phase !== "waiting" || !train.active || now - (this.trainCommandTimes.get(commandKey) ?? 0) < 500) { client.send("train-result", { ok: false, message: "รถไฟไม่พร้อมออกหรือข้อมูลเปลี่ยนแล้ว" }); return; }
    this.trainCommandTimes.set(commandKey, now);
    if (!(await stillAllowed(auth).catch(() => false)) || this.members.get(client.sessionId) !== auth) { client.leave(4003, "Classroom access expired"); return; }
    if (message.revision !== train.revision || train.mode !== "manual" || train.phase !== "waiting") { client.send("train-result", { ok: false, message: "รถไฟเริ่มไปแล้วหรือข้อมูลเปลี่ยนแล้ว" }); return; }
    train.phase = "boarding"; train.departureAt = now + TRAIN_BOARDING_MS; train.stopId = this.trainRoute[this.trainLegIndex]?.id ?? "entrance";
    client.send("train-result", { ok: true, message: "รถไฟจะออกใน 10 วินาที" });
  }

  async boardTrain(client, message) {
    const auth = this.members.get(client.sessionId), player = this.state.players.get(client.sessionId), train = this.state.train, now = Date.now();
    const commandKey = auth ? `board:${auth.accountId}` : "";
    const last = auth ? this.trainCommandTimes.get(commandKey) ?? 0 : 0;
    if (!auth || !player || !message || message.revision !== train.revision || player.trainSeat >= 0 || !canBoardTrain({ active: train.active, phase: train.phase, seats: this.trainSeats.size, distance: Math.hypot(player.x - train.x, player.z - train.z) }) || now - last < 250) { client.send("train-result", { ok: false, message: "อยู่ใกล้สถานีและรอให้รถหยุดก่อนขึ้นรถไฟ" }); return; }
    this.trainCommandTimes.set(commandKey, now);
    if (!(await stillAllowed(auth).catch(() => false)) || this.members.get(client.sessionId) !== auth) { client.leave(4003, "Classroom access expired"); return; }
    if (message.revision !== train.revision || player.trainSeat >= 0 || !canBoardTrain({ active: train.active, phase: train.phase, seats: this.trainSeats.size, distance: Math.hypot(player.x - train.x, player.z - train.z) })) { client.send("train-result", { ok: false, message: "รถไฟออกแล้วหรือไม่มีที่นั่งว่าง" }); return; }
    const occupied = new Set(this.trainSeats.values()); let seat = 0; while (occupied.has(seat)) seat++;
    this.trainSeats.set(client.sessionId, seat); player.trainSeat = seat; player.x = train.x; player.z = train.z; player.rotation = train.rotation; player.movementEpoch++;
    this.jumpStarts.delete(client.sessionId); train.seats = this.trainSeats.size;
    client.send("train-result", { ok: true, message: "ขึ้นรถไฟแล้ว" });
  }

  async leaveTrain(client, message) {
    const auth = this.members.get(client.sessionId), player = this.state.players.get(client.sessionId), train = this.state.train, now = Date.now();
    const commandKey = auth ? `leave:${auth.accountId}` : "";
    if (!auth || !player || !message || message.revision !== train.revision || player.trainSeat < 0 || !["waiting", "boarding", "dwell"].includes(train.phase) || now - (this.trainCommandTimes.get(commandKey) ?? 0) < 250) { client.send("train-result", { ok: false, message: "ลงจากรถได้เมื่อรถไฟจอดที่สถานี" }); return; }
    this.trainCommandTimes.set(commandKey, now);
    if (!(await stillAllowed(auth).catch(() => false)) || this.members.get(client.sessionId) !== auth) { client.leave(4003, "Classroom access expired"); return; }
    if (message.revision !== train.revision || player.trainSeat < 0 || !["waiting", "boarding", "dwell"].includes(train.phase)) { client.send("train-result", { ok: false, message: "รถไฟออกจากสถานีแล้ว" }); return; }
    const seat = this.trainSeats.get(client.sessionId) ?? 0;
    this.trainSeats.delete(client.sessionId); player.trainSeat = -1; player.x = train.x + 2 + (seat % 3); player.z = train.z + 3; player.rotation = 0; player.movementEpoch++;
    this.jumpStarts.delete(client.sessionId); train.seats = this.trainSeats.size;
    client.send("train-result", { ok: true, message: "ลงจากรถไฟแล้ว" });
  }

  updateTrain() {
    const train = this.state.train, route = this.trainRoute, now = Date.now();
    if (!train.active || !route.length) return;
    if (train.phase === "boarding" && now >= train.departureAt) {
      this.trainLastDeparture = train.departureAt; this.trainCircuitActive = true; train.phase = "moving"; train.stopId = ""; train.departureAt = 0; this.updateTrainNextStop();
      train.arrivalAt = now + distanceToNextStation(route, this.trainLegIndex, train.x, train.z) / TRAIN_SPEED * 1000;
    } else if (train.phase === "dwell" && now >= train.departureAt) {
      train.phase = "moving"; train.stopId = ""; train.departureAt = 0; this.updateTrainNextStop();
      train.arrivalAt = now + distanceToNextStation(route, this.trainLegIndex, train.x, train.z) / TRAIN_SPEED * 1000;
    }
    if (train.phase !== "moving") { this.trainLastTick = now; return; }
    let remaining = TRAIN_SPEED * Math.min(0.1, Math.max(0, (now - this.trainLastTick) / 1000)); this.trainLastTick = now;
    while (remaining > 0) {
      const nextIndex = (this.trainLegIndex + 1) % route.length, target = route[nextIndex], dx = target.x - train.x, dz = target.z - train.z, distance = Math.hypot(dx, dz);
      if (distance <= remaining + 0.001) {
        train.x = target.x; train.z = target.z; if (distance > 0) train.rotation = Math.atan2(dx, dz);
        remaining -= distance; this.trainLegIndex = nextIndex;
        if (nextIndex === 0) { void this.finishTrainCircuit(now); return; }
        if (target.id) { train.phase = "dwell"; train.stopId = target.id; train.arrivalAt = now; train.departureAt = now + TRAIN_DWELL_MS; this.updateTrainNextStop(); this.syncTrainRiders(); return; }
        continue;
      }
      const fraction = remaining / distance; train.x += dx * fraction; train.z += dz * fraction; train.rotation = Math.atan2(dx, dz); remaining = 0;
    }
    this.syncTrainRiders();
  }

  syncTrainRiders() {
    const train = this.state.train;
    for (const sessionId of this.trainSeats.keys()) {
      const player = this.state.players.get(sessionId);
      if (player) { player.x = train.x; player.z = train.z; player.rotation = train.rotation; }
    }
  }

  async finishTrainCircuit(now) {
    const train = this.state.train;
    if (train.phase !== "moving") return;
    train.phase = "waiting"; train.stopId = this.trainRoute[0]?.id ?? "entrance"; train.arrivalAt = now; train.departureAt = 0;
    for (const [sessionId, seat] of this.trainSeats) {
      const player = this.state.players.get(sessionId);
      if (player) { player.trainSeat = -1; player.x = train.x + 2 + (seat % 3); player.z = train.z + 3; player.rotation = 0; player.movementEpoch++; }
    }
    this.trainSeats.clear(); train.seats = 0; this.trainCircuitActive = false;
    const config = await this.readTrainConfiguration().catch(() => this.pendingTrainConfig ?? this.trainConfig);
    if (config) { config.signature = JSON.stringify(config); this.pendingTrainConfig = null; this.applyTrainConfiguration(config, false); }
    if (!train.active) return;
    train.phase = train.mode === "auto" ? "boarding" : "waiting";
    train.departureAt = nextDepartureAt(train.mode, train.intervalSeconds, this.trainLastDeparture, now);
  }

  async cast(client, message) {
    const auth=this.members.get(client.sessionId), player=this.state.players.get(client.sessionId), aim=validAim(message), now=Date.now();
    if (!auth || auth.role!=="teacher" || !player || !aim || now-(this.castTimes.get(auth.accountId)??0)<2000 || this.usedShotIds.has(aim.shotId)) {
      client.send("cast-result",{ok:false}); return;
    }
    this.usedShotIds.add(aim.shotId);
    if (this.usedShotIds.size > 4096) this.usedShotIds.delete(this.usedShotIds.values().next().value);
    this.castTimes.set(auth.accountId,now);
    if (!(await stillAllowed(auth).catch(()=>false)) || this.members.get(client.sessionId) !== auth || this.state.players.get(client.sessionId) !== player) {
      client.send("cast-result",{ok:false}); return;
    }
    const bolt=new Bolt(); bolt.id=aim.shotId;
    bolt.x=player.x+Math.sin(player.rotation)*0.45; bolt.y=1.45; bolt.z=player.z+Math.cos(player.rotation)*0.45;
    const details={...aim,x:bolt.x,y:bolt.y,z:bolt.z,travelled:0};
    this.state.bolts.set(bolt.id,bolt); this.boltDetails.set(bolt.id,details);
    client.send("cast-result",{ok:true});
  }

  boltDetails = new Map();
  updateCombat() {
    const now=Date.now();
    for (const [accountId, life] of this.lifeStates) {
      if (life.knocked && life.respawnAt <= now) this.lifeStates.set(accountId,{x:0,z:0,rotation:0,knocked:false,respawnAt:0,protectedUntil:now+3000,movementEpoch:life.movementEpoch+1});
      else if (!life.knocked && life.protectedUntil <= now && life.protectedUntil !== 0) this.lifeStates.set(accountId,{...life,protectedUntil:0});
    }
    for (const client of this.clients) {
      const auth=this.members.get(client.sessionId), player=this.state.players.get(client.sessionId);
      if (auth && player && player.knocked && respawnPlayer(player,now)) {
        player.jump=0;
        this.jumpStarts.delete(client.sessionId); this.lifeStates.set(auth.accountId,{x:0,z:0,rotation:0,knocked:false,respawnAt:0,protectedUntil:player.protectedUntil,movementEpoch:player.movementEpoch});
        client.send("respawn",{movementEpoch:player.movementEpoch,x:0,z:0});
      } else if (auth && player) this.lifeStates.set(auth.accountId,{x:player.x,z:player.z,rotation:player.rotation,knocked:player.knocked,respawnAt:player.respawnAt,protectedUntil:player.protectedUntil,movementEpoch:player.movementEpoch});
    }
    for (const [id,bolt] of this.state.bolts) {
      const details=this.boltDetails.get(id); if (!details) { this.state.bolts.delete(id); continue; }
      const {from,to,expired}=advanceBolt(details,0.05);
      bolt.x=to.x; bolt.y=to.y; bolt.z=to.z;
      let hit=null, nearest=1;
      for (const [sessionId,player] of this.state.players) {
        if (player.role!=="student" || player.knocked || player.protectedUntil>now) continue;
        const started=this.jumpStarts.get(sessionId)??-Infinity, elapsed=(now-started)/1000;
        const jump=elapsed>0&&elapsed<0.75?Math.max(0,6*elapsed-8*elapsed*elapsed):0;
        const fraction=playerHitFraction(from,to,player,jump);
        if (fraction!==null && fraction<nearest) { nearest=fraction; hit={sessionId,player,x:from.x+(to.x-from.x)*fraction,y:from.y+(to.y-from.y)*fraction,z:from.z+(to.z-from.z)*fraction}; }
      }
      if (hit) {
        const targetClient=this.clients.find((candidate)=>candidate.sessionId===hit.sessionId);
        if (knockPlayer(hit.player,now)) {
          if (hit.player.trainSeat >= 0) { this.trainSeats.delete(hit.sessionId); hit.player.trainSeat = -1; this.state.train.seats = this.trainSeats.size; }
          targetClient?.send("knocked",{respawnAt:hit.player.respawnAt});
          this.broadcast("wand-impact",{id,x:hit.x,y:hit.y,z:hit.z});
        }
      }
      if (hit || expired) { this.state.bolts.delete(id); this.boltDetails.delete(id); }
    }
  }

  async refreshAvatar(client) {
    const auth = this.members.get(client.sessionId);
    if (!auth || Date.now() - (this.appearanceTimes.get(client.sessionId) ?? 0) < 1000) return;
    this.appearanceTimes.set(client.sessionId, Date.now());
    if (!(await stillAllowed(auth).catch(() => false))) { client.leave(4003, "Classroom access expired"); return; }
    const table = auth.role === "teacher" ? "classroom.teachers" : "classroom.student_accounts";
    const { rows } = await pool.query(`SELECT avatar_settings AS appearance FROM ${table} WHERE id=$1`, [auth.accountId]);
    const player = this.state.players.get(client.sessionId);
    if (player && rows[0]) applyAppearance(player, rows[0].appearance);
  }

  async refreshAppearances() {
    const teacherIds = [...new Set([...this.members.values()].filter((member) => member.role === "teacher").map((member) => member.accountId))];
    const studentIds = [...new Set([...this.members.values()].filter((member) => member.role === "student").map((member) => member.accountId))];
    if (!teacherIds.length && !studentIds.length) return;
    const { rows } = await pool.query(`SELECT id, avatar_settings AS appearance, 'teacher' AS role FROM classroom.teachers WHERE id=ANY($1::uuid[])
      UNION ALL SELECT id, avatar_settings AS appearance, 'student' AS role FROM classroom.student_accounts WHERE id=ANY($2::uuid[])`, [teacherIds, studentIds]);
    const appearances = new Map(rows.map((row) => [`${row.role}:${row.id}`, row.appearance]));
    for (const client of this.clients) {
      const auth = this.members.get(client.sessionId), player = this.state.players.get(client.sessionId);
      if (auth && player) applyAppearance(player, appearances.get(`${auth.role}:${auth.accountId}`));
    }
  }

  onLeave(client) {
    const auth=this.members.get(client.sessionId), player=this.state.players.get(client.sessionId);
    if (auth && player) this.lifeStates.set(auth.accountId,{x:player.x,z:player.z,rotation:player.rotation,knocked:player.knocked,respawnAt:player.respawnAt,protectedUntil:player.protectedUntil,movementEpoch:player.movementEpoch});
    if (this.trainSeats.delete(client.sessionId)) this.state.train.seats=this.trainSeats.size;
    if (auth) for (const action of ["start", "board", "leave"]) this.trainCommandTimes.delete(`${action}:${auth.accountId}`);
    this.state.players.delete(client.sessionId);
    this.members.delete(client.sessionId);
    this.movementTimes.delete(client.sessionId);
    this.movementMessages.delete(client.sessionId);
    this.appearanceTimes.delete(client.sessionId);
    this.jumpTimes.delete(client.sessionId);
    this.jumpStarts.delete(client.sessionId);
  }

  onDispose() { clearInterval(this.accessTimer); clearInterval(this.galleryTimer); clearInterval(this.worldTimer); clearInterval(this.combatTimer); clearInterval(this.trainSettingsTimer); this.state.bolts.clear(); this.boltDetails.clear(); this.lifeStates.clear(); this.usedShotIds.clear(); this.trainSeats.clear(); this.trainCommandTimes.clear(); }
}

const gameServer = new Server({ express: (app) => app.get("/__healthcheck", (_request, response) => response.status(200).type("text").send("OK")) });
gameServer.define("classroom", ClassroomGallery).filterBy(["classroomId"]);
await gameServer.listen(Number(process.env.PORT ?? 2567));
console.log(`Classroom Colyseus server listening on ${process.env.PORT ?? 2567}`);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => { await gameServer.gracefullyShutdown(false); await pool.end(); process.exit(0); });
