import { Elysia, t } from "elysia";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type postgres from "postgres";
import sharp from "sharp";
import { requireActor, requireStudent } from "../auth/session";
import { sql } from "../db/client";
import { HttpError } from "../http-error";
import { checkRequestOrigin, cleanText } from "../security";
import { cleanupUnusedLessonImages, maxStoredBytes, maxUploadBytes, uploadRoot, storedFilePath } from "../file-storage";

import { validWioMaxScore, wioLabIds, wioMaxScore, type WioLabSettings } from "../wio-labs";

const block = t.Union([
  t.Object({ type: t.Literal("text"), heading: t.Optional(t.String({ maxLength: 120 })), text: t.String({ maxLength: 10000 }) }),
  t.Object({ type: t.Literal("image"), imageId: t.String({ format: "uuid" }), alt: t.String({ maxLength: 300 }), caption: t.Optional(t.String({ maxLength: 500 })) }),
  t.Object({ type: t.Literal("youtube"), videoId: t.String({ pattern: "^[A-Za-z0-9_-]{11}$" }), caption: t.Optional(t.String({ maxLength: 500 })) }),
  t.Object({ type: t.Literal("code"), html: t.String({ maxLength: 1048576 }), css: t.String({ maxLength: 1048576 }), javascript: t.String({ maxLength: 1048576 }), framework: t.Optional(t.Union([t.Literal("none"), t.Literal("bootstrap")])), imageIds: t.Optional(t.Array(t.String({ format: "uuid" }), { maxItems: 50 })) }),
]);
const blocks = t.Array(block, { maxItems: 100 });
const revisionBody = t.Object({ expectedRevision: t.Integer({ minimum: 0 }) });
const quizLinksSchema = t.Array(t.Object({ quizId: t.String({ format: "uuid" }), label: t.String({ minLength: 1, maxLength: 100 }) }), { maxItems: 20 });
const wioLabSettings = t.Object({
  preset: t.Union(wioLabIds.map((id) => t.Literal(id))),
  title: t.String({ minLength: 1, maxLength: 120 }),
  instructions: t.String({ maxLength: 5000 }),
  maxScore: t.Number({ minimum: 0.01, maximum: wioMaxScore }),
});
const lessonBody = t.Object({ title: t.String({ minLength: 1, maxLength: 120 }), blocks, quizLinks: t.Optional(quizLinksSchema), wioLab: t.Optional(t.Nullable(wioLabSettings)), expectedRevision: t.Integer({ minimum: 0 }) });
type LessonBlock = { type: "text"; heading?: string; text: string } | { type: "image"; imageId: string; alt: string; caption?: string } | { type: "youtube"; videoId: string; caption?: string } | { type: "code"; html: string; css: string; javascript: string; framework?: "none" | "bootstrap"; imageIds?: string[] };
type StoredBlock = Exclude<LessonBlock, { type: "code" }> | Extract<LessonBlock, { type: "code" }> & { imageIds: string[] };
const lessonImagePattern = /lesson-image:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/gi;
const uuid = t.String({ format: "uuid" });
const classLessonParams = t.Object({ classroomId: uuid, id: uuid });

function normalizeWioLab(lab: WioLabSettings | null) {
  if (lab && !validWioMaxScore(lab.maxScore)) throw new HttpError(422, "คะแนนเต็มต้องใช้ทศนิยมไม่เกิน 2 ตำแหน่ง");
  return lab ? { ...lab, title: cleanText(lab.title, 120), instructions: lab.instructions.trim() } : null;
}

async function lockLessonAndClassroom(db: postgres.ISql, ownerId: string, lessonId: string, classroomId: string) {
  const [lesson] = await db<{ publishedAt: string | null; wioLab: WioLabSettings | null }[]>`
    SELECT published_at AS "publishedAt", published_wio_lab AS "wioLab" FROM classroom.lesson_pages
    WHERE id = ${lessonId} AND owner_id = ${ownerId} AND trashed_at IS NULL FOR UPDATE`;
  const [room] = await db`SELECT id FROM classroom.classrooms
    WHERE id = ${classroomId} AND owner_id = ${ownerId} AND archived_at IS NULL FOR SHARE`;
  if (!lesson || !room) throw new HttpError(404, "ไม่พบบทเรียนหรือห้องเรียน");
  return lesson;
}

async function requireActiveWioAssignment(db: postgres.ISql, classroomId: string, assignmentId: string) {
  const [assignment] = await db`SELECT id FROM classroom.assignments
    WHERE id = ${assignmentId} AND classroom_id = ${classroomId} AND wio_lab IS NOT NULL AND archived_at IS NULL FOR SHARE`;
  if (!assignment) throw new HttpError(404, "ไม่พบงาน Wio Terminal ที่เปิดอยู่ในห้องนี้");
}

