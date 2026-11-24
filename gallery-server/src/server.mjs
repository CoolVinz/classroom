import { createHash, randomInt, randomUUID } from "node:crypto";
import { Server, Room, ServerError } from "colyseus";
import { schema, t } from "@colyseus/schema";
import pg from "pg";
import { boundedMove } from "./movement.mjs";
import { applyAppearance } from "./avatar.mjs";
import { advanceBolt, knockPlayer, playerHitFraction, respawnPlayer, validAim } from "./combat.mjs";
import { databaseConfig } from "./database-config.mjs";
import { blockPosition, BLOCK_DEPTH, distanceToNextStation, TRAIN_SPEED, trainTrack } from "./train-layout.mjs";
import { canBoardTrain, firstDepartureAt, nextDepartureAt, stationWaitMs } from "./train-rules.mjs";
import { advanceVehicle, hitsMovingBody, LANDING_HEIGHT, trainBodies, validVehicleInput, VEHICLE_BAY_Z, VEHICLE_ENTER_DISTANCE, vehicleKinds, vehicleSpecs } from "./vehicles.mjs";
import { advanceSanta, canOpenPresent, maxPresents, presentDropMs, presentLifetimeMs, santaPath, insideBombRadius } from "./santa.mjs";
import { buyItem, isRequestId, readShop, readWallet, useItem, withStudentWallet } from "./wallet.mjs";
import { depot, nearPlace, portal, rentalPads, shop } from "./world-places.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool(databaseConfig());
const Player = schema({ displayName: t.string(), role: t.string(), skinColor: t.string(), hairColor: t.string(), shirtColor: t.string(), trousersColor: t.string(), hairStyle: t.string(), hatStyle: t.string(), glassesStyle: t.string(), shoeStyle: t.string(), hatColor: t.string(), glassesColor: t.string(), shoeColor: t.string(), x: t.number().default(0), z: t.number().default(0), rotation: t.number().default(0), sequence: t.number().default(0), jump: t.number().default(0), movementEpoch: t.number().default(0), knocked: t.boolean().default(false), knockCause: t.string().default(""), vehicleId: t.string().default(""), respawnAt: t.number().default(0), protectedUntil: t.number().default(0), trainSeat: t.number().default(-1) });
const Bolt = schema({ id: t.string(), x: t.number(), y: t.number(), z: t.number() });
const Train = schema({ active: t.boolean().default(false), x: t.number().default(0), z: t.number().default(2), rotation: t.number().default(0), phase: t.string().default("waiting"), stopId: t.string().default("entrance"), nextStopId: t.string().default(""), departureAt: t.number().default(0), arrivalAt: t.number().default(0), mode: t.string().default("auto"), intervalSeconds: t.number().default(120), seats: t.number().default(0), revision: t.number().default(0), startStudentId: t.string().default(""), layoutRoster: t.string().default("[]") });
const Vehicle = schema({ id: t.string(), kind: t.string(), rental: t.boolean().default(false), x: t.number(), y: t.number(), z: t.number(), rotation: t.number(), revision: t.number(), driverId: t.string() });
const Santa = schema({ enabled: t.boolean().default(false), x: t.number().default(-29), z: t.number().default(8), rotation: t.number().default(0), nextPoint: t.number().default(1), nextDropAt: t.number().default(0) });
const Present = schema({ id: t.string(), x: t.number(), z: t.number(), droppedAt: t.number(), expiresAt: t.number() });
const Blast = schema({ id: t.string(), x: t.number(), y: t.number(), z: t.number(), detonateAt: t.number() });
const GalleryState = schema({ players: t.map(Player), bolts: t.map(Bolt), train: Train, vehicles: t.map(Vehicle), santa: Santa, presents: t.map(Present), blasts: t.map(Blast), activities: t.boolean().default(true) });
const idleVehicleInput = { throttle: 0, turn: 0, lift: 0 };
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
        AND (gt.actor_kind='teacher' OR EXISTS (SELECT 1 FROM classroom.gallery_student_entry e WHERE e.classroom_id=gt.classroom_id AND e.student_id=gt.student_id AND e.account_id=gt.account_id AND e.entry_allowed))
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

