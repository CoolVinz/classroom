import { createHash } from "node:crypto";
import { Room, ServerError } from "colyseus";
import { schema, t } from "@colyseus/schema";
import { defaultAppearance, applyAppearance } from "./avatar.mjs";
import { activityHeight, activityWidth, activitySpawn, zoneCenter, zoneChoice } from "./live-activity-layout.mjs";

const Player = schema({
  displayName: t.string(), role: t.string(),
  ...Object.fromEntries(Object.keys(defaultAppearance).map((key) => [key, t.string()])),
  x: t.number(), y: t.number(), selected: t.number().default(-1),
});
const ActivityState = schema({ players: t.map(Player), questionIndex: t.number().default(-1), phase: t.string().default("lobby") });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const accessQuery = `
  SELECT ss.token_hash AS "sessionHash", s.id AS "studentId", a.id AS "accountId",
    s.display_name AS "displayName", a.avatar_settings AS appearance, 'student' AS role
  FROM classroom.student_sessions ss JOIN classroom.student_accounts a ON a.id=ss.account_id
  JOIN classroom.students s ON s.account_id=a.id AND s.classroom_id=$1 AND s.archived_at IS NULL
  WHERE ss.token_hash=ANY($2::text[]) AND ss.expires_at > clock_timestamp()
  UNION ALL
  SELECT ss.token_hash, NULL, t.id, t.display_name, t.avatar_settings, 'teacher'
  FROM classroom.sessions ss JOIN classroom.teachers t ON t.id=ss.teacher_id
  JOIN classroom.classrooms c ON c.id=$1 AND c.owner_id=t.id
  WHERE ss.token_hash=ANY($2::text[]) AND ss.expires_at > clock_timestamp() AND t.active`;

const activeQuery = `
  SELECT l.classroom_id AS "classroomId", l.question_index AS "questionIndex", l.revision,
    CASE WHEN l.phase='answering' AND l.deadline <= clock_timestamp() THEN 'revealed' ELSE l.phase END AS phase,
    CASE WHEN l.question_index < 0 THEN 0
      WHEN l.kind='poll' AND l.poll_snapshot->>'mode'='walk' THEN jsonb_array_length(l.poll_snapshot->'choices')
      WHEN l.kind='quiz' THEN jsonb_array_length(l.content_snapshot->'questions'->l.question_index->'choices')
      ELSE 0 END AS "choiceCount"
  FROM classroom.live_activities l JOIN classroom.classrooms c ON c.id=l.classroom_id
  LEFT JOIN classroom.quizzes q ON q.id=l.quiz_id
  WHERE l.id=$1 AND c.archived_at IS NULL AND q.trashed_at IS NULL AND l.phase NOT IN ('finished','cancelled')`;