async function createWioAssignment(db: postgres.ISql, classroomId: string, lab: WioLabSettings) {
  const [assignment] = await db<{ id: string }[]>`
    INSERT INTO classroom.assignments (classroom_id, title, instructions, max_score, wio_lab)
    VALUES (${classroomId}, ${lab.title}, ${lab.instructions}, ${lab.maxScore}, ${lab.preset})
    RETURNING id`;
  return assignment.id;
}

async function changeClassAssignment(request: Request, lessonId: string, classroomId: string, assign: boolean, existingLabId?: string) {
  checkRequestOrigin(request);
  const actor = await requireActor(request);
  return sql.begin(async (tx) => {
    const lesson = await lockLessonAndClassroom(tx, actor.id, lessonId, classroomId);
    if (!assign) {
      await tx`DELETE FROM classroom.classroom_lessons WHERE classroom_id = ${classroomId} AND lesson_id = ${lessonId}`;
      return { ok: true };
    }
    if (!lesson.publishedAt) throw new HttpError(422, "เผยแพร่บทเรียนก่อนมอบหมาย");
    const [link] = await tx<{ assignmentId: string | null }[]>`
      SELECT wio_assignment_id AS "assignmentId" FROM classroom.classroom_lessons WHERE classroom_id = ${classroomId} AND lesson_id = ${lessonId}`;
    if (link) return { ok: true, assignmentId: link.assignmentId };

    let assignmentId = existingLabId ?? null;
    if (assignmentId) await requireActiveWioAssignment(tx, classroomId, assignmentId);
    else if (lesson.wioLab) assignmentId = await createWioAssignment(tx, classroomId, lesson.wioLab);
    await tx`INSERT INTO classroom.classroom_lessons (classroom_id, lesson_id, wio_assignment_id)
      VALUES (${classroomId}, ${lessonId}, ${assignmentId})`;
    await tx`UPDATE classroom.lesson_pages SET legacy_public = FALSE WHERE id = ${lessonId} AND legacy_public`;
    return { ok: true, assignmentId };
  });
}

function cleanupLater() {
  void cleanupUnusedLessonImages().catch((error) => console.error("Lesson image cleanup deferred", error instanceof Error ? error.name : "unknown error"));
}

async function ownedPage(id: string, ownerId: string) {
  const [page] = await sql`SELECT id FROM classroom.lesson_pages WHERE id = ${id} AND owner_id = ${ownerId} AND trashed_at IS NULL`;
  if (!page) throw new HttpError(404, "ไม่พบบทเรียนนี้");
}

async function usedStorageBytes(tx: postgres.ISql) {
  const [usage] = await tx<{ used: string }[]>`
    SELECT (
      (SELECT COALESCE(SUM(size_bytes + COALESCE(material_size_bytes, 0) + COALESCE(thumbnail_size_bytes, 0)), 0) FROM classroom.files) +
      (SELECT COALESCE(SUM(size_bytes), 0) FROM classroom.lesson_page_images) +
      (SELECT COALESCE(SUM(size_bytes), 0) FROM classroom.quiz_images)
    )::text AS used
  `;
  return Number(usage.used);
}

