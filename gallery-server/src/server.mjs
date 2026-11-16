import { createHash } from "node:crypto";
import { Server, Room, ServerError } from "colyseus";
import { schema, t } from "@colyseus/schema";
import pg from "pg";
import { boundedMove } from "./movement.mjs";
import { applyAppearance } from "./avatar.mjs";
import { databaseConfig } from "./database-config.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool(databaseConfig());
const Player = schema({ displayName: t.string(), role: t.string(), skinColor: t.string(), hairColor: t.string(), shirtColor: t.string(), trousersColor: t.string(), hairStyle: t.string(), x: t.number().default(0), z: t.number().default(0), rotation: t.number().default(0), sequence: t.number().default(0), jump: t.number().default(0) });
const GalleryState = schema({ players: t.map(Player) });
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function consumeTicket(token, classroomId) {
  if (typeof token !== "string" || token.length > 100) throw new ServerError(4001, "Invalid room ticket");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT gt.*, c.name AS classroom_name
      FROM classroom.gallery_tickets gt JOIN classroom.classrooms c ON c.id=gt.classroom_id
      JOIN classroom.gallery_worlds w ON w.classroom_id=c.id
      WHERE gt.token_hash=$1 AND gt.classroom_id=$2 AND gt.expires_at>NOW() AND gt.consumed_at IS NULL AND w.enabled AND c.archived_at IS NULL
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
    ? `SELECT EXISTS(SELECT 1 FROM classroom.sessions s JOIN classroom.teachers t ON t.id=s.teacher_id JOIN classroom.classrooms c ON c.id=$3 JOIN classroom.gallery_worlds w ON w.classroom_id=c.id WHERE s.token_hash=$1 AND s.teacher_id=$2 AND s.expires_at>NOW() AND t.active AND c.owner_id=t.id AND c.archived_at IS NULL AND w.enabled) AS allowed`
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
      if (!player || now - (this.jumpTimes.get(client.sessionId) ?? 0) < 900) return;
      this.jumpTimes.set(client.sessionId, now); player.jump++;
    });
    this.onMessage("refresh-avatar", (client) => { void this.refreshAvatar(client).catch(() => {}); });
    const readSignature = async () => {
      const { rows } = await pool.query(`SELECT
        (SELECT COUNT(*)::int FROM classroom.files f JOIN classroom.students s ON s.id=f.student_id JOIN classroom.assignments a ON a.id=f.assignment_id WHERE f.classroom_id=$1 AND f.kind IN ('model','submission') AND lower(f.original_name) ~ '\\.(stl|obj)$' AND s.archived_at IS NULL AND a.archived_at IS NULL) AS files,
        (SELECT COALESCE(MAX(f.created_at)::text,'') FROM classroom.files f WHERE f.classroom_id=$1 AND f.kind IN ('model','submission')) AS latest,
        (SELECT COUNT(*)::int FROM classroom.gallery_hidden_models WHERE classroom_id=$1) AS hidden,
        (SELECT COUNT(*)::int FROM classroom.gallery_likes WHERE classroom_id=$1) AS likes,
        (SELECT COUNT(*)::int FROM classroom.students WHERE classroom_id=$1 AND archived_at IS NULL) AS students,
        (SELECT enabled FROM classroom.gallery_worlds WHERE classroom_id=$1) AS enabled`, [this.classroomId]);
      return JSON.stringify(rows[0]);
    };
    let signature = await readSignature().catch(() => "");
    this.galleryTimer = setInterval(async () => {
      const next = await readSignature().catch(() => signature);
      if (next !== signature) { signature = next; this.broadcast("gallery-refresh"); }
      await this.refreshAppearances().catch(() => {});
    }, 20000);
    this.accessTimer = setInterval(async () => {
      for (const client of [...this.clients]) {
        const auth = this.members.get(client.sessionId);
        if (auth && !(await stillAllowed(auth).catch(() => false))) client.leave(4003, "Classroom access expired");
      }
    }, 15000);
  }

  onJoin(client, _options, auth) {
    if ([...this.members.values()].some((member) => member.accountId === auth.accountId)) {
      client.leave(4009, "This account is already in the classroom world");
      return;
    }
    this.members.set(client.sessionId, auth);
    const player = new Player();
    player.displayName = auth.displayName;
    player.role = auth.role;
    applyAppearance(player, auth.appearance);
    player.x = Math.random() * 4 - 2;
    player.z = Math.random() * 4 - 2;
    this.state.players.set(client.sessionId, player);
    this.movementTimes.set(client.sessionId, Date.now());
  }

  move(client, message) {
    const player = this.state.players.get(client.sessionId);
    if (!player || !message) return;
    const now = Date.now();
    const count = this.movementMessages.get(client.sessionId) ?? { start: now, total: 0 };
    if (now - count.start > 1000) { count.start = now; count.total = 0; }
    if (++count.total > 20) return;
    this.movementMessages.set(client.sessionId, count);
    const elapsed = Math.min(1, Math.max(0.05, (now - (this.movementTimes.get(client.sessionId) ?? now)) / 1000));
    const next = boundedMove(player, message, elapsed);
    if (Number.isSafeInteger(message.sequence) && message.sequence > player.sequence) player.sequence = message.sequence;
    this.movementTimes.set(client.sessionId, now);
    if (!next) return;
    player.x = next.x;
    player.z = next.z;
    player.rotation = next.rotation;
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
    this.state.players.delete(client.sessionId);
    this.members.delete(client.sessionId);
    this.movementTimes.delete(client.sessionId);
    this.movementMessages.delete(client.sessionId);
    this.appearanceTimes.delete(client.sessionId);
    this.jumpTimes.delete(client.sessionId);
  }

  onDispose() { clearInterval(this.accessTimer); clearInterval(this.galleryTimer); }
}

const gameServer = new Server({ express: (app) => app.get("/__healthcheck", (_request, response) => response.status(200).type("text").send("OK")) });
gameServer.define("classroom", ClassroomGallery).filterBy(["classroomId"]);
await gameServer.listen(Number(process.env.PORT ?? 2567));
console.log(`Classroom Colyseus server listening on ${process.env.PORT ?? 2567}`);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => { await gameServer.gracefullyShutdown(false); await pool.end(); process.exit(0); });
