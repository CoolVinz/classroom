import { createHash, randomBytes } from "node:crypto";
import { Elysia, t } from "elysia";
import type postgres from "postgres";
import { requireActor, readActor, readStudentActor, type Actor } from "../auth/session";
import { sql } from "../db/client";
import { HttpError } from "../http-error";
import { checkRequestOrigin } from "../security";
import { storedFilePath } from "../file-storage";
import { trainTrack } from "../../gallery-server/src/train-layout.mjs";
import { defaultPatrolSettings, type PatrolSettings } from "../../gallery-server/src/patrol.mjs";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const galleryVoteLimit = 10;
const galleryVoteReward = 2;
const galleryVotePointLimit = galleryVoteLimit * galleryVoteReward;
const defaultAppearance = { skinColor: "#f3c8a6", hairColor: "#3e2d27", shirtColor: "#4f9b86", trousersColor: "#435875", hairStyle: "short", hatStyle: "none", glassesStyle: "none", shoeStyle: "sneakers", hatColor: "#b84d4d", glassesColor: "#302721", shoeColor: "#303a4a" };
const avatarSchema = t.Object({
  skinColor: t.String({ pattern: "^#[0-9a-fA-F]{6}$" }),
  hairColor: t.String({ pattern: "^#[0-9a-fA-F]{6}$" }),
  shirtColor: t.String({ pattern: "^#[0-9a-fA-F]{6}$" }),
  trousersColor: t.String({ pattern: "^#[0-9a-fA-F]{6}$" }),
  hairStyle: t.Optional(t.Union([t.Literal("none"),t.Literal("short"),t.Literal("long"),t.Literal("ponytail"),t.Literal("bun"),t.Literal("spiky"),t.Literal("bob")])),
  hatStyle: t.Optional(t.Union([t.Literal("none"), t.Literal("cap"), t.Literal("beanie"), t.Literal("wizard")])),
  glassesStyle: t.Optional(t.Union([t.Literal("none"), t.Literal("round"), t.Literal("square")])),
  shoeStyle: t.Optional(t.Union([t.Literal("none"), t.Literal("sneakers"), t.Literal("boots")])),
  hatColor: t.Optional(t.String({ pattern: "^#[0-9a-fA-F]{6}$" })),
  glassesColor: t.Optional(t.String({ pattern: "^#[0-9a-fA-F]{6}$" })),
  shoeColor: t.Optional(t.String({ pattern: "^#[0-9a-fA-F]{6}$" })),
});
function cookieToken(request: Request) {
  const value = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith("classroom_session="))?.slice("classroom_session=".length);
  if (!value || value.length > 128) throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
  return value;
}
async function ownedClass(actor: Actor, classroomId: string) {
  const [room] = await sql<{ id: string }[]>`SELECT id FROM classroom.classrooms WHERE id = ${classroomId} AND owner_id = ${actor.id} AND archived_at IS NULL`;
  if (!room) throw new HttpError(404, "ไม่พบห้องเรียนนี้");
}
async function studentClass(accountId: string, classroomId: string) {
  const [member] = await sql<{ studentId: string; enabled: boolean; mode: string; assignmentTitle: string | null; hasSubmission: boolean; approved: boolean; entryAllowed: boolean }[]>`SELECT e.student_id AS "studentId", w.enabled, e.student_entry_mode AS mode, e.required_assignment_title AS "assignmentTitle", e.has_submission AS "hasSubmission", e.approved, e.entry_allowed AS "entryAllowed" FROM classroom.gallery_student_entry e JOIN classroom.gallery_worlds w ON w.classroom_id=e.classroom_id WHERE e.account_id=${accountId} AND e.classroom_id=${classroomId}`;
  if (!member || !member.enabled) throw new HttpError(404, "ไม่พบโลกเสมือนนี้");
  if (!member.entryAllowed) {
    if (!member.assignmentTitle) throw new HttpError(403, "ห้องเรียนนี้ยังไม่มีงานที่เปิดอยู่ จึงยังเข้าโลกเสมือนไม่ได้");
    const requirement = member.mode === "approval" ? "ส่งงานล่าสุดและรอครูอนุมัติก่อนเข้าโลก" : "ส่งงานล่าสุดก่อนเข้าโลก";
    throw new HttpError(403, `กรุณา${requirement}: ${member.assignmentTitle}`);
  }
  return member.studentId;
}
async function ensureBlocks(classroomId: string) {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${classroomId}, 14019))`;
    await tx`WITH missing AS (
      SELECT s.id, row_number() OVER (ORDER BY s.created_at, s.id) AS n
      FROM classroom.students s WHERE s.classroom_id=${classroomId} AND s.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM classroom.gallery_blocks b WHERE b.student_id=s.id AND b.classroom_id=s.classroom_id)
    ), base AS (SELECT COALESCE(MAX(block_index), 0) AS n FROM classroom.gallery_blocks WHERE classroom_id=${classroomId})
      INSERT INTO classroom.gallery_blocks(classroom_id,student_id,block_index)
      SELECT ${classroomId}, missing.id, base.n + missing.n FROM missing CROSS JOIN base ON CONFLICT DO NOTHING`;
  });
}

async function lockVotingWallet(tx: postgres.TransactionSql, accountId: string, classroomId: string, studentId: string) {
  // Match the account lock order used by gift claims and shop purchases.
  const [account] = await tx`SELECT id FROM classroom.student_accounts WHERE id=${accountId} FOR UPDATE`;
  const [membership] = account ? await tx`SELECT s.id FROM classroom.students s
    JOIN classroom.gallery_student_entry e ON e.student_id=s.id AND e.classroom_id=s.classroom_id
    JOIN classroom.classrooms c ON c.id=s.classroom_id JOIN classroom.gallery_worlds w ON w.classroom_id=c.id
    WHERE s.id=${studentId} AND s.classroom_id=${classroomId} AND s.account_id=${accountId}
      AND s.archived_at IS NULL AND c.archived_at IS NULL AND e.entry_allowed AND w.enabled FOR SHARE OF s,c,w` : [];
  if (!membership) throw new HttpError(403, "สิทธิ์เข้าโลกเสมือนของคุณเปลี่ยนแล้ว");
}

export const galleryRoutes = new Elysia({ prefix: "/api" })
  .get("/gallery/config", () => ({ url: process.env.GALLERY_WS_URL ?? "" }))
  .get("/gallery/avatar", async ({ request }) => {
    const teacher = await readActor(request);
    if (teacher) {
      const [row] = await sql<{ avatarSettings: unknown }[]>`SELECT avatar_settings AS "avatarSettings" FROM classroom.teachers WHERE id=${teacher.id}`;
      if (row) return { ...defaultAppearance, ...(row.avatarSettings as object) };
    }
    const student = teacher ? null : await readStudentActor(request);
    if (student) {
      const [row] = await sql<{ avatarSettings: unknown }[]>`SELECT avatar_settings AS "avatarSettings" FROM classroom.student_accounts WHERE id=${student.id}`;
      if (row) return { ...defaultAppearance, ...(row.avatarSettings as object) };
    }
    throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
  })
  .put("/gallery/avatar", async ({ request, body }) => {
    checkRequestOrigin(request);
    const appearance = { ...defaultAppearance, ...body };
    const teacher = await readActor(request);
    if (teacher) {
      await sql`UPDATE classroom.teachers SET avatar_settings=${sql.json(appearance)} WHERE id=${teacher.id}`;
      return appearance;
    }
    const student = await readStudentActor(request);
    if (student) {
      await sql`UPDATE classroom.student_accounts SET avatar_settings=${sql.json(appearance)} WHERE id=${student.id}`;
      return appearance;
    }
    throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
  }, { body: avatarSchema })
  .get("/student/worlds", async ({ request }) => {
    const actor = await readStudentActor(request);
    if (!actor) throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
    return sql`SELECT e.classroom_id AS "classroomId", c.name AS "classroomName", e.student_entry_mode AS "entryMode", e.required_assignment_id AS "requiredAssignmentId", e.required_assignment_title AS "requiredAssignmentTitle", e.has_submission AS "hasSubmission", e.approved, e.entry_allowed AS "entryAllowed" FROM classroom.gallery_student_entry e JOIN classroom.classrooms c ON c.id=e.classroom_id JOIN classroom.gallery_worlds w ON w.classroom_id=e.classroom_id WHERE e.account_id=${actor.id} AND w.enabled ORDER BY c.name`;
  })
  .get("/student/gallery-points", async ({ request }) => {
    const actor = await readStudentActor(request);
    if (!actor) throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
    const [row] = await sql<{ balance: number }[]>`SELECT classroom.gallery_point_balance(${actor.id}) AS balance`;
    return { balance: row.balance };
  })
  .get("/classrooms/:classroomId/gallery/access", async ({ params, request }) => {
    const actor = await requireActor(request);
    await ownedClass(actor, params.classroomId);
    await sql`INSERT INTO classroom.gallery_worlds(classroom_id,enabled) VALUES(${params.classroomId},false) ON CONFLICT DO NOTHING`;
    const students = await sql`SELECT student_id AS "studentId", account_id IS NOT NULL AS "accountLinked", display_name AS "displayName", student_number AS "studentNumber", student_entry_mode AS "entryMode", required_assignment_id AS "requiredAssignmentId", required_assignment_title AS "requiredAssignmentTitle", has_submission AS "hasSubmission", approved, entry_allowed AS "entryAllowed" FROM classroom.gallery_student_entry WHERE classroom_id=${params.classroomId} ORDER BY student_number NULLS LAST, display_name, student_id`;
    const [world] = await sql<{ mode: "submission" | "approval" }[]>`SELECT student_entry_mode AS mode FROM classroom.gallery_worlds WHERE classroom_id=${params.classroomId}`;
    const [assignment] = await sql<{ id: string; title: string }[]>`SELECT id, title FROM classroom.assignments WHERE classroom_id=${params.classroomId} AND archived_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`;
    return { mode: world.mode, requiredAssignmentId: assignment?.id ?? null, requiredAssignmentTitle: assignment?.title ?? null, students };
  })
  .put("/classrooms/:classroomId/gallery/access", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedClass(actor, params.classroomId);
    await sql`INSERT INTO classroom.gallery_worlds(classroom_id,enabled,student_entry_mode) VALUES(${params.classroomId},false,${body.mode}) ON CONFLICT(classroom_id) DO UPDATE SET student_entry_mode=EXCLUDED.student_entry_mode, updated_at=NOW()`;
    return { ok: true, mode: body.mode };
  }, { body: t.Object({ mode: t.Union([t.Literal("submission"), t.Literal("approval")]) }) })
  .put("/classrooms/:classroomId/gallery/access/:studentId", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedClass(actor, params.classroomId);
    await sql.begin(async (tx) => {
      const [member] = await tx<{ accountId: string | null }[]>`SELECT account_id AS "accountId" FROM classroom.students WHERE id=${params.studentId} AND classroom_id=${params.classroomId} AND archived_at IS NULL FOR UPDATE`;
      if (!member?.accountId) throw new HttpError(400, "นักเรียนต้องเชื่อมบัญชีโรงเรียนก่อนจึงจัดการสิทธิ์เข้าโลกได้");
      const [entry] = await tx<{ assignmentId: string | null; hasSubmission: boolean }[]>`
        SELECT required_assignment_id AS "assignmentId", has_submission AS "hasSubmission"
        FROM classroom.gallery_student_entry
        WHERE classroom_id=${params.classroomId} AND student_id=${params.studentId} AND account_id=${member.accountId}`;
      if (entry?.assignmentId !== body.assignmentId) throw new HttpError(409, "งานล่าสุดเปลี่ยนแล้ว กรุณาโหลดรายการใหม่");
      if (body.approved) {
        if (!entry.hasSubmission) throw new HttpError(400, "อนุมัติได้หลังจากนักเรียนส่งงานล่าสุดแล้วเท่านั้น");
        await tx`INSERT INTO classroom.gallery_entry_approvals(classroom_id,assignment_id,student_id,account_id,approved_by) VALUES(${params.classroomId},${body.assignmentId},${params.studentId},${member.accountId},${actor.id}) ON CONFLICT(classroom_id,assignment_id,student_id,account_id) DO UPDATE SET approved_by=EXCLUDED.approved_by, approved_at=NOW()`;
      } else {
        await tx`DELETE FROM classroom.gallery_entry_approvals WHERE classroom_id=${params.classroomId} AND assignment_id=${body.assignmentId} AND student_id=${params.studentId} AND account_id=${member.accountId}`;
      }
    });
    return { ok: true, approved: body.approved };
  }, { body: t.Object({ assignmentId: t.String({ format: "uuid" }), approved: t.Boolean() }) })
  .get("/classrooms/:classroomId/gallery", async ({ params, request, query }) => {
    const teacher = await readActor(request);
    const student = teacher ? null : await readStudentActor(request);
    let viewerStudentId: string | null = null;
    if (teacher) { await ownedClass(teacher, params.classroomId); await sql`INSERT INTO classroom.gallery_worlds(classroom_id,enabled) VALUES(${params.classroomId},false) ON CONFLICT DO NOTHING`; }
    else if (student) viewerStudentId = await studentClass(student.id, params.classroomId);
    else throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
    await ensureBlocks(params.classroomId);
    const offset = Math.max(0, Math.min(100000, Math.trunc(Number(query.offset) || 0)));
    return sql.begin("isolation level repeatable read read only", async (tx) => {
      const [world] = await tx<{ enabled: boolean; classroomName: string; fuseSeconds: number; respawnSeconds: number; wand: number; license: number; patrol: PatrolSettings; requested: string | null; displayed: string | null }[]>`
        SELECT w.enabled, c.name AS "classroomName", w.santa_bomb_fuse_seconds AS "fuseSeconds", w.santa_respawn_seconds AS "respawnSeconds",
          w.exhibition_assignment_id AS requested, w.displayed_assignment_id AS displayed,
          w.wand_price AS wand, w.license_price AS license,
          json_build_object('car', w.patrol_car_hits, 'bike', w.patrol_bike_hits, 'helicopter', w.patrol_helicopter_hits,
            'broom', w.patrol_broom_hits, 'baseSeconds', w.jail_base_seconds, 'extraSeconds', w.jail_extra_seconds, 'maxSeconds', w.jail_max_seconds,
            'helicopterFuelSeconds', w.helicopter_fuel_seconds, 'broomFuelSeconds', w.broom_fuel_seconds) AS patrol
        FROM classroom.gallery_worlds w JOIN classroom.classrooms c ON c.id=w.classroom_id WHERE w.classroom_id=${params.classroomId}`;
      if (!world || (!teacher && !world.enabled)) throw new HttpError(404, "ยังไม่ได้เปิดโลกเสมือน");
      if (offset && (query.layout || null) !== world.displayed && query.layout !== undefined) {
        throw new HttpError(409, "พื้นที่จัดแสดงเปลี่ยนแล้ว กรุณาโหลดผลงานใหม่");
      }
      const limit = Math.max(world.displayed ? 200 : 40, Math.min(400, Math.trunc(Number(query.limit) || 0)));
      const [blocks, modelPage, options, trainStudents, [train]] = await Promise.all([
        tx`SELECT l.space_id AS "spaceId", b.student_id AS "studentId", l.display_name AS "displayName",
          l.student_number AS "studentNumber", b.block_index AS "blockIndex", (l.ordinality - 1)::int AS "layoutIndex", FALSE AS archived
          FROM classroom.gallery_layout(${params.classroomId}, ${world.displayed}) WITH ORDINALITY l
          LEFT JOIN classroom.gallery_blocks b ON b.classroom_id=${params.classroomId} AND b.student_id=l.space_id AND ${world.displayed}::uuid IS NULL
          ORDER BY l.ordinality`,
        tx`SELECT f.id, f.space_id AS "spaceId", f.student_id AS "studentId", f.display_name AS "displayName",
          f.student_number AS "studentNumber", f.assignment_id AS "assignmentId", f.assignment_title AS "assignmentTitle",
          f.original_name AS "originalName", f.media_type AS "mediaType", f.material_storage_name IS NOT NULL AS "materialAvailable",
          f.thumbnail_size_bytes IS NOT NULL AS "thumbnailAvailable", f.created_at AS "createdAt", f.hidden,
          (SELECT COUNT(*)::int FROM classroom.gallery_likes l WHERE l.file_id=f.id) AS likes,
          EXISTS (SELECT 1 FROM classroom.gallery_likes l WHERE l.file_id=f.id AND l.student_id=${viewerStudentId}) AS "likedByMe"
          FROM classroom.gallery_display_models f WHERE f.classroom_id=${params.classroomId} AND (${teacher !== null} OR NOT f.hidden)
          ORDER BY f.student_number NULLS LAST, f.display_name, f.student_id, f.created_at DESC, f.id LIMIT ${limit + 1} OFFSET ${offset}`,
        teacher ? tx`SELECT id, title FROM classroom.gallery_exhibition_assignments
          WHERE classroom_id=${params.classroomId} ORDER BY title, id` : [],
        teacher ? tx`SELECT space_id AS id, display_name AS "displayName", student_number AS "studentNumber"
          FROM classroom.gallery_layout(${params.classroomId}, NULL) WHERE student_number IS NOT NULL` : [],
        tx<{ mode: "auto" | "manual"; intervalSeconds: number; startStudentId: string | null; stationWaitSeconds: Record<string, number> }[]>`SELECT w.train_mode AS mode, w.train_interval_seconds AS "intervalSeconds", s.id AS "startStudentId", w.train_station_wait_seconds AS "stationWaitSeconds" FROM classroom.gallery_worlds w LEFT JOIN classroom.students s ON s.id=w.train_start_student_id AND s.classroom_id=w.classroom_id AND s.archived_at IS NULL AND s.student_number IS NOT NULL WHERE w.classroom_id=${params.classroomId}`,
      ]);
      return { classroomId: params.classroomId, classroomName: world.classroomName, enabled: world.enabled, blocks, models: modelPage.slice(0, limit), nextOffset: modelPage.length > limit ? offset + limit : null, teacher: Boolean(teacher), viewerStudentId, exhibition: { requested: world.requested, displayed: world.displayed, options }, trainStudents, train: { mode: train?.mode ?? "auto", intervalSeconds: train?.intervalSeconds ?? 120, startStudentId: train?.startStudentId ?? null, stationWaitSeconds: train?.stationWaitSeconds ?? {} }, santa: { fuseSeconds: world.fuseSeconds, respawnSeconds: world.respawnSeconds }, shop: { wand: world.wand, license: world.license }, patrol: world.patrol };
    });
  })
  .put("/classrooms/:classroomId/gallery/exhibition", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const teacher = await requireActor(request);
    await ownedClass(teacher, params.classroomId);
    await sql.begin(async (tx) => {
      if (body.assignmentId) {
        const [assignment] = await tx`SELECT a.id FROM classroom.assignments a
          JOIN classroom.group_sets gs ON gs.id=a.group_set_id
          WHERE a.id=${body.assignmentId} AND a.classroom_id=${params.classroomId}
            AND a.archived_at IS NULL AND gs.status IN ('open', 'locked') FOR SHARE OF a, gs`;
        if (!assignment) throw new HttpError(422, "เลือกงานที่เปิดอยู่และเชื่อมกับชุดกลุ่มในห้องนี้");
      }
      await tx`INSERT INTO classroom.gallery_worlds(classroom_id, exhibition_assignment_id)
        VALUES(${params.classroomId}, ${body.assignmentId}) ON CONFLICT(classroom_id)
        DO UPDATE SET exhibition_assignment_id=EXCLUDED.exhibition_assignment_id, updated_at=NOW()`;
    });
    return { ok: true };
  }, { body: t.Object({ assignmentId: t.Nullable(t.String({ format: "uuid" })) }) })
  .get("/classrooms/:classroomId/gallery/votes", async ({ params, request }) => {
    const teacher = await readActor(request);
    const student = teacher ? null : await readStudentActor(request);
    let studentId: string | null = null;
    if (teacher) await ownedClass(teacher, params.classroomId);
    else if (student) studentId = await studentClass(student.id, params.classroomId);
    else throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
    const [blockTotals, usage, myVotes] = await Promise.all([
      sql<{ id: string; team: boolean; votes: number }[]>`SELECT f.space_id AS id, w.displayed_assignment_id IS NOT NULL AS team, COUNT(l.file_id)::int AS votes
        FROM classroom.gallery_display_models f
        JOIN classroom.gallery_worlds w ON w.classroom_id=f.classroom_id
        JOIN classroom.gallery_likes l ON l.classroom_id=f.classroom_id AND l.file_id=f.id
        WHERE f.classroom_id=${params.classroomId} AND NOT f.hidden
        GROUP BY f.space_id, w.displayed_assignment_id`,
      studentId ? sql`SELECT f.assignment_id AS "assignmentId", a.title AS "assignmentTitle", COUNT(*)::int AS used
        FROM classroom.gallery_likes l JOIN classroom.files f ON f.id=l.file_id JOIN classroom.assignments a ON a.id=f.assignment_id
        WHERE l.classroom_id=${params.classroomId} AND l.student_id=${studentId}
        GROUP BY f.assignment_id,a.title ORDER BY a.title,f.assignment_id` : Promise.resolve([]),
      studentId ? sql`SELECT f.id AS "fileId", f.assignment_id AS "assignmentId", a.title AS "assignmentTitle", f.original_name AS "originalName",
          owner.display_name AS "displayName", owner.student_number AS "studentNumber",
          (h.file_id IS NOT NULL) AS hidden, (visible.id IS NULL) AS unavailable
        FROM classroom.gallery_likes l JOIN classroom.files f ON f.id=l.file_id JOIN classroom.students owner ON owner.id=f.student_id
        JOIN classroom.assignments a ON a.id=f.assignment_id LEFT JOIN classroom.gallery_hidden_models h ON h.classroom_id=f.classroom_id AND h.file_id=f.id
        LEFT JOIN classroom.gallery_display_models visible ON visible.id=f.id
        WHERE l.classroom_id=${params.classroomId} AND l.student_id=${studentId}
        ORDER BY a.title, owner.student_number NULLS LAST, owner.display_name, f.original_name, f.id` : Promise.resolve([]),
    ]);
    return { limit: galleryVoteLimit, blockTotals: blockTotals.map(({ id, team, votes }) => team ? { spaceId: id, votes } : { studentId: id, votes }), usage, myVotes };
  })
  .put("/classrooms/:classroomId/gallery", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedClass(actor, params.classroomId);
    await sql`INSERT INTO classroom.gallery_worlds(classroom_id,enabled) VALUES(${params.classroomId},${body.enabled}) ON CONFLICT(classroom_id) DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=NOW()`;
    return { ok: true, enabled: body.enabled };
  }, { body: t.Object({ enabled: t.Boolean() }) })
  .put("/classrooms/:classroomId/gallery/shop", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    await ownedClass(await requireActor(request), params.classroomId);
    await sql`INSERT INTO classroom.gallery_worlds(classroom_id,wand_price,license_price)
      VALUES(${params.classroomId},${body.wand},${body.license})
      ON CONFLICT(classroom_id) DO UPDATE SET wand_price=EXCLUDED.wand_price, license_price=EXCLUDED.license_price, updated_at=NOW()`;
    return body;
  }, { body: t.Object({ wand: t.Integer({ minimum: 1, maximum: 1000 }), license: t.Integer({ minimum: 1, maximum: 1000 }) }) })
  .put("/classrooms/:classroomId/gallery/patrol", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    await ownedClass(await requireActor(request), params.classroomId);
    if (body.maxSeconds < body.baseSeconds) throw new HttpError(422, "เวลาขังสูงสุดต้องไม่น้อยกว่าเวลาเริ่มต้น");
    const helicopterFuel = body.helicopterFuelSeconds ?? null, broomFuel = body.broomFuelSeconds ?? null;
    const [fuel] = await sql<{ helicopterFuelSeconds: number; broomFuelSeconds: number }[]>`
      INSERT INTO classroom.gallery_worlds(classroom_id, patrol_car_hits, patrol_bike_hits, patrol_helicopter_hits,
        patrol_broom_hits, jail_base_seconds, jail_extra_seconds, jail_max_seconds, helicopter_fuel_seconds, broom_fuel_seconds)
      VALUES (${params.classroomId}, ${body.car}, ${body.bike}, ${body.helicopter}, ${body.broom}, ${body.baseSeconds}, ${body.extraSeconds}, ${body.maxSeconds},
        COALESCE(${helicopterFuel}::smallint, ${defaultPatrolSettings.helicopterFuelSeconds}), COALESCE(${broomFuel}::smallint, ${defaultPatrolSettings.broomFuelSeconds}))
      ON CONFLICT (classroom_id) DO UPDATE SET patrol_car_hits=EXCLUDED.patrol_car_hits, patrol_bike_hits=EXCLUDED.patrol_bike_hits,
        patrol_helicopter_hits=EXCLUDED.patrol_helicopter_hits, patrol_broom_hits=EXCLUDED.patrol_broom_hits,
        jail_base_seconds=EXCLUDED.jail_base_seconds, jail_extra_seconds=EXCLUDED.jail_extra_seconds,
        jail_max_seconds=EXCLUDED.jail_max_seconds, helicopter_fuel_seconds=COALESCE(${helicopterFuel}, gallery_worlds.helicopter_fuel_seconds),
        broom_fuel_seconds=COALESCE(${broomFuel}, gallery_worlds.broom_fuel_seconds), updated_at=NOW()
      RETURNING helicopter_fuel_seconds AS "helicopterFuelSeconds", broom_fuel_seconds AS "broomFuelSeconds"`;
    return { ...body, ...fuel };
  }, { params: t.Object({ classroomId: t.String({ format: "uuid" }) }), body: t.Object({
    car: t.Integer({ minimum: 1, maximum: 20 }), bike: t.Integer({ minimum: 1, maximum: 20 }),
    helicopter: t.Integer({ minimum: 1, maximum: 20 }), broom: t.Integer({ minimum: 1, maximum: 20 }),
    baseSeconds: t.Integer({ minimum: 5, maximum: 120 }), extraSeconds: t.Integer({ minimum: 1, maximum: 30 }),
    maxSeconds: t.Integer({ minimum: 5, maximum: 180 }),
    helicopterFuelSeconds: t.Optional(t.Integer({ minimum: 5, maximum: 180 })),
    broomFuelSeconds: t.Optional(t.Integer({ minimum: 5, maximum: 180 })),
  }) })
  .put("/classrooms/:classroomId/gallery/santa", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedClass(actor, params.classroomId);
    const [settings] = await sql<{ fuseSeconds: number; respawnSeconds: number }[]>`
      INSERT INTO classroom.gallery_worlds(classroom_id,enabled,santa_bomb_fuse_seconds,santa_respawn_seconds)
      VALUES(${params.classroomId},false,${body.fuseSeconds},${body.respawnSeconds})
      ON CONFLICT(classroom_id) DO UPDATE SET santa_bomb_fuse_seconds=EXCLUDED.santa_bomb_fuse_seconds,
        santa_respawn_seconds=EXCLUDED.santa_respawn_seconds, updated_at=NOW()
      RETURNING santa_bomb_fuse_seconds AS "fuseSeconds", santa_respawn_seconds AS "respawnSeconds"
    `;
    return { ok: true, ...settings };
  }, { body: t.Object({ fuseSeconds: t.Integer({ minimum: 1, maximum: 15 }), respawnSeconds: t.Integer({ minimum: 3, maximum: 60 }) }) })
  .put("/classrooms/:classroomId/gallery/train", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedClass(actor, params.classroomId);
    if (body.startStudentId) {
      const [student] = await sql<{ id: string }[]>`SELECT id FROM classroom.students WHERE id=${body.startStudentId} AND classroom_id=${params.classroomId} AND archived_at IS NULL AND student_number IS NOT NULL`;
      if (!student) throw new HttpError(400, "เลือกนักเรียนที่ยังใช้งานและมีเลขที่ในห้องนี้");
    }
    if (body.stationWaitSeconds && Object.keys(body.stationWaitSeconds).length) {
      const [roster] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM classroom.gallery_layout(
        ${params.classroomId}, (SELECT displayed_assignment_id FROM classroom.gallery_worlds WHERE classroom_id=${params.classroomId}))`;
      const stationIds = new Set(trainTrack(roster.count).map((point) => point.id).filter(Boolean));
      if (Object.keys(body.stationWaitSeconds).some((id) => !stationIds.has(id))) throw new HttpError(400, "เส้นทางรถไฟเปลี่ยนแล้ว กรุณาโหลดสถานีใหม่");
    }
    const waits = body.stationWaitSeconds ? sql.json(body.stationWaitSeconds) : null;
    const [updated] = await sql<{ stationWaitSeconds: Record<string, number> }[]>`
      INSERT INTO classroom.gallery_worlds(classroom_id,enabled,train_mode,train_interval_seconds,train_start_student_id,train_station_wait_seconds)
      VALUES(${params.classroomId},false,${body.mode},${body.intervalSeconds},${body.startStudentId ?? null},COALESCE(${waits}::jsonb,'{}'::jsonb))
      ON CONFLICT(classroom_id) DO UPDATE SET train_mode=EXCLUDED.train_mode,
        train_interval_seconds=EXCLUDED.train_interval_seconds, train_start_student_id=EXCLUDED.train_start_student_id,
        train_station_wait_seconds=COALESCE(${waits}::jsonb,gallery_worlds.train_station_wait_seconds), updated_at=NOW()
      RETURNING train_station_wait_seconds AS "stationWaitSeconds"
    `;
    return { ok: true, mode: body.mode, intervalSeconds: body.intervalSeconds, startStudentId: body.startStudentId ?? null, ...updated };
  }, { body: t.Object({ mode: t.Union([t.Literal("auto"), t.Literal("manual")]), intervalSeconds: t.Union([t.Literal(60), t.Literal(120)]), startStudentId: t.Optional(t.Nullable(t.String({ format: "uuid" }))), stationWaitSeconds: t.Optional(t.Record(t.String(), t.Integer({ minimum: 3, maximum: 120 }))) }) })
  .post("/classrooms/:classroomId/gallery/ticket", async ({ params, request }) => {
    checkRequestOrigin(request);
    const teacher = await readActor(request);
    const student = teacher ? null : await readStudentActor(request);
    let studentId: string | null = null;
    if (teacher) await ownedClass(teacher, params.classroomId);
    else if (student) studentId = await studentClass(student.id, params.classroomId);
    else throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
    const token = randomBytes(32).toString("base64url");
    const sessionHash = hash(cookieToken(request));
    const actorId = teacher?.id ?? student!.id;
    const [enabled] = await sql<{ enabled: boolean }[]>`SELECT enabled FROM classroom.gallery_worlds WHERE classroom_id=${params.classroomId}`;
    if (!enabled || (!teacher && !enabled.enabled)) throw new HttpError(404, "ยังไม่ได้เปิดโลกเสมือน");
    await sql`DELETE FROM classroom.gallery_tickets WHERE expires_at < NOW()`;
    await sql`INSERT INTO classroom.gallery_tickets(token_hash,classroom_id,actor_kind,account_id,student_id,session_hash,expires_at) VALUES(${hash(token)},${params.classroomId},${teacher ? "teacher" : "student"},${actorId},${studentId},${sessionHash},NOW()+INTERVAL '60 seconds')`;
    return { ticket: token, url: process.env.GALLERY_WS_URL ?? "" };
  })
  .get("/classrooms/:classroomId/gallery/files/:fileId/content", async ({ params, request }) => {
    const teacher = await readActor(request);
    const student = teacher ? null : await readStudentActor(request);
    if (teacher) await ownedClass(teacher, params.classroomId);
    else if (student) await studentClass(student.id, params.classroomId);
    else throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
    const [row] = await sql<{ storageName: string; originalName: string }[]>`SELECT f.storage_name AS "storageName", f.original_name AS "originalName"
      FROM classroom.gallery_display_models f WHERE f.id=${params.fileId} AND f.classroom_id=${params.classroomId} AND (${teacher !== null} OR NOT f.hidden)`;
    if (!row) throw new HttpError(404, "ไม่พบโมเดลนี้");
    const path = await storedFilePath(row.storageName);
    return new Response(Bun.file(path), { headers: { "content-type": ({"stl":"model/stl","obj":"model/obj","glb":"model/gltf-binary","gltf":"model/gltf+json"} as Record<string,string>)[row.originalName.split(".").pop()!.toLowerCase()], "content-disposition": "inline; filename*=UTF-8''" + encodeURIComponent(row.originalName), "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  })
  .get("/classrooms/:classroomId/gallery/files/:fileId/material", async ({ params, request }) => {
    const teacher = await readActor(request); const student = teacher ? null : await readStudentActor(request);
    if (teacher) await ownedClass(teacher, params.classroomId); else if (student) await studentClass(student.id, params.classroomId); else throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
    const [row] = await sql<{ storageName: string; originalName: string }[]>`SELECT f.material_storage_name AS "storageName", f.material_original_name AS "originalName"
      FROM classroom.gallery_display_models f WHERE f.id=${params.fileId} AND f.classroom_id=${params.classroomId}
        AND f.material_storage_name IS NOT NULL AND (${teacher !== null} OR NOT f.hidden)`;
    if (!row) throw new HttpError(404, "ไม่พบไฟล์วัสดุนี้");
    const path = await storedFilePath(row.storageName);
    return new Response(Bun.file(path), { headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(row.originalName), "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  })
  .get("/classrooms/:classroomId/gallery/files/:fileId/thumbnail", async ({ params, request }) => {
    const teacher = await readActor(request);
    const student = teacher ? null : await readStudentActor(request);
    if (teacher) await ownedClass(teacher, params.classroomId);
    else if (student) await studentClass(student.id, params.classroomId);
    else throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
    const [row] = await sql<{ thumbnailMediaType: string | null }[]>`SELECT f.thumbnail_media_type AS "thumbnailMediaType"
      FROM classroom.gallery_display_models f WHERE f.id=${params.fileId} AND f.classroom_id=${params.classroomId}
        AND f.thumbnail_size_bytes IS NOT NULL AND (${teacher !== null} OR NOT f.hidden)`;
    if (!row?.thumbnailMediaType) throw new HttpError(404, "ยังไม่มีภาพตัวอย่าง");
    const path = await storedFilePath("thumbnails/" + params.fileId + (row.thumbnailMediaType === "image/webp" ? ".webp" : ".png"));
    return new Response(Bun.file(path), { headers: { "content-type": row.thumbnailMediaType, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  })
  .put("/classrooms/:classroomId/gallery/files/:fileId/visibility", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedClass(actor, params.classroomId);
    await sql.begin(async (tx) => {
      const [file] = await tx<{ id: string }[]>`SELECT id FROM classroom.files WHERE id=${params.fileId} AND classroom_id=${params.classroomId} AND kind IN ('model','submission') AND lower(original_name) ~ '\\.(stl|obj|glb|gltf)$' FOR UPDATE`;
      if (!file) throw new HttpError(404, "ไม่พบโมเดลนี้");
      if (body.hidden) await tx`INSERT INTO classroom.gallery_hidden_models(classroom_id,file_id,hidden_by) VALUES(${params.classroomId},${params.fileId},${actor.id}) ON CONFLICT DO NOTHING`;
      else await tx`DELETE FROM classroom.gallery_hidden_models WHERE classroom_id=${params.classroomId} AND file_id=${params.fileId}`;
    });
    return { ok: true, hidden: body.hidden };
  }, { body: t.Object({ hidden: t.Boolean() }) })
  .put("/classrooms/:classroomId/gallery/files/:fileId/like", async ({ params, request }) => {
    checkRequestOrigin(request);
    const actor = await readStudentActor(request);
    if (!actor) throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
    const studentId = await studentClass(actor.id, params.classroomId);
    return sql.begin(async (tx) => {
      await lockVotingWallet(tx, actor.id, params.classroomId, studentId);
      const [target] = await tx<{ assignmentId: string; ownerId: string | null }[]>`SELECT f.assignment_id AS "assignmentId", f.student_id AS "ownerId"
        FROM classroom.files f WHERE f.id=${params.fileId} AND f.classroom_id=${params.classroomId} FOR SHARE`;
      if (!target || target.ownerId === studentId) throw new HttpError(404, "ไม่พบโมเดลนี้หรือไม่สามารถกดถูกใจให้ผลงานตนเองได้");
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${params.classroomId}:${studentId}:${target.assignmentId}`}, 74103))`;
      const [eligible] = await tx`SELECT id FROM classroom.gallery_display_models WHERE id=${params.fileId} AND NOT hidden`;
      if (!eligible) throw new HttpError(404, "ไม่พบโมเดลนี้หรือไม่สามารถกดถูกใจให้ผลงานตนเองได้");
      const [alreadyVoted] = await tx<{ present: boolean }[]>`SELECT EXISTS(SELECT 1 FROM classroom.gallery_likes WHERE classroom_id=${params.classroomId} AND file_id=${params.fileId} AND student_id=${studentId}) AS present`;
      let pointsDelta = 0;
      if (!alreadyVoted.present) {
        const [usage] = await tx<{ used: number }[]>`SELECT COUNT(*)::int AS used FROM classroom.gallery_likes l JOIN classroom.files f ON f.id=l.file_id WHERE l.classroom_id=${params.classroomId} AND l.student_id=${studentId} AND f.assignment_id=${target.assignmentId}`;
        if (usage.used >= galleryVoteLimit) throw new HttpError(409, "ใช้โควตาโหวตครบ 10 ครั้งสำหรับงานนี้แล้ว ยกเลิกโหวตเดิมเพื่อใช้สิทธิ์อีกครั้ง");
        const [reward] = await tx<{ points: number }[]>`WITH new_vote AS (
          INSERT INTO classroom.gallery_likes(classroom_id,file_id,student_id)
          VALUES(${params.classroomId},${params.fileId},${studentId}) ON CONFLICT DO NOTHING RETURNING file_id, student_id, created_at
        ) INSERT INTO classroom.gallery_vote_rewards(account_id,assignment_id,file_id,voter_student_id,vote_created_at,points)
          SELECT ${actor.id}::uuid,${target.assignmentId}::uuid,file_id,student_id,created_at,${galleryVoteReward}::smallint FROM new_vote
          WHERE (SELECT COALESCE(SUM(points),0) FROM classroom.gallery_vote_rewards WHERE account_id=${actor.id} AND assignment_id=${target.assignmentId}) <= ${galleryVotePointLimit - galleryVoteReward}
          ON CONFLICT DO NOTHING RETURNING points`;
        pointsDelta = reward?.points ?? 0;
      }
      const [count] = await tx<{ likes: number; balance: number }[]>`SELECT COUNT(*)::int AS likes, classroom.gallery_point_balance(${actor.id}) AS balance FROM classroom.gallery_likes WHERE classroom_id=${params.classroomId} AND file_id=${params.fileId}`;
      const [usage] = await tx<{ used: number }[]>`SELECT COUNT(*)::int AS used FROM classroom.gallery_likes l JOIN classroom.files f ON f.id=l.file_id WHERE l.classroom_id=${params.classroomId} AND l.student_id=${studentId} AND f.assignment_id=${target.assignmentId}`;
      return { ...count, likedByMe: true, remaining: Math.max(0, galleryVoteLimit - usage.used), pointsDelta };
    });
  })
  .delete("/classrooms/:classroomId/gallery/files/:fileId/like", async ({ params, request }) => {
    checkRequestOrigin(request);
    const actor = await readStudentActor(request);
    if (!actor) throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
    const studentId = await studentClass(actor.id, params.classroomId);
    return sql.begin(async (tx) => {
      await lockVotingWallet(tx, actor.id, params.classroomId, studentId);
      const [file] = await tx<{ assignmentId: string }[]>`SELECT assignment_id AS "assignmentId" FROM classroom.files WHERE id=${params.fileId} AND classroom_id=${params.classroomId} FOR SHARE`;
      if (file) await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${params.classroomId}:${studentId}:${file.assignmentId}`}, 74103))`;
      const [reward] = await tx<{ points: number }[]>`WITH removed_vote AS (
        DELETE FROM classroom.gallery_likes WHERE classroom_id=${params.classroomId} AND file_id=${params.fileId} AND student_id=${studentId}
        RETURNING file_id, student_id, created_at
      ) DELETE FROM classroom.gallery_vote_rewards r USING removed_vote v
        WHERE r.account_id=${actor.id} AND r.file_id=v.file_id AND r.voter_student_id=v.student_id AND r.vote_created_at=v.created_at
        RETURNING r.points`;
      const [count] = await tx<{ likes: number; balance: number }[]>`SELECT COUNT(*)::int AS likes, classroom.gallery_point_balance(${actor.id}) AS balance FROM classroom.gallery_likes WHERE classroom_id=${params.classroomId} AND file_id=${params.fileId}`;
      const [usage] = file ? await tx<{ used: number }[]>`SELECT COUNT(*)::int AS used FROM classroom.gallery_likes l JOIN classroom.files f ON f.id=l.file_id WHERE l.classroom_id=${params.classroomId} AND l.student_id=${studentId} AND f.assignment_id=${file.assignmentId}` : [{ used: 0 }];
      return { ...count, likedByMe: false, remaining: Math.max(0, Math.min(galleryVoteLimit, galleryVoteLimit - usage.used)), pointsDelta: reward ? -reward.points : 0 };
    });
  });