export const lessonPageRoutes = new Elysia({ prefix: "/api" })
  .get("/lesson-pages/:id/classrooms", async ({ params, request }) => {
    const actor = await requireActor(request);
    const [lesson] = await sql`SELECT legacy_public AS "legacyPublic", published_wio_lab AS "publishedWioLab" FROM classroom.lesson_pages
      WHERE id = ${params.id} AND owner_id = ${actor.id} AND trashed_at IS NULL`;
    if (!lesson) throw new HttpError(404, "ไม่พบบทเรียนนี้");
    const classrooms = await sql`SELECT c.id, c.name, a.lesson_id IS NOT NULL AS assigned,
        CASE WHEN linked.id IS NOT NULL THEN jsonb_build_object('id', linked.id, 'title', linked.title,
          'active', linked.archived_at IS NULL AND linked.wio_lab IS NOT NULL) END AS "wioLab",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id', candidate.id, 'title', candidate.title) ORDER BY candidate.title, candidate.id)
          FROM classroom.assignments candidate
          WHERE candidate.classroom_id = c.id AND candidate.archived_at IS NULL AND candidate.wio_lab IS NOT NULL), '[]'::jsonb) AS "wioChoices"
      FROM classroom.classrooms c LEFT JOIN classroom.classroom_lessons a ON a.classroom_id = c.id AND a.lesson_id = ${params.id}
      LEFT JOIN classroom.assignments linked ON linked.id = a.wio_assignment_id AND linked.classroom_id = c.id
      WHERE c.owner_id = ${actor.id} AND c.archived_at IS NULL ORDER BY c.name, c.id`;
    return { ...lesson, classrooms };
  }, { params: t.Object({ id: uuid }) })
  .put("/lesson-pages/:id/classrooms/:classroomId", ({ params, body, request }) =>
    changeClassAssignment(request, params.id, params.classroomId, true, body?.assignmentId),
  { params: classLessonParams, body: t.Optional(t.Object({ assignmentId: uuid })) })
  .put("/lesson-pages/:id/classrooms/:classroomId/wio-lab", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    return sql.begin(async (tx) => {
      const { id, classroomId } = params;
      const lesson = await lockLessonAndClassroom(tx, actor.id, id, classroomId);
      const [link] = await tx<{ assignmentId: string | null }[]>`
        SELECT wio_assignment_id AS "assignmentId" FROM classroom.classroom_lessons WHERE classroom_id = ${classroomId} AND lesson_id = ${id}`;
      if (!link) throw new HttpError(404, "มอบหมายบทเรียนให้ห้องนี้ก่อนเพิ่มห้องปฏิบัติการ");
      if (link.assignmentId !== body.expectedAssignmentId) throw new HttpError(409, "ห้องปฏิบัติการถูกเปลี่ยนแล้ว กรุณาโหลดใหม่");
      let assignmentId: string | null;
      if ("create" in body) {
        if (!lesson.publishedAt) throw new HttpError(422, "เผยแพร่บทเรียนก่อนเพิ่มห้องปฏิบัติการ");
        assignmentId = await createWioAssignment(tx, classroomId, normalizeWioLab(body.create)!);
      } else {
        assignmentId = body.assignmentId;
        if (assignmentId) {
          if (!lesson.publishedAt) throw new HttpError(422, "เผยแพร่บทเรียนก่อนเพิ่มห้องปฏิบัติการ");
          await requireActiveWioAssignment(tx, classroomId, assignmentId);
        }
      }
      await tx`UPDATE classroom.classroom_lessons SET wio_assignment_id = ${assignmentId}
        WHERE classroom_id = ${classroomId} AND lesson_id = ${id}`;
      return { ok: true, assignmentId };
    });
  }, { params: classLessonParams, body: t.Union([
    t.Object({ expectedAssignmentId: t.Nullable(uuid), assignmentId: t.Nullable(uuid) }),
    t.Object({ expectedAssignmentId: t.Nullable(uuid), create: wioLabSettings }),
  ]) })
  .delete("/lesson-pages/:id/classrooms/:classroomId", ({ params, request }) =>
    changeClassAssignment(request, params.id, params.classroomId, false), { params: classLessonParams })
  .get("/classrooms/:classroomId/lesson-pages", async ({ params, request }) => {
    const actor = await requireActor(request);
    const [room] = await sql`SELECT id FROM classroom.classrooms
      WHERE id = ${params.classroomId} AND owner_id = ${actor.id} AND archived_at IS NULL`;
    if (!room) throw new HttpError(404, "ไม่พบห้องเรียนนี้");
    return sql`SELECT l.id, l.published_title AS title FROM classroom.classroom_lessons a
      JOIN classroom.lesson_pages l ON l.id = a.lesson_id
      WHERE a.classroom_id = ${params.classroomId} AND l.trashed_at IS NULL AND l.published_blocks IS NOT NULL
      ORDER BY l.published_title, l.id`;
  }, { params: t.Object({ classroomId: uuid }) })
  .get("/lesson-pages", async ({ request }) => {
    const actor = await requireActor(request);
    const trashed = new URL(request.url).searchParams.get("trashed") === "true";
    return sql`SELECT id, title, editor_mode AS "editorMode", draft_revision AS "draftRevision", published_at AS "publishedAt", updated_at AS "updatedAt"
      FROM classroom.lesson_pages WHERE owner_id = ${actor.id} AND (trashed_at IS NOT NULL) = ${trashed} ORDER BY updated_at DESC`;
  })
  .post("/lesson-pages/:id/trash", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const [page] = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(870010022)`;
      return tx`UPDATE classroom.lesson_pages SET trashed_at = NOW(), draft_revision = draft_revision + 1,
        updated_at = NOW() WHERE id = ${params.id} AND owner_id = ${actor.id} AND trashed_at IS NULL
        AND draft_revision = ${body.expectedRevision} RETURNING id`;
    });
    if (!page) await conflictOrMissing(params.id, actor.id);
    return { ok: true };
  }, { body: revisionBody })
  .post("/lesson-pages/:id/restore", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const [page] = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(870010022)`;
      return tx`UPDATE classroom.lesson_pages SET trashed_at = NULL, draft_revision = draft_revision + 1,
        updated_at = NOW() WHERE id = ${params.id} AND owner_id = ${actor.id} AND trashed_at IS NOT NULL
        AND draft_revision = ${body.expectedRevision} RETURNING id`;
    });
    if (!page) {
      const [current] = await sql`SELECT id FROM classroom.lesson_pages WHERE id = ${params.id} AND owner_id = ${actor.id} AND trashed_at IS NOT NULL`;
      if (!current) throw new HttpError(404, "ไม่พบบทเรียนในถังขยะนี้");
      throw new HttpError(409, "บทเรียนถูกเปลี่ยนจากอีกหน้าต่าง กรุณาโหลดรายการใหม่");
    }
    return { ok: true };
  }, { body: revisionBody })
  .delete("/lesson-pages/:id", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const staged: { id: string; path: string; tombstone: string }[] = [];
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(870010022)`;
        const [page] = await tx<{ title: string; revision: number }[]>`SELECT title, draft_revision AS revision FROM classroom.lesson_pages
          WHERE id = ${params.id} AND owner_id = ${actor.id} AND trashed_at IS NOT NULL FOR UPDATE`;
        if (!page) throw new HttpError(404, "ไม่พบบทเรียนในถังขยะนี้");
        if (page.revision !== body.expectedRevision) throw new HttpError(409, "บทเรียนถูกเปลี่ยนจากอีกหน้าต่าง กรุณาโหลดรายการใหม่");
        if (body.confirmTitle !== page.title) throw new HttpError(422, "ชื่อบทเรียนที่ยืนยันไม่ตรงกัน");
        const images = await tx<{ id: string; storageName: string }[]>`SELECT id, storage_name AS "storageName"
          FROM classroom.lesson_page_images WHERE lesson_id = ${params.id} FOR UPDATE`;
        for (const image of images) {
          const path = resolve(uploadRoot(), image.storageName); const tombstone = path + ".deleting";
          try { await rename(path, tombstone); staged.push({ id: image.id, path, tombstone }); }
          catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
        }
        await tx`DELETE FROM classroom.lesson_pages WHERE id = ${params.id} AND owner_id = ${actor.id} AND trashed_at IS NOT NULL`;
      });
    } catch (error) {
      for (const image of staged) {
        try {
          const [record] = await sql`SELECT id FROM classroom.lesson_page_images WHERE id = ${image.id}`;
          if (record) await rename(image.tombstone, image.path).catch(() => {});
          else await rm(image.tombstone, { force: true }).catch(() => {});
        } catch { /* Startup reconciliation resolves uncertain commits. */ }
      }
      throw error;
    }
    let cleanupPending = false;
    for (const image of staged) if (await rm(image.tombstone, { force: true }).then(() => false, () => true)) cleanupPending = true;
    cleanupLater();
    return { ok: true, cleanupPending };
  }, { body: t.Object({ expectedRevision: t.Integer({ minimum: 0 }), confirmTitle: t.String({ minLength: 1, maxLength: 120 }) }) })
  .post("/lesson-pages", async ({ body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const editorMode = body.editorMode ?? "blocks";
    const initialBlocks: StoredBlock[] = editorMode === "code" ? [{ type: "code", html: "", css: "", javascript: "", framework: "none", imageIds: [] }] : [];
    const [page] = await sql`INSERT INTO classroom.lesson_pages (owner_id, title, editor_mode, draft_blocks)
      VALUES (${actor.id}, ${cleanText(body.title, 120)}, ${editorMode}, ${sql.json(initialBlocks)})
      RETURNING id, title, editor_mode AS "editorMode", draft_blocks AS blocks, draft_revision AS revision,
        published_at AS "publishedAt", published_revision AS "publishedRevision"`;
    return page;
  }, { body: t.Object({ title: t.String({ minLength: 1, maxLength: 120 }), editorMode: t.Optional(t.Union([t.Literal("blocks"), t.Literal("code")])) }) })
  .get("/lesson-pages/:id", async ({ params, request }) => {
    const actor = await requireActor(request);
    const [page] = await sql`SELECT id, title, editor_mode AS "editorMode", draft_blocks AS blocks, draft_revision AS revision,
      published_title AS "publishedTitle", published_at AS "publishedAt", published_revision AS "publishedRevision",
      draft_quiz_links AS "quizLinks", draft_wio_lab AS "wioLab"
      FROM classroom.lesson_pages WHERE id = ${params.id} AND owner_id = ${actor.id} AND trashed_at IS NULL`;
    if (!page) throw new HttpError(404, "ไม่พบบทเรียนนี้");
    return page;
  })
  .put("/lesson-pages/:id/draft", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const [page] = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(870010022)`;
      const [current] = await tx<{ editorMode: "blocks" | "code"; quizLinks: { quizId: string; label: string }[]; wioLab: WioLabSettings | null }[]>`SELECT editor_mode AS "editorMode", draft_quiz_links AS "quizLinks", draft_wio_lab AS "wioLab" FROM classroom.lesson_pages
        WHERE id = ${params.id} AND owner_id = ${actor.id} AND trashed_at IS NULL AND draft_revision = ${body.expectedRevision} FOR UPDATE`;
      if (!current) return [];
      const content = normalizeBlocks(current.editorMode, body.blocks);
      await validateImageReferences(params.id, actor.id, content, tx);
      const quizLinks = body.quizLinks ? normalizeQuizLinks(body.quizLinks) : current.quizLinks;
      await validateQuizLinks(actor.id, quizLinks, tx);
      const lab = body.wioLab === undefined ? current.wioLab : normalizeWioLab(body.wioLab);
      const labJson = lab ? sql.json(lab) : null;
      return tx`UPDATE classroom.lesson_pages
        SET title = ${cleanText(body.title, 120)}, draft_blocks = ${sql.json(content)}, draft_quiz_links = ${sql.json(quizLinks)},
          draft_wio_lab = ${labJson},
          draft_revision = draft_revision + 1, updated_at = NOW()
        WHERE id = ${params.id} AND owner_id = ${actor.id} AND trashed_at IS NULL AND draft_revision = ${body.expectedRevision}
        RETURNING id, title, editor_mode AS "editorMode", draft_blocks AS blocks, draft_revision AS revision,
          published_title AS "publishedTitle",
          published_at AS "publishedAt", published_revision AS "publishedRevision", draft_quiz_links AS "quizLinks", draft_wio_lab AS "wioLab"`;
    });
    if (!page) await conflictOrMissing(params.id, actor.id);
    cleanupLater();
    return page;
  }, { body: lessonBody })
  .post("/lesson-pages/:id/publish", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const [page] = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(870010022)`;
      const [current] = await tx<{ editorMode: "blocks" | "code"; quizLinks: { quizId: string; label: string }[]; wioLab: WioLabSettings | null }[]>`SELECT editor_mode AS "editorMode", draft_quiz_links AS "quizLinks", draft_wio_lab AS "wioLab" FROM classroom.lesson_pages
        WHERE id = ${params.id} AND owner_id = ${actor.id} AND trashed_at IS NULL AND draft_revision = ${body.expectedRevision} FOR UPDATE`;
      if (!current) return [];
      const content = normalizeBlocks(current.editorMode, body.blocks);
      await validateImageReferences(params.id, actor.id, content, tx);
      const quizLinks = body.quizLinks ? normalizeQuizLinks(body.quizLinks) : current.quizLinks;
      await validateQuizLinks(actor.id, quizLinks, tx);
      const lab = body.wioLab === undefined ? current.wioLab : normalizeWioLab(body.wioLab);
      const labJson = lab ? sql.json(lab) : null;
      return tx`UPDATE classroom.lesson_pages SET title = ${cleanText(body.title, 120)},
        draft_blocks = ${sql.json(content)}, draft_quiz_links = ${sql.json(quizLinks)}, draft_wio_lab = ${labJson}, draft_revision = draft_revision + 1,
        published_blocks = ${sql.json(content)}, published_title = ${cleanText(body.title, 120)}, published_revision = draft_revision + 1,
        published_quiz_links = ${sql.json(quizLinks)}, published_wio_lab = ${labJson},
        published_at = NOW(), updated_at = NOW()
        WHERE id = ${params.id} AND owner_id = ${actor.id} AND trashed_at IS NULL
        RETURNING id, title, editor_mode AS "editorMode", draft_blocks AS blocks, draft_revision AS revision,
          published_title AS "publishedTitle",
          published_at AS "publishedAt", published_revision AS "publishedRevision", draft_quiz_links AS "quizLinks", draft_wio_lab AS "wioLab"`;
    });
    if (!page) await conflictOrMissing(params.id, actor.id);
    cleanupLater();
    return page;
  }, { body: lessonBody })
  .post("/lesson-pages/:id/unpublish", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const [page] = await sql`UPDATE classroom.lesson_pages SET published_blocks = NULL,
      published_title = NULL, published_revision = NULL, published_quiz_links = NULL, published_wio_lab = NULL, published_at = NULL, updated_at = NOW()
      WHERE id = ${params.id} AND owner_id = ${actor.id} AND trashed_at IS NULL AND draft_revision = ${body.expectedRevision}
      RETURNING id`;
    if (!page) await conflictOrMissing(params.id, actor.id);
    cleanupLater();
    return { ok: true };
  }, { body: revisionBody })
  .post("/lesson-pages/:id/images", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedPage(params.id, actor.id);
    if (!body.file.size || body.file.size > maxUploadBytes()) throw new HttpError(413, "ไฟล์ภาพมีขนาดเกินกำหนด");
    let image: Buffer; let mediaType: string;
    try {
      const input = Buffer.from(await body.file.arrayBuffer());
      const processor = sharp(input, { failOn: "error", limitInputPixels: 40_000_000 });
      const metadata = await processor.metadata();
      if (!metadata.width || !metadata.height || metadata.pages && metadata.pages > 1 || !["jpeg", "png", "webp"].includes(metadata.format ?? "")) throw new Error("unsupported image");
      image = await sharp(input, { failOn: "error", limitInputPixels: 40_000_000 })
        .rotate().resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 }).toBuffer();
      if (image.byteLength > maxUploadBytes()) throw new HttpError(413, "ภาพหลังปรับขนาดมีขนาดเกินกำหนด");
      mediaType = "image/webp";
    } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(422, "รองรับภาพ PNG, JPEG หรือ WebP ที่เปิดได้เท่านั้น"); }
    const originalName = basename(body.file.name).replace(/[\\/\0-\x1f\x7f]/g, "_").trim().slice(-255) || "image";
    const id = randomUUID(); const storageName = id; const root = uploadRoot();
    await mkdir(root, { recursive: true, mode: 0o750 });
    const temporary = resolve(root, id + ".upload"); const destination = resolve(root, id); let renamed = false;
    try {
      await Bun.write(temporary, image);
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(870010022)`;
        const [lesson] = await tx`SELECT id FROM classroom.lesson_pages WHERE id = ${params.id} AND owner_id = ${actor.id} AND trashed_at IS NULL FOR UPDATE`;
        if (!lesson) throw new HttpError(404, "ไม่พบบทเรียนนี้");
        if (await usedStorageBytes(tx) + image.byteLength > maxStoredBytes()) throw new HttpError(413, "พื้นที่จัดเก็บไฟล์เต็มแล้ว");
        await rename(temporary, destination); renamed = true;
        await tx`INSERT INTO classroom.lesson_page_images (id, lesson_id, original_name, storage_name, size_bytes)
          VALUES (${id}, ${params.id}, ${originalName}, ${storageName}, ${image.byteLength})`;
      });
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      if (renamed) {
        try {
          const [record] = await sql`SELECT id FROM classroom.lesson_page_images WHERE id = ${id}`;
          if (!record) await rm(destination, { force: true });
        } catch { /* Startup reconciliation removes orphaned images when the commit result is unknown. */ }
      }
      throw error;
    }
    cleanupLater();
    return { id, originalName, mediaType };
  }, { body: t.Object({ file: t.File() }) })
  .get("/lesson-pages/:id/images", async ({ params, request }) => {
    const actor = await requireActor(request);
    const [page] = await sql`SELECT id FROM classroom.lesson_pages WHERE id = ${params.id} AND owner_id = ${actor.id} AND trashed_at IS NULL`;
    if (!page) throw new HttpError(404, "ไม่พบบทเรียนนี้");
    return sql`SELECT id, original_name AS "originalName", size_bytes AS "sizeBytes"
      FROM classroom.lesson_page_images WHERE lesson_id = ${params.id} ORDER BY created_at DESC`;
  })
  .get("/lesson-pages/:id/images/:imageId/content", async ({ params, request }) => {
    const actor = await requireActor(request);
    const [image] = await sql`SELECT i.storage_name AS "storageName" FROM classroom.lesson_page_images i
      JOIN classroom.lesson_pages l ON l.id = i.lesson_id
      WHERE l.id = ${params.id} AND i.id = ${params.imageId} AND l.owner_id = ${actor.id} AND l.trashed_at IS NULL`;
    if (!image) throw new HttpError(404, "ไม่พบภาพนี้");
    return imageResponse(await storedFilePath(image.storageName));
  });

