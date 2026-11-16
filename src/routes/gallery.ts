import { createHash, randomBytes } from "node:crypto";
import { Elysia, t } from "elysia";
import { requireActor, readActor, readStudentActor, type Actor } from "../auth/session";
import { sql } from "../db/client";
import { HttpError } from "../http-error";
import { checkRequestOrigin } from "../security";
import { storedFilePath } from "../file-storage";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const avatarSchema = t.Object({
  skinColor: t.String({ pattern: "^#[0-9a-fA-F]{6}$" }),
  hairColor: t.String({ pattern: "^#[0-9a-fA-F]{6}$" }),
  shirtColor: t.String({ pattern: "^#[0-9a-fA-F]{6}$" }),
  trousersColor: t.String({ pattern: "^#[0-9a-fA-F]{6}$" }),
  hairStyle: t.Union([t.Literal("none"), t.Literal("short"), t.Literal("long")]),
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
  const [member] = await sql<{ studentId: string }[]>`SELECT s.id AS "studentId" FROM classroom.students s JOIN classroom.classrooms c ON c.id=s.classroom_id JOIN classroom.gallery_worlds w ON w.classroom_id=c.id WHERE s.account_id=${accountId} AND s.classroom_id=${classroomId} AND s.archived_at IS NULL AND c.archived_at IS NULL AND w.enabled`;
  if (!member) throw new HttpError(404, "ไม่พบโลกเสมือนนี้");
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
      if (row) return row.avatarSettings;
    }
    const student = teacher ? null : await readStudentActor(request);
    if (student) {
      const [row] = await sql<{ avatarSettings: unknown }[]>`SELECT avatar_settings AS "avatarSettings" FROM classroom.student_accounts WHERE id=${student.id}`;
      if (row) return row.avatarSettings;
    }
    throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
  })
  .put("/gallery/avatar", async ({ request, body }) => {
    checkRequestOrigin(request);
    const teacher = await readActor(request);
    if (teacher) {
      await sql`UPDATE classroom.teachers SET avatar_settings=${sql.json(body)} WHERE id=${teacher.id}`;
      return body;
    }
    const student = await readStudentActor(request);
    if (student) {
      await sql`UPDATE classroom.student_accounts SET avatar_settings=${sql.json(body)} WHERE id=${student.id}`;
      return body;
    }
    throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
  }, { body: avatarSchema })
  .get("/student/worlds", async ({ request }) => {
    const actor = await readStudentActor(request);
    if (!actor) throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
    return sql`SELECT c.id AS "classroomId", c.name AS "classroomName" FROM classroom.students s JOIN classroom.classrooms c ON c.id=s.classroom_id JOIN classroom.gallery_worlds w ON w.classroom_id=c.id WHERE s.account_id=${actor.id} AND s.archived_at IS NULL AND c.archived_at IS NULL AND w.enabled ORDER BY c.name`;
  })
  .get("/classrooms/:classroomId/gallery", async ({ params, request, query }) => {
    const teacher = await readActor(request);
    const student = teacher ? null : await readStudentActor(request);
    let viewerStudentId: string | null = null;
    if (teacher) await ownedClass(teacher, params.classroomId);
    else if (student) viewerStudentId = await studentClass(student.id, params.classroomId);
    else throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
    const [world] = await sql<{ enabled: boolean; classroomName: string }[]>`SELECT w.enabled, c.name AS "classroomName" FROM classroom.gallery_worlds w JOIN classroom.classrooms c ON c.id=w.classroom_id WHERE w.classroom_id=${params.classroomId}`;
    if (!world?.enabled) throw new HttpError(404, "ยังไม่ได้เปิดโลกเสมือน");
    await ensureBlocks(params.classroomId);
    const offset = Math.max(0, Math.min(100000, Number(query.offset) || 0));
    const [blocks, models] = await Promise.all([
      sql`SELECT s.id AS "studentId", s.display_name AS "displayName", s.student_number AS "studentNumber", b.block_index AS "blockIndex", FALSE AS archived FROM classroom.gallery_blocks b JOIN classroom.students s ON s.id=b.student_id WHERE b.classroom_id=${params.classroomId} AND s.archived_at IS NULL ORDER BY b.block_index`,
      sql`SELECT f.id, f.student_id AS "studentId", s.display_name AS "displayName", s.student_number AS "studentNumber", a.id AS "assignmentId", a.title AS "assignmentTitle", f.original_name AS "originalName", f.media_type AS "mediaType", f.thumbnail_size_bytes IS NOT NULL AS "thumbnailAvailable", f.created_at AS "createdAt", (h.file_id IS NOT NULL) AS hidden, (SELECT COUNT(*)::int FROM classroom.gallery_likes l WHERE l.file_id=f.id) AS likes, ${student?.id ?? null}::uuid IS NOT NULL AND f.student_id <> (SELECT s2.id FROM classroom.students s2 WHERE s2.account_id=${student?.id ?? null} AND s2.classroom_id=${params.classroomId} AND s2.archived_at IS NULL LIMIT 1) AND EXISTS (SELECT 1 FROM classroom.gallery_likes l JOIN classroom.students ls ON ls.id=l.student_id WHERE l.file_id=f.id AND ls.account_id=${student?.id ?? null}) AS "likedByMe"
        FROM classroom.files f JOIN classroom.students s ON s.id=f.student_id JOIN classroom.assignments a ON a.id=f.assignment_id LEFT JOIN classroom.gallery_hidden_models h ON h.classroom_id=f.classroom_id AND h.file_id=f.id
        WHERE f.classroom_id=${params.classroomId} AND f.kind IN ('model','submission') AND lower(f.original_name) ~ '\\.(stl|obj)$' AND s.archived_at IS NULL AND a.archived_at IS NULL AND (${teacher !== null} OR h.file_id IS NULL)
        ORDER BY btrim(s.display_name), f.created_at DESC LIMIT 40 OFFSET ${offset}`,
    ]);
    const [count] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM classroom.files f JOIN classroom.students s ON s.id=f.student_id JOIN classroom.assignments a ON a.id=f.assignment_id LEFT JOIN classroom.gallery_hidden_models h ON h.classroom_id=f.classroom_id AND h.file_id=f.id WHERE f.classroom_id=${params.classroomId} AND f.kind IN ('model','submission') AND lower(f.original_name) ~ '\\.(stl|obj)$' AND s.archived_at IS NULL AND a.archived_at IS NULL AND (${teacher !== null} OR h.file_id IS NULL)`;
    return { classroomId: params.classroomId, classroomName: world.classroomName, blocks, models, nextOffset: offset + models.length < count.count ? offset + models.length : null, teacher: Boolean(teacher), viewerStudentId };
  })
  .put("/classrooms/:classroomId/gallery", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedClass(actor, params.classroomId);
    await sql`INSERT INTO classroom.gallery_worlds(classroom_id,enabled) VALUES(${params.classroomId},${body.enabled}) ON CONFLICT(classroom_id) DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=NOW()`;
    return { ok: true, enabled: body.enabled };
  }, { body: t.Object({ enabled: t.Boolean() }) })
  .post("/classrooms/:classroomId/gallery/ticket", async ({ params, request }) => {
    checkRequestOrigin(request);
    const teacher = await readActor(request);
    const student = teacher ? null : await readStudentActor(request);
    if (teacher) await ownedClass(teacher, params.classroomId);
    else if (student) await studentClass(student.id, params.classroomId);
    else throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
    const token = randomBytes(32).toString("base64url");
    const sessionHash = hash(cookieToken(request));
    const actorId = teacher?.id ?? student!.id;
    const studentId = student ? await studentClass(student.id, params.classroomId) : null;
    const [enabled] = await sql<{ enabled: boolean }[]>`SELECT enabled FROM classroom.gallery_worlds WHERE classroom_id=${params.classroomId}`;
    if (!enabled?.enabled) throw new HttpError(404, "ยังไม่ได้เปิดโลกเสมือน");
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
    const [row] = await sql<{ storageName: string; originalName: string }[]>`SELECT f.storage_name AS "storageName", f.original_name AS "originalName" FROM classroom.files f JOIN classroom.students s ON s.id=f.student_id JOIN classroom.assignments a ON a.id=f.assignment_id LEFT JOIN classroom.gallery_hidden_models h ON h.file_id=f.id AND h.classroom_id=f.classroom_id WHERE f.id=${params.fileId} AND f.classroom_id=${params.classroomId} AND f.kind IN ('model','submission') AND lower(f.original_name) ~ '\\.(stl|obj)$' AND s.archived_at IS NULL AND a.archived_at IS NULL AND (${teacher !== null} OR h.file_id IS NULL)`;
    if (!row) throw new HttpError(404, "ไม่พบโมเดลนี้");
    const path = await storedFilePath(row.storageName);
    return new Response(Bun.file(path), { headers: { "content-type": row.originalName.toLowerCase().endsWith(".stl") ? "model/stl" : "model/obj", "content-disposition": "inline; filename*=UTF-8''" + encodeURIComponent(row.originalName), "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
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
    const [file] = await sql<{ id: string }[]>`SELECT id FROM classroom.files WHERE id=${params.fileId} AND classroom_id=${params.classroomId} AND kind IN ('model','submission') AND lower(original_name) ~ '\\.(stl|obj)$'`;
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
    const [result] = await sql<{ likes: number; eligible: boolean }[]>`WITH eligible AS (SELECT f.id FROM classroom.files f JOIN classroom.students owner ON owner.id=f.student_id JOIN classroom.assignments a ON a.id=f.assignment_id LEFT JOIN classroom.gallery_hidden_models h ON h.file_id=f.id AND h.classroom_id=f.classroom_id WHERE f.id=${params.fileId} AND f.classroom_id=${params.classroomId} AND f.kind IN ('model','submission') AND lower(f.original_name) ~ '\\.(stl|obj)$' AND owner.archived_at IS NULL AND a.archived_at IS NULL AND h.file_id IS NULL AND owner.id <> ${studentId}), inserted AS (INSERT INTO classroom.gallery_likes(classroom_id,file_id,student_id) SELECT ${params.classroomId}, eligible.id, ${studentId} FROM eligible ON CONFLICT DO NOTHING RETURNING file_id) SELECT COUNT(l.file_id)::int AS likes, EXISTS(SELECT 1 FROM eligible) AS eligible FROM classroom.gallery_likes l WHERE l.file_id=${params.fileId}`;
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