async function stillAllowed(auth, requireOwner = false) {
  if (requireOwner && auth.role !== "teacher") return false;
  const query = auth.role === "teacher"
    ? `SELECT EXISTS(SELECT 1 FROM classroom.sessions s JOIN classroom.teachers t ON t.id=s.teacher_id JOIN classroom.classrooms c ON c.id=$3 JOIN classroom.gallery_worlds w ON w.classroom_id=c.id WHERE s.token_hash=$1 AND s.teacher_id=$2 AND s.expires_at>NOW() AND t.active AND c.owner_id=t.id AND c.archived_at IS NULL AND (NOT $4::boolean OR t.role='owner')) AS allowed`
    : `SELECT EXISTS(SELECT 1 FROM classroom.student_sessions ss JOIN classroom.students s ON s.id=$4 JOIN classroom.classrooms c ON c.id=s.classroom_id JOIN classroom.gallery_worlds w ON w.classroom_id=c.id JOIN classroom.gallery_student_entry e ON e.classroom_id=c.id AND e.student_id=s.id AND e.account_id=ss.account_id WHERE ss.token_hash=$1 AND ss.account_id=$2 AND ss.expires_at>NOW() AND s.classroom_id=$3 AND s.account_id=ss.account_id AND s.archived_at IS NULL AND c.archived_at IS NULL AND w.enabled AND e.entry_allowed) AS allowed`;
  const values = [auth.sessionHash, auth.accountId, auth.classroomId, auth.role === "teacher" ? requireOwner : auth.studentId];
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
  trainFinishing = false;
  trainLastTick = 0;
  trainLastDeparture = 0;
  trainSeats = new Map();
  trainCommandTimes = new Map();
  vehicleInputs = new Map();
  vehicleCommandTimes = new Map();
  worldActionTimes = new Map();
  worldActions = new Set();
  teleportTimes = new Map();
  reservedPads = new Set();
  santaCommandTimes = new Map();
  openingGifts = new Set();
  santaLastTick = 0;
  santaSettings = { fuseSeconds: 5, respawnSeconds: 10 };
  vehicleBounds = { minZ: -35 };

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
      if (!player || player.knocked || player.trainSeat >= 0 || player.vehicleId || now - (this.jumpTimes.get(client.sessionId) ?? 0) < 900) return;
      this.jumpTimes.set(client.sessionId, now); this.jumpStarts.set(client.sessionId, now); player.jump++;
    });
    this.onMessage("cast", (client, message) => { void this.cast(client, message).catch(() => client.send("cast-result", { ok: false })); });
    for (const [command, result, handle] of [
      ["wallet-read", "wallet", (client) => this.wallet(client)],
      ["shop-open", "shop-result", (client) => this.openShop(client)],
      ["shop-buy", "shop-result", (client, message) => this.purchase(client, message)],
      ["ride-start", "vehicle-result", (client, message) => this.startRide(client, message)],
      ["teleport", "teleport-result", (client) => this.teleport(client)],
    ]) {
      this.onMessage(command, (client, message) => {
        void this.worldAction(client, command, result, () => handle(client, message));
      });
    }
    this.onMessage("santa-toggle", (client, message) => { void this.toggleSanta(client, message).catch(() => client.send("santa-result", { ok: false, message: "เปลี่ยนกิจกรรมซานต้าไม่ได้" })); });
    this.onMessage("open-present", (client, message) => { void this.openPresent(client, message).catch(() => client.send("present-result", { ok: false, message: "เปิดของขวัญไม่ได้ กรุณาลองอีกครั้ง" })); });
    this.onMessage("refresh-avatar", (client) => { void this.refreshAvatar(client).catch(() => {}); });
    this.onMessage("train-start", (client, message) => { void this.startTrain(client, message).catch(() => client.send("train-result", { ok: false, message: "เริ่มรถไฟไม่ได้" })); });
    this.onMessage("train-board", (client, message) => { void this.boardTrain(client, message).catch(() => client.send("train-result", { ok: false, message: "ขึ้นรถไฟไม่ได้" })); });
    this.onMessage("train-leave", (client, message) => { void this.leaveTrain(client, message).catch(() => client.send("train-result", { ok: false, message: "ลงจากรถไฟไม่ได้" })); });
    for (const action of ["reset", "enter", "exit"]) {
      this.onMessage("vehicle-" + action, (client, message) => {
        void this.vehicleCommand(client, action, message).catch(() => client.send("vehicle-result", { ok: false, message: "ใช้ยานพาหนะไม่ได้" }));
      });
    }
    this.onMessage("vehicle-input", (client, message) => this.vehicleInput(client, message));
    this.state.train = new Train();
    this.state.santa = new Santa();
    Object.assign(this.state.santa, santaPath[0]);
    this.state.santa.nextPoint = 1;
    this.state.santa.nextDropAt = 0;
    this.santaLastTick = Date.now();
    await this.refreshTrainConfiguration(true).catch(() => {});
    await this.refreshSantaSettings().catch(() => {});
    const readSignature = async () => {
      const { rows } = await pool.query(`SELECT
        (SELECT COUNT(*)::int FROM classroom.files f JOIN classroom.students s ON s.id=f.student_id JOIN classroom.assignments a ON a.id=f.assignment_id WHERE f.classroom_id=$1 AND f.kind IN ('model','submission') AND lower(f.original_name) ~ '\\.(stl|obj|glb|gltf)$' AND s.archived_at IS NULL AND a.archived_at IS NULL) AS files,
        (SELECT COALESCE(MAX(f.created_at)::text,'') FROM classroom.files f WHERE f.classroom_id=$1 AND f.kind IN ('model','submission')) AS latest,
        (SELECT COUNT(*)::int FROM classroom.gallery_hidden_models WHERE classroom_id=$1) AS hidden,
        (SELECT COALESCE(json_agg(json_build_array(file_id,likes) ORDER BY file_id)::text,'[]') FROM (SELECT file_id,COUNT(*)::int AS likes FROM classroom.gallery_likes WHERE classroom_id=$1 GROUP BY file_id) vote_counts) AS likes,
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
    this.combatTimer = setInterval(() => { this.updateCombat(); this.updateTrain(); this.updateVehicles(); this.updateSanta(); }, 50);
    this.trainSettingsTimer = setInterval(() => { void this.refreshTrainConfiguration().catch(() => {}); void this.refreshSantaSettings().catch(() => {}); }, 5000);
  }

  async refreshSantaSettings() {
    const { rows } = await pool.query("SELECT santa_bomb_fuse_seconds AS \"fuseSeconds\", santa_respawn_seconds AS \"respawnSeconds\" FROM classroom.gallery_worlds WHERE classroom_id=$1", [this.classroomId]);
    if (rows[0]) this.santaSettings = { fuseSeconds: Number(rows[0].fuseSeconds), respawnSeconds: Number(rows[0].respawnSeconds) };
  }

  async toggleSanta(client, message) {
    const auth = this.members.get(client.sessionId), now = Date.now();
    if (!auth || auth.role !== "teacher" || typeof message?.enabled !== "boolean" || now - (this.santaCommandTimes.get(`toggle:${client.sessionId}`) ?? 0) < 500) {
      client.send("santa-result", { ok: false, message: "เฉพาะครูประจำห้องเท่านั้นที่จัดกิจกรรมนี้ได้" }); return;
    }
    this.santaCommandTimes.set(`toggle:${client.sessionId}`, now);
    if (!(await stillAllowed(auth).catch(() => false)) || this.members.get(client.sessionId) !== auth) {
      client.send("santa-result", { ok: false, message: "สิทธิ์เข้าห้องเปลี่ยนแล้ว" }); return;
    }
    if (message.enabled === this.state.santa.enabled) {
      client.send("santa-result", { ok: true, enabled: this.state.santa.enabled, message: this.state.santa.enabled ? "กิจกรรมซานต้ากำลังทำงานอยู่แล้ว" : "กิจกรรมซานต้าหยุดอยู่แล้ว" }); return;
    }
    if (message.enabled) {
      Object.assign(this.state.santa, santaPath[0], { enabled: true, nextDropAt: now + presentDropMs });
      this.state.santa.nextPoint = 1;
      this.santaLastTick = now;
    } else this.clearSanta();
    client.send("santa-result", { ok: true, enabled: this.state.santa.enabled, message: this.state.santa.enabled ? "เริ่มกิจกรรมซานต้าตัวแสบแล้ว" : "หยุดกิจกรรมและเก็บของขวัญที่ยังไม่เปิดแล้ว" });
  }

  clearSanta() {
    this.state.santa.enabled = false;
    this.state.santa.nextDropAt = 0;
    this.state.presents.clear();
    this.state.blasts.clear();
    this.openingGifts.clear();
  }

  async openPresent(client, message) {
    const auth = this.members.get(client.sessionId), player = this.state.players.get(client.sessionId), id = message?.id;
    const now = Date.now(), present = typeof id === "string" ? this.state.presents.get(id) : null;
    if (!auth || auth.role !== "student" || !player || !this.state.santa.enabled || player.knocked || player.vehicleId || player.trainSeat >= 0 || !present || this.openingGifts.has(id) || now - (this.santaCommandTimes.get(`open:${client.sessionId}`) ?? 0) < 300 || !canOpenPresent(player, present, now)) {
      client.send("present-result", { ok: false, message: "อยู่ใกล้ของขวัญมากพอและลงจากยานพาหนะก่อนเปิด" }); return;
    }
    this.santaCommandTimes.set(`open:${client.sessionId}`, now);
    this.openingGifts.add(id);
    try {
      if (!(await stillAllowed(auth).catch(() => false)) || this.members.get(client.sessionId) !== auth) {
        client.send("present-result", { ok: false, message: "สิทธิ์เข้าห้องเปลี่ยนแล้ว" }); return;
      }
      const current = this.state.presents.get(id), latest = this.state.players.get(client.sessionId);
      if (!this.state.santa.enabled || current !== present || latest !== player || player.knocked || player.vehicleId || player.trainSeat >= 0 || !canOpenPresent(player, present, Date.now())) {
        client.send("present-result", { ok: false, message: "ของขวัญนี้ถูกเปิดไปแล้วหรือหมดเวลา" }); return;
      }
      const kind = randomInt(2) === 0 ? "bomb" : "points";
      if (kind === "points") {
        const balance = await this.claimPointGift(auth, present);
        this.state.presents.delete(id);
        this.broadcast("present-opened", { id, kind, x: present.x, z: present.z });
        client.send("gift-result", { kind, balance });
      } else {
        this.state.presents.delete(id);
        const blast = new Blast();
        blast.id = randomUUID(); blast.x = present.x; blast.y = 0; blast.z = present.z; blast.detonateAt = Date.now() + this.santaSettings.fuseSeconds * 1000;
        this.state.blasts.set(blast.id, blast);
        this.broadcast("present-opened", { id, kind, x: present.x, z: present.z });
        client.send("gift-result", { kind, detonateAt: blast.detonateAt });
      }
    } catch {
      client.send("present-result", { ok: false, message: "บันทึกของขวัญไม่สำเร็จ ลองเปิดอีกครั้ง" });
    } finally { this.openingGifts.delete(id); }
  }

  async claimPointGift(auth, present) {
    return withStudentWallet(pool, auth, async (client) => {
      const { rows: inserted } = await client.query(`INSERT INTO classroom.gallery_point_claims(gift_id,account_id,classroom_id)
        VALUES($1,$2,$3) ON CONFLICT(gift_id) DO NOTHING RETURNING gift_id`, [present.id, auth.accountId, auth.classroomId]);
      if (!inserted.length) {
        const { rows: claims } = await client.query("SELECT account_id FROM classroom.gallery_point_claims WHERE gift_id=$1", [present.id]);
        if (claims[0]?.account_id !== auth.accountId) throw new Error("Gift was already claimed");
      }
      const { balance } = await readWallet(client, auth);
      if (!this.state.santa.enabled || !this.state.presents.has(present.id)) throw new Error("Santa activity stopped");
      return balance;
    });
  }

  async worldAction(client, command, result, run) {
    const { sessionId } = client;
    const key = sessionId + ":" + command, now = Date.now();
    if (!this.members.has(sessionId) || this.worldActions.has(sessionId) || now - (this.worldActionTimes.get(key) ?? 0) < 200) {
      client.send(result, { ok: false, message: "โปรดรอสักครู่แล้วลองใหม่" });
      return;
    }
    this.worldActionTimes.set(key, now);
    this.worldActions.add(sessionId);
    try { await run(); }
    catch { client.send(result, { ok: false, message: "ดำเนินการไม่ได้ กรุณาลองใหม่" }); }
    finally { this.worldActions.delete(sessionId); }
  }

  visitorAt(client, auth, place) {
    const player = this.state.players.get(client.sessionId);
    return player && this.members.get(client.sessionId) === auth && !player.knocked &&
      !player.vehicleId && player.trainSeat < 0 && nearPlace(player, place) ? player : null;
  }

  async wallet(client) {
    const auth = this.members.get(client.sessionId);
    if (auth?.role !== "student" || !(await stillAllowed(auth))) return;
    const wallet = await readWallet(pool, auth);
    if (this.members.get(client.sessionId) === auth) client.send("wallet", { ok: true, wallet });
  }

  async openShop(client) {
    const auth = this.members.get(client.sessionId);
    if (auth?.role !== "student" || !this.visitorAt(client, auth, shop) || !(await stillAllowed(auth))) throw new Error("Shop unavailable");
    const [wallet, prices] = await Promise.all([readWallet(pool, auth), readShop(pool, auth.classroomId)]);
    if (!this.visitorAt(client, auth, shop) || !prices) throw new Error("Shop unavailable");
    client.send("shop-result", { ok: true, wallet, prices });
  }

  async purchase(client, message) {
    const auth = this.members.get(client.sessionId);
    const eligible = () => this.visitorAt(client, auth, shop);
    const item = message?.item;
    if (auth?.role !== "student" || !eligible() || (item !== "wand" && item !== "license") ||
      !isRequestId(message.requestId) || !Number.isInteger(message.price) || message.price < 1 || message.price > 1000) throw new Error("Invalid purchase");
    const result = await withStudentWallet(pool, auth, (tx, prices) => buyItem(tx, auth, message, prices, eligible));
    client.send("shop-result", result);
  }

  async teleport(client) {
    const { sessionId } = client, auth = this.members.get(sessionId);
    const failed = (message) => client.send("teleport-result", { ok: false, message });
    if (!this.visitorAt(client, auth, portal)) return failed("โปรดเดินเข้าใกล้ท่อก่อนใช้งาน");
    if (Date.now() - (this.teleportTimes.get(sessionId) ?? 0) < 3000) return failed("รอ 3 วินาทีก่อนใช้ท่ออีกครั้ง");
    if (!(await stillAllowed(auth))) throw new Error("Classroom access expired");
    const { rows } = await pool.query(`SELECT s.id FROM classroom.students s
      JOIN classroom.gallery_blocks b ON b.classroom_id=s.classroom_id AND b.student_id=s.id
      WHERE s.classroom_id=$1 AND s.archived_at IS NULL`, [auth.classroomId]);
    const player = this.visitorAt(client, auth, portal);
    if (!player) return failed("โปรดเดินเข้าใกล้ท่อก่อนใช้งาน");
    const active = new Set(rows.map(({ id }) => id));
    const candidates = (this.trainConfig?.roster ?? []).flatMap((block, index) => active.has(block.studentId) ? [{ ...block, index }] : []);
    if (!candidates.length) return failed("ยังไม่มีพื้นที่นักเรียนที่เปิดอยู่");
    const target = candidates[randomInt(candidates.length)], position = blockPosition(target.index);
    this.resetPosition(sessionId, player, position.x, position.z + BLOCK_DEPTH / 2 + 1.5, Math.PI);
    this.teleportTimes.set(sessionId, Date.now());
    client.send("teleport-result", { ok: true, message: `ถึงพื้นที่ของ ${target.displayName} แล้ว` });
  }

  resetPosition(sessionId, player, x, z, rotation) {
    Object.assign(player, { x, z, rotation, jump: 0, movementEpoch: player.movementEpoch + 1 });
    this.jumpStarts.delete(sessionId);
    this.movementTimes.set(sessionId, Date.now());
  }

  updateSanta() {
    const now = Date.now(), santa = this.state.santa;
    if (!santa.enabled) { this.santaLastTick = now; return; }
    advanceSanta(santa, Math.min(0.1, Math.max(0, (now - this.santaLastTick) / 1000)));
    this.santaLastTick = now;
    for (const [id, present] of this.state.presents) if (present.expiresAt <= now) this.state.presents.delete(id);
    if (now >= santa.nextDropAt) {
      santa.nextDropAt = now + presentDropMs;
      if (this.state.presents.size < maxPresents) {
        const present = new Present(); present.id = randomUUID(); present.x = santa.x; present.z = santa.z; present.droppedAt = now; present.expiresAt = now + presentLifetimeMs;
        this.state.presents.set(present.id, present);
      }
    }
    for (const [id, blast] of this.state.blasts) {
      if (blast.detonateAt > now) continue;
      for (const [sessionId, player] of this.state.players) {
        if (player.knocked || player.protectedUntil > now) continue;
        const started = this.jumpStarts.get(sessionId) ?? -Infinity, elapsed = (now - started) / 1000;
        const jump = elapsed > 0 && elapsed < 0.75 ? Math.max(0, 6 * elapsed - 8 * elapsed * elapsed) : 0;
        const vehicle = this.state.vehicles.get(player.vehicleId);
        const vehicleHeight = vehicle ? vehicle.y + 0.58 : 0;
        if (insideBombRadius(player, blast, jump + vehicleHeight)) this.knockAvatar(sessionId, player, now, "santa", this.santaSettings.respawnSeconds * 1000);
      }
      this.state.blasts.delete(id);
      this.broadcast("santa-explosion", { id, x: blast.x, y: blast.y, z: blast.z });
    }
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
    const life = this.lifeStates.get(auth.accountId);
    if (life) respawnPlayer(life, Date.now());
    if (life && (life.knocked || life.protectedUntil > Date.now())) Object.assign(player, life);
    else { player.x = Math.random() * 4 - 2; player.z = Math.random() * 4 - 2; }
    player.trainSeat = -1;
    this.state.players.set(client.sessionId, player);
    this.movementTimes.set(client.sessionId, Date.now());
  }

  move(client, message) {
    const player = this.state.players.get(client.sessionId);
    if (!player || !message || player.knocked || player.trainSeat >= 0 || player.vehicleId || message.movementEpoch !== player.movementEpoch) return;
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
      pool.query(`SELECT w.train_mode AS mode, w.train_interval_seconds AS "intervalSeconds", CASE WHEN s.id IS NOT NULL THEN s.id ELSE NULL END AS "startStudentId", w.train_station_wait_seconds AS waits
        FROM classroom.gallery_worlds w LEFT JOIN classroom.students s ON s.id=w.train_start_student_id AND s.classroom_id=w.classroom_id AND s.archived_at IS NULL AND s.student_number IS NOT NULL WHERE w.classroom_id=$1`, [this.classroomId]),
      pool.query(`SELECT id, student_number AS "studentNumber", display_name AS "displayName" FROM classroom.students WHERE classroom_id=$1 AND archived_at IS NULL ORDER BY student_number NULLS LAST, display_name, id`, [this.classroomId]),
    ]);
    const world = worlds[0] ?? { mode: "auto", intervalSeconds: 120, startStudentId: null };
    const startIndex = world.startStudentId ? roster.findIndex((student) => student.id === world.startStudentId) : -1;
    const route = trainTrack(roster.length, startIndex < 0 ? null : startIndex);
    return { mode: world.mode, intervalSeconds: Number(world.intervalSeconds), startStudentId: startIndex < 0 ? null : world.startStudentId, waits: world.waits ?? {}, roster: roster.map((student) => ({ studentId: student.id, studentNumber: student.studentNumber, displayName: student.displayName })), route };
  }

  async refreshTrainConfiguration(initial = false) {
    const config = await this.readTrainConfiguration();
    const signature = JSON.stringify(config);
    if (signature === this.trainConfig?.signature) { this.pendingTrainConfig = null; return; }
    config.signature = signature;
    if (initial || (!this.trainFinishing && !this.trainCircuitActive && this.state.train.phase === "waiting" && this.trainSeats.size === 0)) this.applyTrainConfiguration(config);
    else this.pendingTrainConfig = config;
  }

  applyTrainConfiguration(config, schedule = true) {
    this.trainConfig = config;
    this.trainRoute = config.route;
    this.vehicleBounds.minZ = Math.min(-25, ...config.route.map((point) => point.z)) - 10;
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
    train.departureAt = schedule ? firstDepartureAt(Date.now(), config.mode, stationWaitMs(config.waits, train.stopId, true)) : 0;
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
    if (!auth || auth.role !== "teacher" || !message || message.revision !== train.revision || train.mode !== "manual" || train.phase !== "waiting" || !train.active || this.trainFinishing || now - (this.trainCommandTimes.get(commandKey) ?? 0) < 500) { client.send("train-result", { ok: false, message: "รถไฟไม่พร้อมออกหรือข้อมูลเปลี่ยนแล้ว" }); return; }
    this.trainCommandTimes.set(commandKey, now);
    if (!(await stillAllowed(auth).catch(() => false)) || this.members.get(client.sessionId) !== auth) { client.leave(4003, "Classroom access expired"); return; }
    const latest = await this.readTrainConfiguration().catch(() => null);
    if (this.members.get(client.sessionId) !== auth) return;
    if (message.revision !== train.revision || train.mode !== "manual" || train.phase !== "waiting" || this.trainFinishing) { client.send("train-result", { ok: false, message: "รถไฟเริ่มไปแล้วหรือข้อมูลเปลี่ยนแล้ว" }); return; }
    if (latest && this.trainConfig) {
      latest.signature = JSON.stringify(latest);
      if (this.trainSeats.size === 0 && latest.signature !== this.trainConfig.signature) {
        this.applyTrainConfiguration(latest);
        if (train.mode !== "manual" || !train.active) { client.send("train-result", { ok: false, message: "ตารางรถไฟเปลี่ยนแล้ว" }); return; }
      } else {
        this.trainConfig.waits = latest.waits;
      }
    }
    train.stopId = this.trainRoute[this.trainLegIndex]?.id ?? "entrance";
    const wait = stationWaitMs(this.trainConfig?.waits, train.stopId, true);
    train.phase = "boarding"; train.departureAt = Date.now() + wait;
    client.send("train-result", { ok: true, message: `รถไฟจะออกใน ${wait / 1000} วินาที` });
  }

  async boardTrain(client, message) {
    const auth = this.members.get(client.sessionId), player = this.state.players.get(client.sessionId), train = this.state.train, now = Date.now();
    const commandKey = auth ? `board:${auth.accountId}` : "";
    const last = auth ? this.trainCommandTimes.get(commandKey) ?? 0 : 0;
    if (!auth || !player || !message || message.revision !== train.revision || player.trainSeat >= 0 || player.knocked || player.vehicleId || this.trainFinishing || !canBoardTrain({ active: train.active, phase: train.phase, seats: this.trainSeats.size, distance: Math.hypot(player.x - train.x, player.z - train.z) }) || now - last < 250) { client.send("train-result", { ok: false, message: "อยู่ใกล้สถานีและรอให้รถหยุดก่อนขึ้นรถไฟ" }); return; }
    this.trainCommandTimes.set(commandKey, now);
    if (!(await stillAllowed(auth).catch(() => false)) || this.members.get(client.sessionId) !== auth) { client.leave(4003, "Classroom access expired"); return; }
    if (message.revision !== train.revision || player.trainSeat >= 0 || player.knocked || player.vehicleId || this.trainFinishing || !canBoardTrain({ active: train.active, phase: train.phase, seats: this.trainSeats.size, distance: Math.hypot(player.x - train.x, player.z - train.z) })) { client.send("train-result", { ok: false, message: "รถไฟออกแล้วหรือไม่มีที่นั่งว่าง" }); return; }
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
      const from = { x: train.x, y: 0, z: train.z };
      if (distance <= remaining + 0.001) {
        train.x = target.x; train.z = target.z; if (distance > 0) train.rotation = Math.atan2(dx, dz);
        remaining -= distance; this.trainLegIndex = nextIndex;
        this.collideVehicle(from, { x: train.x, y: 0, z: train.z, rotation: train.rotation }, trainBodies, "train", now);
        if (nextIndex === 0) { void this.finishTrainCircuit(now); return; }
        if (target.id) { train.phase = "dwell"; train.stopId = target.id; train.arrivalAt = now; train.departureAt = now + stationWaitMs(this.trainConfig?.waits, target.id, false); this.updateTrainNextStop(); this.syncTrainRiders(); return; }
        continue;
      }
      const fraction = remaining / distance; train.x += dx * fraction; train.z += dz * fraction; train.rotation = Math.atan2(dx, dz); remaining = 0;
      this.collideVehicle(from, { x: train.x, y: 0, z: train.z, rotation: train.rotation }, trainBodies, "train", now);
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
    this.trainFinishing = true;
    train.phase = "waiting"; train.stopId = this.trainRoute[0]?.id ?? "entrance"; train.arrivalAt = now; train.departureAt = 0;
    for (const [sessionId, seat] of this.trainSeats) {
      const player = this.state.players.get(sessionId);
      if (player) { player.trainSeat = -1; player.x = train.x + 2 + (seat % 3); player.z = train.z + 3; player.rotation = 0; player.movementEpoch++; }
    }
    this.trainSeats.clear(); train.seats = 0; this.trainCircuitActive = false;
    const config = await this.readTrainConfiguration().catch(() => this.pendingTrainConfig ?? this.trainConfig);
    if (config) { config.signature = JSON.stringify(config); this.pendingTrainConfig = null; this.applyTrainConfiguration(config, false); }
    this.trainFinishing = false;
    if (!train.active) return;
    train.phase = train.mode === "auto" ? "boarding" : "waiting";
    train.departureAt = nextDepartureAt(train.mode, train.intervalSeconds, this.trainLastDeparture, now, stationWaitMs(this.trainConfig?.waits, train.stopId, true));
  }

  async vehicleCommand(client, action, message) {
    const { sessionId } = client;
    const auth = this.members.get(sessionId), player = this.state.players.get(sessionId);
    const id = message?.id ?? message?.kind;
    const now = Date.now();
    const result = (ok, text) => client.send("vehicle-result", { ok, message: text });
    if (!auth || !player || (!vehicleKinds.includes(id) && !this.state.vehicles.has(id))) return;
    const commandKey = sessionId + ":" + action;
    if (now - (this.vehicleCommandTimes.get(commandKey) ?? 0) < 300) {
      result(false, "โปรดรอสักครู่แล้วลองใหม่"); return;
    }
    this.vehicleCommandTimes.set(commandKey, now);
    if (!(await stillAllowed(auth, action === "reset")) || this.members.get(sessionId) !== auth) {
      result(false, "คุณไม่มีสิทธิ์ใช้คำสั่งนี้"); return;
    }
    const vehicles = this.state.vehicles, current = vehicles.get(id);
    if (message.revision !== (current?.revision ?? 0)) {
      result(false, "สถานะยานพาหนะเปลี่ยนไปแล้ว กรุณาลองใหม่"); return;
    }
    if (action === "reset") {
      if ((current?.driverId ?? "") !== message.confirmedDriverId) {
        result(false, "คนขับเปลี่ยนแล้ว กรุณายืนยันใหม่"); return;
      }
      if (current?.rental) {
        this.releaseVehicle(current, depot);
        result(true, "สิ้นสุดการขับขี่และส่งคนขับกลับจุดรับรถ");
        return;
      }
      const spec = vehicleSpecs[id];
      if (!spec || !vehicleKinds.includes(id)) return;
      if (current?.driverId) this.releaseVehicle(current, { x: spec.bayX + 2.5, z: VEHICLE_BAY_Z });
      const vehicle = new Vehicle();
      Object.assign(vehicle, { id, kind: id, x: spec.bayX, y: 0, z: VEHICLE_BAY_Z, rotation: Math.PI, driverId: "", revision: (current?.revision ?? 0) + 1 });
      vehicles.set(id, vehicle);
      result(true, "ยานพาหนะพร้อมที่จุดจอด"); return;
    }
    if (action === "exit") {
      if (!current || current.driverId !== sessionId || player.vehicleId !== id) return;
      if (current.y > LANDING_HEIGHT) { result(false, "ลงจอดก่อนลงจากยานพาหนะ"); return; }
      this.releaseVehicle(current);
      result(true, "ออกจากยานพาหนะแล้ว"); return;
    }
    if (auth.role === "student") { result(false, "เลือกยานพาหนะที่จุดรับรถด้วยใบขับขี่"); return; }
    if (!current || current.rental || current.driverId || player.knocked || player.vehicleId || player.trainSeat >= 0 || this.worldActions.has(sessionId)
      || current.y > LANDING_HEIGHT || Math.hypot(player.x - current.x, player.z - current.z) > VEHICLE_ENTER_DISTANCE) {
      result(false, "ยานพาหนะไม่ว่างหรืออยู่ไกลเกินไป"); return;
    }
    this.mountVehicle(sessionId, player, current);
    result(true, "พร้อมขับยานพาหนะ");
  }

  async startRide(client, message) {
    const { sessionId } = client, auth = this.members.get(sessionId);
    const result = (ok, message) => client.send("vehicle-result", { ok, message });
    if (auth?.role !== "student" || !vehicleKinds.includes(message?.kind) || !isRequestId(message.requestId)) return result(false, "เลือกยานพาหนะที่จุดรับรถ");
    const player = this.visitorAt(client, auth, depot);
    if (!player) return result(false, "เดินเข้าใกล้จุดรับรถก่อนเริ่มขับ");
    const epoch = player.movementEpoch;
    const isClear = (pad) => {
      const nearby = (object, distance) => Math.hypot(object.x - pad.x, object.z - pad.z) < distance;
      return ![...this.state.players.values()].some((avatar) => nearby(avatar, 2.7)) &&
        ![...this.state.vehicles.values()].some((vehicle) => vehicle.y < 3 && nearby(vehicle, 4.5));
    };
    const pad = rentalPads.find((candidate) => !this.reservedPads.has(candidate) && isClear(candidate));
    if (!pad) return result(false, "จุดรับรถเต็ม ใบขับขี่ยังใช้ได้ กรุณาลองใหม่");
    this.reservedPads.add(pad);
    const eligible = () => this.visitorAt(client, auth, depot) === player && player.movementEpoch === epoch && isClear(pad);
    try {
      const remaining = await withStudentWallet(pool, auth, (tx) => useItem(tx, auth, "license", message.requestId, eligible));
      if (remaining === null) return result(false, "ต้องมีใบขับขี่ที่ยังไม่ได้ใช้");
      client.send("license-used", {});
      if (!eligible()) return result(false, "การขับขี่สิ้นสุดแล้ว");
      const vehicle = new Vehicle();
      Object.assign(vehicle, { id: randomUUID(), kind: message.kind, rental: true, ...pad, y: 0, rotation: Math.PI, revision: 0, driverId: "" });
      this.mountVehicle(sessionId, player, vehicle);
      this.state.vehicles.set(vehicle.id, vehicle);
      result(true, "เริ่มขับขี่แล้ว");
    } finally { this.reservedPads.delete(pad); }
  }

  mountVehicle(sessionId, player, vehicle) {
    vehicle.driverId = sessionId;
    vehicle.revision++;
    player.vehicleId = vehicle.id;
    this.resetPosition(sessionId, player, vehicle.x, vehicle.z, vehicle.rotation);
  }

  releaseVehicle(vehicle, position) {
    if (!vehicle?.driverId) return;
    const player = this.state.players.get(vehicle.driverId);
    if (player) {
      const side = vehicle.x > 0 ? -2.5 : 2.5;
      player.vehicleId = "";
      this.resetPosition(vehicle.driverId, player, position?.x ?? vehicle.x + side, position?.z ?? vehicle.z, vehicle.rotation);
    }
    this.vehicleInputs.delete(vehicle.id);
    if (vehicle.rental) { this.state.vehicles.delete(vehicle.id); return; }
    vehicle.driverId = "";
    vehicle.y = 0;
    vehicle.revision++;
  }

  vehicleInput(client, message) {
    const player = this.state.players.get(client.sessionId);
    if (!player?.vehicleId || player.knocked || message?.epoch !== player.movementEpoch || !validVehicleInput(message)) return;
    const vehicle = this.state.vehicles.get(player.vehicleId);
    if (vehicle?.driverId !== client.sessionId || vehicle.revision !== message.revision) return;
    const at = Date.now();
    if (at - (this.vehicleInputs.get(vehicle.id)?.at ?? 0) < 35) return;
    const { throttle, turn, lift } = message;
    this.vehicleInputs.set(vehicle.id, { throttle, turn, lift, at });
  }

  updateVehicles() {
    const now = Date.now();
    for (const vehicle of this.state.vehicles.values()) {
      if (!vehicle.driverId) continue;
      const player = this.state.players.get(vehicle.driverId);
      if (!player) { this.releaseVehicle(vehicle); continue; }
      const input = this.vehicleInputs.get(vehicle.id);
      const active = input && now - input.at <= 300 ? input : idleVehicleInput;
      const from = { x: vehicle.x, y: vehicle.y, z: vehicle.z };
      const next = advanceVehicle(vehicle, active, 0.05, this.vehicleBounds);
      Object.assign(vehicle, next);
      player.x = next.x; player.z = next.z; player.rotation = next.rotation;
      this.collideVehicle(from, next, [vehicleSpecs[vehicle.kind]], vehicle.kind, now);
    }
  }

  collideVehicle(from, to, bodies, cause, now) {
    if (Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) < 0.001) return;
    for (const [sessionId, player] of this.state.players) {
      if (player.knocked || player.protectedUntil > now || player.trainSeat >= 0 || player.vehicleId) continue;
      const elapsed = (now - (this.jumpStarts.get(sessionId) ?? -Infinity)) / 1000;
      const height = elapsed < 0.75 ? Math.max(0, 6 * elapsed - 8 * elapsed * elapsed) : 0;
      if (bodies.some((body) => hitsMovingBody(from, to, body, player, height))) this.knockAvatar(sessionId, player, now, cause);
    }
  }

  knockAvatar(sessionId, player, now, cause, cooldownMs) {
    if (!knockPlayer(player, now, cause, cooldownMs)) return false;
    if (player.trainSeat >= 0) {
      this.trainSeats.delete(sessionId);
      player.trainSeat = -1;
      this.state.train.seats = this.trainSeats.size;
    }
    if (player.vehicleId) this.releaseVehicle(this.state.vehicles.get(player.vehicleId));
    this.jumpStarts.delete(sessionId);
    this.clients.find((client) => client.sessionId === sessionId)?.send("knocked", { respawnAt: player.respawnAt, cause });
    return true;
  }

  async cast(client, message) {
    const auth=this.members.get(client.sessionId), player=this.state.players.get(client.sessionId), aim=validAim(message), now=Date.now();
    if (aim) aim.shotId = aim.shotId.toLowerCase();
    if (!auth || !player || player.knocked || player.vehicleId || !aim || now-(this.castTimes.get(auth.accountId)??0)<2000 || this.usedShotIds.has(aim.shotId)) {
      client.send("cast-result",{ok:false}); return;
    }
    this.usedShotIds.add(aim.shotId);
    if (this.usedShotIds.size > 4096) this.usedShotIds.delete(this.usedShotIds.values().next().value);
    this.castTimes.set(auth.accountId,now);
    const epoch = player.movementEpoch;
    let origin;
    const eligible = () => {
      if (this.members.get(client.sessionId) !== auth || player.knocked || player.vehicleId ||
        player.movementEpoch !== epoch || (auth.role === "student" && player.trainSeat >= 0)) return false;
      origin = { x: player.x + Math.sin(player.rotation) * 0.45, y: 1.45, z: player.z + Math.cos(player.rotation) * 0.45 };
      return true;
    };
    let spells;
    if (auth.role === "student") {
      if (!eligible() || this.worldActions.has(client.sessionId)) { client.send("cast-result", { ok: false }); return; }
      spells = await withStudentWallet(pool, auth, (tx) => useItem(tx, auth, "wand", aim.shotId, eligible));
      if (spells === null) { client.send("cast-result", { ok: false }); return; }
    } else if (!(await stillAllowed(auth)) || !eligible()) { client.send("cast-result", { ok: false }); return; }
    const bolt = new Bolt();
    Object.assign(bolt, origin, { id: aim.shotId });
    const details={...aim,x:bolt.x,y:bolt.y,z:bolt.z,travelled:0,accountId:auth.accountId};
    this.state.bolts.set(bolt.id,bolt); this.boltDetails.set(bolt.id,details);
    client.send("cast-result",{ok:true, spells});
  }

  boltDetails = new Map();
  updateCombat() {
    const now=Date.now();
    for (const [accountId, life] of this.lifeStates) {
      respawnPlayer(life, now);
      if (!life.knocked && life.protectedUntil <= now) this.lifeStates.delete(accountId);
    }
    for (const client of this.clients) {
      const auth=this.members.get(client.sessionId), player=this.state.players.get(client.sessionId);
      if (auth && player && player.knocked && respawnPlayer(player,now)) {
        player.jump=0;
        this.jumpStarts.delete(client.sessionId);
        client.send("respawn",{movementEpoch:player.movementEpoch,x:player.x,z:player.z});
      }
    }
    for (const [id,bolt] of this.state.bolts) {
      const details=this.boltDetails.get(id); if (!details) { this.state.bolts.delete(id); continue; }
      const {from,to,expired}=advanceBolt(details,0.05);
      bolt.x=to.x; bolt.y=to.y; bolt.z=to.z;
      let hit=null, nearest=1;
      for (const [sessionId,player] of this.state.players) {
        if (player.role!=="student" || this.members.get(sessionId)?.accountId === details.accountId || player.knocked || player.protectedUntil>now) continue;
        const started=this.jumpStarts.get(sessionId)??-Infinity, elapsed=(now-started)/1000;
        const jump=elapsed>0&&elapsed<0.75?Math.max(0,6*elapsed-8*elapsed*elapsed):0;
        const altitude = this.state.vehicles.get(player.vehicleId)?.y ?? 0;
        const fraction=playerHitFraction(from,to,player,jump + altitude);
        if (fraction!==null && fraction<nearest) { nearest=fraction; hit={sessionId,player,x:from.x+(to.x-from.x)*fraction,y:from.y+(to.y-from.y)*fraction,z:from.z+(to.z-from.z)*fraction}; }
      }
      if (hit) {
        if (this.knockAvatar(hit.sessionId, hit.player, now, "wand")) this.broadcast("wand-impact",{id,x:hit.x,y:hit.y,z:hit.z});
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
    if (player?.vehicleId) this.releaseVehicle(this.state.vehicles.get(player.vehicleId));
    if (auth && player && (player.knocked || player.protectedUntil > Date.now())) {
      this.lifeStates.set(auth.accountId, {
        x: player.x, z: player.z, rotation: player.rotation, knocked: player.knocked, knockCause: player.knockCause,
        respawnAt: player.respawnAt, protectedUntil: player.protectedUntil, movementEpoch: player.movementEpoch,
      });
    } else if (auth) this.lifeStates.delete(auth.accountId);
    for (const times of [this.vehicleCommandTimes, this.worldActionTimes]) {
      for (const key of times.keys()) if (key.startsWith(client.sessionId + ":")) times.delete(key);
    }
    this.teleportTimes.delete(client.sessionId);
    if (this.trainSeats.delete(client.sessionId)) this.state.train.seats=this.trainSeats.size;
    if (auth) for (const action of ["start", "board", "leave"]) this.trainCommandTimes.delete(`${action}:${auth.accountId}`);
    this.santaCommandTimes.delete(`toggle:${client.sessionId}`);
    this.santaCommandTimes.delete(`open:${client.sessionId}`);
    this.state.players.delete(client.sessionId);
    this.members.delete(client.sessionId);
    this.movementTimes.delete(client.sessionId);
    this.movementMessages.delete(client.sessionId);
    this.appearanceTimes.delete(client.sessionId);
    this.jumpTimes.delete(client.sessionId);
    this.jumpStarts.delete(client.sessionId);
  }

  onDispose() { clearInterval(this.accessTimer); clearInterval(this.galleryTimer); clearInterval(this.worldTimer); clearInterval(this.combatTimer); clearInterval(this.trainSettingsTimer); this.state.bolts.clear(); this.boltDetails.clear(); this.lifeStates.clear(); this.usedShotIds.clear(); this.trainSeats.clear(); this.trainCommandTimes.clear(); this.santaCommandTimes.clear(); this.openingGifts.clear(); this.state.presents.clear(); this.state.blasts.clear(); this.state.vehicles.clear(); this.vehicleInputs.clear(); this.vehicleCommandTimes.clear(); }
}

const gameServer = new Server({
  express: (app) => app.get("/__gallery_protocol", (_request, response) => response.type("text").send("shop-v1")),
});
gameServer.define("classroom", ClassroomGallery).filterBy(["classroomId"]);
await gameServer.listen(Number(process.env.PORT ?? 2567));
console.log(`Classroom Colyseus server listening on ${process.env.PORT ?? 2567}`);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => { await gameServer.gracefullyShutdown(false); await pool.end(); process.exit(0); });