function activeLessonMembership(classroomId: string, accountId: string) {
  return sql`EXISTS (SELECT 1 FROM classroom.classroom_lessons a
    JOIN classroom.classrooms c ON c.id = a.classroom_id AND c.archived_at IS NULL
    JOIN classroom.students s ON s.classroom_id = c.id AND s.archived_at IS NULL
    WHERE a.lesson_id = l.id AND a.classroom_id = ${classroomId} AND s.account_id = ${accountId})`;
}

async function readPublishedPage(id: string, access: ReturnType<typeof activeLessonMembership>) {
  const [page] = await sql`SELECT l.id, l.published_title AS title, l.editor_mode AS "editorMode", l.published_blocks AS blocks,
    l.published_quiz_links AS "quizLinks", l.published_at AS "publishedAt"
    FROM classroom.lesson_pages l
    WHERE l.id = ${id} AND l.trashed_at IS NULL AND l.published_blocks IS NOT NULL AND ${access}`;
  if (!page) throw new HttpError(404, "ไม่พบบทเรียนที่เผยแพร่แล้ว");
  if (page.quizLinks?.length) {
    const active = await sql`SELECT id FROM classroom.quizzes WHERE id = ANY(${page.quizLinks.map((link: { quizId: string }) => link.quizId)}::uuid[]) AND trashed_at IS NULL`;
    const activeIds = new Set(active.map((quiz) => quiz.id));
    page.quizLinks = page.quizLinks.filter((link: { quizId: string }) => activeIds.has(link.quizId));
  }
  return page;
}

