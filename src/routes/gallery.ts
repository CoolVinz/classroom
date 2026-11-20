import { createHash, randomBytes } from "node:crypto";
import { Elysia, t } from "elysia";
import { requireActor, readActor, readStudentActor, type Actor } from "../auth/session";
import { sql } from "../db/client";
import { HttpError } from "../http-error";
import { checkRequestOrigin } from "../security";
import { storedFilePath } from "../file-storage";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
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
    const [world] = await sql<{ enabled: boolean; classroomName: string }[]>`SELECT w.enabled, c.name AS "classroomName" FROM classroom.gallery_worlds w JOIN classroom.classrooms c ON c.id=w.classroom_id WHERE w.classroom_id=${params.classroomId}`;
    if (!world || (!teacher && !world.enabled)) throw new HttpError(404, "ยังไม่ได้เปิดโลกเสมือน");
    await ensureBlocks(params.classroomId);
    const offset = Math.max(0, Math.min(100000, Number(query.offset) || 0));
    const [blocks, models] = await Promise.all([
      sql`SELECT s.id AS "studentId", s.display_name AS "displayName", s.student_number AS "studentNumber", b.block_index AS "blockIndex", (row_number() OVER (ORDER BY s.student_number NULLS LAST, s.display_name, s.id) - 1)::int AS "layoutIndex", FALSE AS archived FROM classroom.gallery_blocks b JOIN classroom.students s ON s.id=b.student_id WHERE b.classroom_id=${params.classroomId} AND s.archived_at IS NULL ORDER BY s.student_number NULLS LAST, s.display_name, s.id`,
      sql`SELECT f.id, f.student_id AS "studentId", s.display_name AS "displayName", s.student_number AS "studentNumber", a.id AS "assignmentId", a.title AS "assignmentTitle", f.original_name AS "originalName", f.media_type AS "mediaType", f.material_storage_name IS NOT NULL AS "materialAvailable", f.thumbnail_size_bytes IS NOT NULL AS "thumbnailAvailable", f.created_at AS "createdAt", (h.file_id IS NOT NULL) AS hidden, (SELECT COUNT(*)::int FROM classroom.gallery_likes l WHERE l.file_id=f.id) AS likes, ${student?.id ?? null}::uuid IS NOT NULL AND f.student_id <> (SELECT s2.id FROM classroom.students s2 WHERE s2.account_id=${student?.id ?? null} AND s2.classroom_id=${params.classroomId} AND s2.archived_at IS NULL LIMIT 1) AND EXISTS (SELECT 1 FROM classroom.gallery_likes l JOIN classroom.students ls ON ls.id=l.student_id WHERE l.file_id=f.id AND ls.account_id=${student?.id ?? null}) AS "likedByMe"
        FROM classroom.files f JOIN classroom.students s ON s.id=f.student_id JOIN classroom.assignments a ON a.id=f.assignment_id LEFT JOIN classroom.gallery_hidden_models h ON h.classroom_id=f.classroom_id AND h.file_id=f.id
        WHERE f.classroom_id=${params.classroomId} AND f.kind IN ('model','submission') AND lower(f.original_name) ~ '\\.(stl|obj|glb|gltf)$' AND s.archived_at IS NULL AND a.archived_at IS NULL AND (${teacher !== null} OR h.file_id IS NULL)
        ORDER BY s.student_number NULLS LAST, s.display_name, s.id, f.created_at DESC, f.id LIMIT 40 OFFSET ${offset}`,
    ]);
    const [count] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM classroom.files f JOIN classroom.students s ON s.id=f.student_id JOIN classroom.assignments a ON a.id=f.assignment_id LEFT JOIN classroom.gallery_hidden_models h ON h.classroom_id=f.classroom_id AND h.file_id=f.id WHERE f.classroom_id=${params.classroomId} AND f.kind IN ('model','submission') AND lower(f.original_name) ~ '\\.(stl|obj|glb|gltf)$' AND s.archived_at IS NULL AND a.archived_at IS NULL AND (${teacher !== null} OR h.file_id IS NULL)`;
    const [train] = await sql<{ mode: "auto" | "manual"; intervalSeconds: number; startStudentId: string | null }[]>`SELECT w.train_mode AS mode, w.train_interval_seconds AS "intervalSeconds", CASE WHEN s.id IS NULL THEN NULL ELSE s.id END AS "startStudentId" FROM classroom.gallery_worlds w LEFT JOIN classroom.students s ON s.id=w.train_start_student_id AND s.classroom_id=w.classroom_id AND s.archived_at IS NULL AND s.student_number IS NOT NULL WHERE w.classroom_id=${params.classroomId}`;
    return { classroomId: params.classroomId, classroomName: world.classroomName, enabled: world.enabled, blocks, models, nextOffset: offset + models.length < count.count ? offset + models.length : null, teacher: Boolean(teacher), viewerStudentId, train: { mode: train?.mode ?? "auto", intervalSeconds: train?.intervalSeconds ?? 120, startStudentId: train?.startStudentId ?? null } };
  })
  .put("/classrooms/:classroomId/gallery", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedClass(actor, params.classroomId);
    await sql`INSERT INTO classroom.gallery_worlds(classroom_id,enabled) VALUES(${params.classroomId},${body.enabled}) ON CONFLICT(classroom_id) DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=NOW()`;
    return { ok: true, enabled: body.enabled };
  }, { body: t.Object({ enabled: t.Boolean() }) })
  .put("/classrooms/:classroomId/gallery/train", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedClass(actor, params.classroomId);
    if (body.startStudentId) {
      const [student] = await sql<{ id: string }[]>`SELECT id FROM classroom.students WHERE id=${body.startStudentId} AND classroom_id=${params.classroomId} AND archived_at IS NULL AND student_number IS NOT NULL`;
      if (!student) throw new HttpError(400, "เลือกนักเรียนที่ยังใช้งานและมีเลขที่ในห้องนี้");
    }
    await sql`INSERT INTO classroom.gallery_worlds(classroom_id,enabled,train_mode,train_interval_seconds,train_start_student_id) VALUES(${params.classroomId},false,${body.mode},${body.intervalSeconds},${body.startStudentId ?? null}) ON CONFLICT(classroom_id) DO UPDATE SET train_mode=EXCLUDED.train_mode, train_interval_seconds=EXCLUDED.train_interval_seconds, train_start_student_id=EXCLUDED.train_start_student_id, updated_at=NOW()`;
    return { ok: true, mode: body.mode, intervalSeconds: body.intervalSeconds, startStudentId: body.startStudentId ?? null };
  }, { body: t.Object({ mode: t.Union([t.Literal("auto"), t.Literal("manual")]), intervalSeconds: t.Union([t.Literal(60), t.Literal(120)]), startStudentId: t.Optional(t.Nullable(t.String({ format: "uuid" }))) }) })
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
    const [row] = await sql<{ storageName: string; originalName: string }[]>`SELECT f.storage_name AS "storageName", f.original_name AS "originalName" FROM classroom.files f JOIN classroom.students s ON s.id=f.student_id JOIN classroom.assignments a ON a.id=f.assignment_id LEFT JOIN classroom.gallery_hidden_models h ON h.file_id=f.id AND h.classroom_id=f.classroom_id WHERE f.id=${params.fileId} AND f.classroom_id=${params.classroomId} AND f.kind IN ('model','submission') AND lower(f.original_name) ~ '\\.(stl|obj|glb|gltf)$' AND s.archived_at IS NULL AND a.archived_at IS NULL AND (${teacher !== null} OR h.file_id IS NULL)`;
    if (!row) throw new HttpError(404, "ไม่พบโมเดลนี้");
    const path = await storedFilePath(row.storageName);
    return new Response(Bun.file(path), { headers: { "content-type": ({"stl":"model/stl","obj":"model/obj","glb":"model/gltf-binary","gltf":"model/gltf+json"} as Record<string,string>)[row.originalName.split(".").pop()!.toLowerCase()], "content-disposition": "inline; filename*=UTF-8''" + encodeURIComponent(row.originalName), "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  })
  .get("/classrooms/:classroomId/gallery/files/:fileId/material", async ({ params, request }) => {
    const teacher = await readActor(request); const student = teacher ? null : await readStudentActor(request);
    if (teacher) await ownedClass(teacher, params.classroomId); else if (student) await studentClass(student.id, params.classroomId); else throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
    const [row] = await sql<{ storageName: string; originalName: string }[]>`SELECT f.material_storage_name AS "storageName", f.material_original_name AS "originalName" FROM classroom.files f JOIN classroom.students s ON s.id=f.student_id JOIN classroom.assignments a ON a.id=f.assignment_id LEFT JOIN classroom.gallery_hidden_models h ON h.file_id=f.id AND h.classroom_id=f.classroom_id WHERE f.id=${params.fileId} AND f.classroom_id=${params.classroomId} AND f.kind IN ('model','submission') AND lower(f.original_name) ~ '\\.obj$' AND f.material_storage_name IS NOT NULL AND s.archived_at IS NULL AND a.archived_at IS NULL AND (${teacher !== null} OR h.file_id IS NULL)`;
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
    const [row] = await sql<{ thumbnailMediaType: string | null }[]>`SELECT f.thumbnail_media_type AS "thumbnailMediaType" FROM classroom.files f JOIN classroom.students s ON s.id=f.student_id JOIN classroom.assignments a ON a.id=f.assignment_id LEFT JOIN classroom.gallery_hidden_models h ON h.file_id=f.id AND h.classroom_id=f.classroom_id WHERE f.id=${params.fileId} AND f.classroom_id=${params.classroomId} AND f.kind IN ('model','submission') AND s.archived_at IS NULL AND a.archived_at IS NULL AND f.thumbnail_size_bytes IS NOT NULL AND (${teacher !== null} OR h.file_id IS NULL)`;
    if (!row?.thumbnailMediaType) throw new HttpError(404, "ยังไม่มีภาพตัวอย่าง");
    const path = await storedFilePath("thumbnails/" + params.fileId + (row.thumbnailMediaType === "image/webp" ? ".webp" : ".png"));
    return new Response(Bun.file(path), { headers: { "content-type": row.thumbnailMediaType, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  })
  .put("/classrooms/:classroomId/gallery/files/:fileId/visibility", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedClass(actor, params.classroomId);
    const [file] = await sql<{ id: string }[]>`SELECT id FROM classroom.files WHERE id=${params.fileId} AND classroom_id=${params.classroomId} AND kind IN ('model','submission') AND lower(original_name) ~ '\\.(stl|obj|glb|gltf)$'`;
    if (!file) throw new HttpError(404, "ไม่พบโมเดลนี้");
    if (body.hidden) await sql`INSERT INTO classroom.gallery_hidden_models(classroom_id,file_id,hidden_by) VALUES(${params.classroomId},${params.fileId},${actor.id}) ON CONFLICT DO NOTHING`;
    else await sql`DELETE FROM classroom.gallery_hidden_models WHERE classroom_id=${params.classroomId} AND file_id=${params.fileId}`;
    return { ok: true, hidden: body.hidden };
  }, { body: t.Object({ hidden: t.Boolean() }) })
  .put("/classrooms/:classroomId/gallery/files/:fileId/like", async ({ params, request }) => {
    checkRequestOrigin(request);
    const actor = await readStudentActor(request);
    if (!actor) throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
    const studentId = await studentClass(actor.id, params.classroomId);
    const [result] = await sql<{ likes: number; eligible: boolean }[]>`WITH eligible AS (SELECT f.id FROM classroom.files f JOIN classroom.students owner ON owner.id=f.student_id JOIN classroom.assignments a ON a.id=f.assignment_id LEFT JOIN classroom.gallery_hidden_models h ON h.file_id=f.id AND h.classroom_id=f.classroom_id WHERE f.id=${params.fileId} AND f.classroom_id=${params.classroomId} AND f.kind IN ('model','submission') AND lower(f.original_name) ~ '\\.(stl|obj|glb|gltf)$' AND owner.archived_at IS NULL AND a.archived_at IS NULL AND h.file_id IS NULL AND owner.id <> ${studentId}), inserted AS (INSERT INTO classroom.gallery_likes(classroom_id,file_id,student_id) SELECT ${params.classroomId}, eligible.id, ${studentId} FROM eligible ON CONFLICT DO NOTHING RETURNING file_id) SELECT COUNT(l.file_id)::int AS likes, EXISTS(SELECT 1 FROM eligible) AS eligible FROM classroom.gallery_likes l WHERE l.file_id=${params.fileId}`;
    if (!result.eligible) throw new HttpError(404, "ไม่พบโมเดลนี้หรือไม่สามารถกดถูกใจให้ผลงานตนเองได้");
    return { likes: result.likes };
  })
  .delete("/classrooms/:classroomId/gallery/files/:fileId/like", async ({ params, request }) => {
    checkRequestOrigin(request);
    const actor = await readStudentActor(request);
    if (!actor) throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
    const studentId = await studentClass(actor.id, params.classroomId);
    await sql`DELETE FROM classroom.gallery_likes WHERE classroom_id=${params.classroomId} AND file_id=${params.fileId} AND student_id=${studentId}`;
    const [row] = await sql<{ likes: number }[]>`SELECT COUNT(*)::int AS likes FROM classroom.gallery_likes WHERE classroom_id=${params.classroomId} AND file_id=${params.fileId}`;
    return { likes: row.likes };
  });