export function liveActivityRoom(pool) {
  const rooms = new Map();
  return class LiveActivityRoom extends Room {
    maxClients = 51;
    state = new ActivityState();
    members = new Map();
    choiceCount = 0;
    revision = -1;

    onCreate({ activityId }) {
      if (typeof activityId !== "string" || !uuid.test(activityId) || rooms.has(activityId)) {
        throw new ServerError(4004, "Activity room is unavailable");
      }
      this.activityId = activityId;
      rooms.set(activityId, this);
      this.setPatchRate(80);
      this.onMessage("step", (client, input) => this.move(client, input, false));
      this.onMessage("area", (client, input) => this.move(client, input, true));
      this.clock.setInterval(() => void this.refresh().catch(() => {}), 700);
    }

    async onAuth(client, options) {
      const { ticket } = options;
      if (options.activityId !== this.activityId || typeof ticket !== "string" || !/^[\w-]{43}$/.test(ticket)) {
        throw new ServerError(4001, "Invalid activity ticket");
      }
      const db = await pool.connect();
      let reserved = false;
      try {
        await db.query("BEGIN");
        const { rows: tickets } = await db.query(`DELETE FROM classroom.live_activity_tickets
          WHERE token_hash=$1 AND activity_id=$2 AND expires_at > clock_timestamp() RETURNING account_id, session_hash, actor_kind`,
        [createHash("sha256").update(ticket).digest("hex"), this.activityId]);
        const { rows: [activity] } = await db.query(activeQuery + " FOR SHARE OF l,c", [this.activityId]);
        if (!tickets.length || !activity) throw new ServerError(4001, "Activity ticket expired");
        const credential = tickets[0];
        const { rows } = await db.query(accessQuery, [activity.classroomId, [credential.session_hash]]);
        const member = rows.find((row) => row.accountId === credential.account_id && row.role === credential.actor_kind);
        if (!member) throw new ServerError(4001, "Classroom access expired");
        if ([...this.members.values()].some((player) => player.accountId === member.accountId)) {
          throw new ServerError(4009, "Account already connected");
        }
        if (member.role === "student" && [...this.members.values()].filter((player) => player.role === "student").length >= 50) {
          throw new ServerError(4008, "Activity room is full");
        }
        member.seat = Array.from({ length: 51 }, (_value, index) => index)
          .find((index) => ![...this.members.values()].some((player) => player.seat === index));
        this.members.set(client.sessionId, member);
        reserved = true;
        this.applyStage(activity);
        if (member.studentId) {
          await db.query(`INSERT INTO classroom.live_activity_participants (activity_id,classroom_id,student_id)
            VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [this.activityId, activity.classroomId, member.studentId]);
          if (activity.choiceCount > 0) {
            const { rows: [choice] } = await db.query(`SELECT choice_index AS choice FROM classroom.live_activity_choices
              WHERE activity_id=$1 AND student_id=$2 AND question_index=$3`, [this.activityId, member.studentId, activity.questionIndex]);
            member.selected = choice?.choice ?? -1;
          }
        }
        member.questionIndex = activity.questionIndex;
        await db.query("COMMIT");
        return member;
      } catch (error) {
        await db.query("ROLLBACK").catch(() => {});
        if (reserved) this.members.delete(client.sessionId);
        throw error;
      } finally {
        db.release();
      }
    }

    onJoin(client, _options, member) {
      const player = new Player();
      player.displayName = member.displayName;
      player.role = member.role;
      applyAppearance(player, member.appearance ?? defaultAppearance);
      player.selected = this.choiceCount > 0 && member.questionIndex === this.state.questionIndex ? member.selected ?? -1 : -1;
      Object.assign(player, player.selected >= 0 ? this.choiceSpot(player.selected, member.seat) : this.spawn(member.seat));
      this.state.players.set(client.sessionId, player);
    }

    spawn(seat) {
      return { x: 26 + (seat % 17) * 3, y: activitySpawn.y + Math.floor(seat / 17) * 4 };
    }

    choiceSpot(choice, seat) {
      const center = zoneCenter(this.choiceCount, choice);
      return { x: center.x + ((seat % 9) - 4) * 1.8, y: center.y + (Math.floor(seat / 9) - 2.5) * 1.35 };
    }

    applyStage(activity) {
      if (activity.revision < this.revision || activity.revision === this.revision
        && this.state.phase === "revealed" && activity.phase === "answering") return;
      this.revision = activity.revision;
      if (this.state.questionIndex !== activity.questionIndex) {
        for (const [id, player] of this.state.players) {
          Object.assign(player, this.spawn(this.members.get(id).seat));
          player.selected = -1;
        }
      }
      this.state.questionIndex = activity.questionIndex;
      this.state.phase = activity.phase;
      this.choiceCount = activity.choiceCount;
    }

    async refresh() {
      if (this.refreshing || !this.members.size) return;
      this.refreshing = true;
      try {
        const { rows: [activity] } = await pool.query(activeQuery, [this.activityId]);
        if (!activity) {
          for (const client of [...this.clients]) client.leave(4403);
          return;
        }
        this.applyStage(activity);
        const hashes = [...this.members.values()].map((member) => member.sessionHash);
        const { rows } = await pool.query(accessQuery, [activity.classroomId, hashes]);
        const authorized = new Map(rows.map((row) => [row.sessionHash, row]));
        for (const client of [...this.clients]) {
          const member = this.members.get(client.sessionId);
          const current = authorized.get(member?.sessionHash);
          if (!member || (hashes.includes(member.sessionHash) && current?.studentId !== member.studentId)) client.leave(4403);
        }
      } finally {
        this.refreshing = false;
      }
    }

    move(client, message, direct) {
      const member = this.members.get(client.sessionId);
      const player = this.state.players.get(client.sessionId);
      const now = performance.now();
      const index = this.state.questionIndex;
      if (!member || !player || !message || message.questionIndex !== index) return;
      const phase = this.state.phase;
      if (direct && (member.role !== "student" || phase !== "answering" || this.choiceCount === 0
        || (message.choice !== null && (!Number.isInteger(message.choice) || message.choice < 0 || message.choice >= this.choiceCount)))) return;
      if (direct) {
        const wait = 100 - (now - (member.lastArea ?? -Infinity));
        if (member.moving || wait > 0) {
          member.pendingArea = message;
          member.areaTimer ??= setTimeout(() => {
            member.areaTimer = undefined;
            if (member.pendingArea) this.move(client, member.pendingArea, true);
          }, Math.max(25, Math.ceil(wait)));
          return;
        }
        member.pendingArea = undefined;
      } else if (member.moving || now - (member.lastStep ?? -Infinity) < 65) return;
      const { dx, dy } = message;
      if (!direct && (![dx, dy].every(Number.isFinite) || Math.abs(dx) > 1 || Math.abs(dy) > 1)) return;
      const dt = Math.min(0.12, (now - (member.lastStep ?? now - 85)) / 1000);
      if (direct) member.lastArea = now;
      else member.lastStep = now;
      const scale = 32 * dt / Math.max(1, Math.hypot(dx, dy));
      const point = direct ? (message.choice === null ? this.spawn(member.seat) : this.choiceSpot(message.choice, member.seat)) : {
        x: Math.min(activityWidth - 2, Math.max(2, player.x + dx * scale)),
        y: Math.min(activityHeight - 3, Math.max(3, player.y + dy * scale)),
      };
      const choice = zoneChoice(this.choiceCount, point.x, point.y);
      if (phase !== "answering" || !member.studentId || choice === player.selected) {
        Object.assign(player, point);
      } else {
        member.moving = true;
        void this.recordChoice(member, index, choice).then((accepted) => {
          if (accepted && this.state.questionIndex === index && this.members.has(client.sessionId)) {
            player.selected = choice;
            Object.assign(player, point);
          }
        }).catch(() => client.send("activity-error", "บันทึกคำตอบไม่สำเร็จ กรุณาลองอีกครั้ง")).finally(() => { member.moving = false; });
      }
    }

    async recordChoice(member, index, choice) {
      const result = await pool.query(`
        WITH active AS MATERIALIZED (
          SELECT l.id, l.deadline FROM classroom.live_activities l JOIN classroom.classrooms c ON c.id=l.classroom_id
          JOIN classroom.students s ON s.classroom_id=c.id AND s.id=$3
          JOIN classroom.student_sessions ss ON ss.account_id=s.account_id AND ss.token_hash=$5
          LEFT JOIN classroom.quizzes q ON q.id=l.quiz_id
          WHERE l.id=$1 AND l.question_index=$2 AND l.phase='answering' AND c.archived_at IS NULL
            AND (l.kind='quiz' OR (l.kind='poll' AND l.poll_snapshot->>'mode'='walk'))
            AND s.archived_at IS NULL AND q.trashed_at IS NULL AND ss.expires_at > clock_timestamp() FOR SHARE OF l,c,s
        )
        INSERT INTO classroom.live_activity_choices(activity_id, student_id, question_index, choice_index)
          SELECT id,$3,$2,$4 FROM active WHERE deadline > clock_timestamp()
          ON CONFLICT (activity_id,student_id,question_index) DO UPDATE SET choice_index=EXCLUDED.choice_index`,
      [this.activityId, index, member.studentId, choice === -1 ? null : choice, member.sessionHash]);
      return result.rowCount === 1;
    }

    onLeave(client) {
      clearTimeout(this.members.get(client.sessionId)?.areaTimer);
      this.members.delete(client.sessionId);
      this.state.players.delete(client.sessionId);
    }

    onDispose() {
      if (rooms.get(this.activityId) === this) rooms.delete(this.activityId);
    }
  };
}