async function readPublishedImage(id: string, imageId: string, access: ReturnType<typeof activeLessonMembership>) {
  const [image] = await sql`SELECT i.storage_name AS "storageName" FROM classroom.lesson_page_images i
    JOIN classroom.lesson_pages l ON l.id = i.lesson_id
    WHERE l.id = ${id} AND i.id = ${imageId} AND l.trashed_at IS NULL AND l.published_blocks IS NOT NULL AND ${access}
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(l.published_blocks) block
          WHERE (block->>'type' = 'image' AND block->>'imageId' = i.id::text)
            OR (block->>'type' = 'code' AND block->'imageIds' ? i.id::text))`;
  if (!image) throw new HttpError(404, "ไม่พบภาพนี้");
  return imageResponse(await storedFilePath(image.storageName));
}

const publicLessonPageRoutes = new Elysia({ prefix: "/api/public/lesson-pages" })
  .get("/:id", ({ params, set }) => {
    set.headers["cache-control"] = "no-store";
    return readPublishedPage(params.id, sql`l.legacy_public`);
  }, { params: t.Object({ id: uuid }) })
  .get("/:id/images/:imageId/content", ({ params }) => readPublishedImage(params.id, params.imageId, sql`l.legacy_public`),
    { params: t.Object({ id: uuid, imageId: uuid }) });

const studentLessonPageRoutes = new Elysia({ prefix: "/api/student" })
  .get("/lesson-pages", async ({ request, set }) => {
    set.headers["cache-control"] = "no-store";
    const account = (await requireStudent(request)).id;
    return sql`SELECT l.id, l.published_title AS title, c.id AS "classroomId", c.name AS "classroomName"
      FROM classroom.classroom_lessons a JOIN classroom.lesson_pages l ON l.id = a.lesson_id
      JOIN classroom.classrooms c ON c.id = a.classroom_id AND c.archived_at IS NULL
      JOIN classroom.students s ON s.classroom_id = c.id AND s.archived_at IS NULL
      WHERE s.account_id = ${account} AND l.trashed_at IS NULL AND l.published_blocks IS NOT NULL
      ORDER BY l.published_at DESC, c.name, l.id, c.id`;
  })
  .get("/classrooms/:classroomId/lesson-pages/:id", async ({ params, request, set }) => {
    set.headers["cache-control"] = "no-store";
    const account = (await requireStudent(request)).id;
    const page = await readPublishedPage(params.id, activeLessonMembership(params.classroomId, account));
    const worksheets = await sql`SELECT id, title FROM classroom.worksheet_rounds
      WHERE classroom_id = ${params.classroomId} AND lesson_id = ${params.id} AND status IN ('open', 'closed')
      ORDER BY created_at, id`;
    const [wioLab] = await sql`
      SELECT a.id AS "assignmentId", a.title, a.instructions, a.max_score AS "maxScore", a.wio_lab AS preset
      FROM classroom.classroom_lessons cl
      JOIN classroom.assignments a ON a.id = cl.wio_assignment_id AND a.classroom_id = cl.classroom_id
      WHERE cl.classroom_id = ${params.classroomId} AND cl.lesson_id = ${params.id}
        AND a.archived_at IS NULL AND a.wio_lab IS NOT NULL`;
    return { ...page, worksheets, wioLab: wioLab ?? null };
  }, { params: classLessonParams })
  .get("/classrooms/:classroomId/lesson-pages/:id/images/:imageId/content", async ({ params, request }) =>
    readPublishedImage(params.id, params.imageId, activeLessonMembership(params.classroomId, (await requireStudent(request)).id)),
  { params: t.Object({ classroomId: uuid, id: uuid, imageId: uuid }) });

export const lessonPageApiRoutes = new Elysia().use(lessonPageRoutes).use(publicLessonPageRoutes).use(studentLessonPageRoutes);

function normalizeBlocks(mode: "blocks" | "code", contents: LessonBlock[]): StoredBlock[] {
  if (mode === "blocks") {
    if (contents.some((item) => item.type === "code")) throw new HttpError(422, "รูปแบบเนื้อหาไม่ตรงกับบทเรียน");
    return contents as StoredBlock[];
  }
  if (contents.length !== 1 || contents[0].type !== "code") throw new HttpError(422, "บทเรียนโค้ดต้องมีแหล่งเนื้อหาเพียงชุดเดียว");
  const code = contents[0];
  if (Buffer.byteLength(code.html + code.css + code.javascript, "utf8") > 1048576) throw new HttpError(413, "โค้ดรวมต้องมีขนาดไม่เกิน 1 MiB");
  const sources = [code.html, code.css, code.javascript];
  if (sources.some((source) => source.replace(lessonImagePattern, "").includes("lesson-image://"))) throw new HttpError(422, "รูปอ้างอิงต้องใช้รหัสภาพที่ถูกต้อง");
  const imageIds = [...new Set(sources.flatMap((source) => [...source.matchAll(lessonImagePattern)].map((match) => match[1].toLowerCase())))];
  if (imageIds.length > 50) throw new HttpError(422, "บทเรียนหนึ่งรายการใช้ภาพอัปโหลดได้ไม่เกิน 50 ภาพ");
  return [{ type: "code", html: code.html, css: code.css, javascript: code.javascript, framework: code.framework ?? "none", imageIds }];
}

function normalizeQuizLinks(value: { quizId: string; label: string }[]) {
  const seen = new Set<string>();
  return value.map(({ quizId, label }) => {
    const id = quizId.toLowerCase(); const text = cleanText(label, 100);
    if (seen.has(id) || !text) throw new HttpError(422, "ปุ่มแบบทดสอบซ้ำหรือไม่มีชื่อ");
    seen.add(id);
    return { quizId: id, label: text };
  });
}

async function validateQuizLinks(ownerId: string, links: { quizId: string; label: string }[], tx: postgres.ISql) {
  if (!links.length) return;
  const found = await tx`SELECT id FROM classroom.quizzes WHERE owner_id = ${ownerId} AND id = ANY(${links.map((link) => link.quizId)}::uuid[])`;
  if (found.length !== links.length) throw new HttpError(422, "มีแบบทดสอบที่ไม่ได้เป็นของบัญชีนี้");
}

async function validateImageReferences(id: string, ownerId: string, contents: StoredBlock[], tx: postgres.ISql = sql) {
  const ids = [...new Set(contents.flatMap((item) => item.type === "image" ? [item.imageId] : item.type === "code" ? item.imageIds : []))];
  if (!ids.length) return;
  const images = await tx`SELECT i.id FROM classroom.lesson_page_images i
    JOIN classroom.lesson_pages l ON l.id = i.lesson_id
    WHERE l.id = ${id} AND l.owner_id = ${ownerId} AND i.id = ANY(${ids}::uuid[])`;
  if (images.length !== ids.length) throw new HttpError(422, "ภาพในบทเรียนไม่ถูกต้อง");
}

async function conflictOrMissing(id: string, ownerId: string) {
  await ownedPage(id, ownerId);
  throw new HttpError(409, "มีการแก้ไขบทเรียนจากอีกหน้าต่าง กรุณาโหลดบทเรียนใหม่ก่อนบันทึก");
}

function imageResponse(path: string) {
  return new Response(Bun.file(path), { headers: {
    "content-type": "image/webp", "cache-control": "no-store", "x-content-type-options": "nosniff",
  } });
}
