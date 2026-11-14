import { Elysia, t } from "elysia";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type postgres from "postgres";
import sharp from "sharp";
import { requireActor } from "../auth/session";
import { sql } from "../db/client";
import { HttpError } from "../http-error";
import { checkRequestOrigin, cleanText } from "../security";
import { cleanupUnusedLessonImages, maxStoredBytes, maxUploadBytes, uploadRoot, storedFilePath } from "../file-storage";

const block = t.Union([
  t.Object({ type: t.Literal("text"), heading: t.Optional(t.String({ maxLength: 120 })), text: t.String({ maxLength: 10000 }) }),
  t.Object({ type: t.Literal("image"), imageId: t.String({ format: "uuid" }), alt: t.String({ maxLength: 300 }), caption: t.Optional(t.String({ maxLength: 500 })) }),
  t.Object({ type: t.Literal("youtube"), videoId: t.String({ pattern: "^[A-Za-z0-9_-]{11}$" }), caption: t.Optional(t.String({ maxLength: 500 })) }),
  t.Object({ type: t.Literal("code"), html: t.String({ maxLength: 1048576 }), css: t.String({ maxLength: 1048576 }), javascript: t.String({ maxLength: 1048576 }), framework: t.Optional(t.Union([t.Literal("none"), t.Literal("bootstrap")])), imageIds: t.Optional(t.Array(t.String({ format: "uuid" }), { maxItems: 50 })) }),
]);
const blocks = t.Array(block, { maxItems: 100 });
const revisionBody = t.Object({ expectedRevision: t.Integer({ minimum: 0 }) });
const quizLinksSchema = t.Array(t.Object({ quizId: t.String({ format: "uuid" }), label: t.String({ minLength: 1, maxLength: 100 }) }), { maxItems: 20 });
const lessonBody = t.Object({ title: t.String({ minLength: 1, maxLength: 120 }), blocks, quizLinks: t.Optional(quizLinksSchema), expectedRevision: t.Integer({ minimum: 0 }) });
type LessonBlock = { type: "text"; heading?: string; text: string } | { type: "image"; imageId: string; alt: string; caption?: string } | { type: "youtube"; videoId: string; caption?: string } | { type: "code"; html: string; css: string; javascript: string; framework?: "none" | "bootstrap"; imageIds?: string[] };
type StoredBlock = Exclude<LessonBlock, { type: "code" }> | Extract<LessonBlock, { type: "code" }> & { imageIds: string[] };
const lessonImagePattern = /lesson-image:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/gi;

function cleanupLater() {
  void cleanupUnusedLessonImages().catch((error) => console.error("Lesson image cleanup deferred", error instanceof Error ? error.name : "unknown error"));
}

async function ownedPage(id: string, ownerId: string) {
  const [page] = await sql`SELECT id FROM classroom.lesson_pages WHERE id = ${id} AND owner_id = ${ownerId}`;
  if (!page) throw new HttpError(404, "ไม่พบบทเรียนนี้");
}

async function usedStorageBytes(tx: postgres.ISql) {
  const [usage] = await tx<{ used: string }[]>`
    SELECT (
      (SELECT COALESCE(SUM(size_bytes + COALESCE(thumbnail_size_bytes, 0)), 0) FROM classroom.files) +
      (SELECT COALESCE(SUM(size_bytes), 0) FROM classroom.lesson_page_images) +
      (SELECT COALESCE(SUM(size_bytes), 0) FROM classroom.quiz_images)
    )::text AS used
  `;
  return Number(usage.used);
}

export const lessonPageRoutes = new Elysia({ prefix: "/api" })
  .get("/lesson-pages", async ({ request }) => {
    const actor = await requireActor(request);
    return sql`SELECT id, title, editor_mode AS "editorMode", draft_revision AS "draftRevision", published_at AS "publishedAt", updated_at AS "updatedAt"
      FROM classroom.lesson_pages WHERE owner_id = ${actor.id} ORDER BY updated_at DESC`;
  })
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
      draft_quiz_links AS "quizLinks"
      FROM classroom.lesson_pages WHERE id = ${params.id} AND owner_id = ${actor.id}`;
    if (!page) throw new HttpError(404, "ไม่พบบทเรียนนี้");
    return page;
  })
  .put("/lesson-pages/:id/draft", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const [page] = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(870010022)`;
      const [current] = await tx<{ editorMode: "blocks" | "code"; quizLinks: { quizId: string; label: string }[] }[]>`SELECT editor_mode AS "editorMode", draft_quiz_links AS "quizLinks" FROM classroom.lesson_pages
        WHERE id = ${params.id} AND owner_id = ${actor.id} AND draft_revision = ${body.expectedRevision} FOR UPDATE`;
      if (!current) return [];
      const content = normalizeBlocks(current.editorMode, body.blocks);
      await validateImageReferences(params.id, actor.id, content, tx);
      const quizLinks = body.quizLinks ? normalizeQuizLinks(body.quizLinks) : current.quizLinks;
      await validateQuizLinks(actor.id, quizLinks, tx);
      return tx`UPDATE classroom.lesson_pages
        SET title = ${cleanText(body.title, 120)}, draft_blocks = ${sql.json(content)}, draft_quiz_links = ${sql.json(quizLinks)},
          draft_revision = draft_revision + 1, updated_at = NOW()
        WHERE id = ${params.id} AND owner_id = ${actor.id} AND draft_revision = ${body.expectedRevision}
        RETURNING id, title, editor_mode AS "editorMode", draft_blocks AS blocks, draft_revision AS revision,
          published_title AS "publishedTitle",
          published_at AS "publishedAt", published_revision AS "publishedRevision", draft_quiz_links AS "quizLinks"`;
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
      const [current] = await tx<{ editorMode: "blocks" | "code"; quizLinks: { quizId: string; label: string }[] }[]>`SELECT editor_mode AS "editorMode", draft_quiz_links AS "quizLinks" FROM classroom.lesson_pages
        WHERE id = ${params.id} AND owner_id = ${actor.id} AND draft_revision = ${body.expectedRevision} FOR UPDATE`;
      if (!current) return [];
      const content = normalizeBlocks(current.editorMode, body.blocks);
      await validateImageReferences(params.id, actor.id, content, tx);
      const quizLinks = body.quizLinks ? normalizeQuizLinks(body.quizLinks) : current.quizLinks;
      await validateQuizLinks(actor.id, quizLinks, tx);
      return tx`UPDATE classroom.lesson_pages SET title = ${cleanText(body.title, 120)},
        draft_blocks = ${sql.json(content)}, draft_quiz_links = ${sql.json(quizLinks)}, draft_revision = draft_revision + 1,
        published_blocks = ${sql.json(content)}, published_title = ${cleanText(body.title, 120)}, published_revision = draft_revision + 1,
        published_quiz_links = ${sql.json(quizLinks)},
        published_at = NOW(), updated_at = NOW()
        WHERE id = ${params.id} AND owner_id = ${actor.id}
        RETURNING id, title, editor_mode AS "editorMode", draft_blocks AS blocks, draft_revision AS revision,
          published_title AS "publishedTitle",
          published_at AS "publishedAt", published_revision AS "publishedRevision", draft_quiz_links AS "quizLinks"`;
    });
    if (!page) await conflictOrMissing(params.id, actor.id);
    cleanupLater();
    return page;
  }, { body: lessonBody })
  .post("/lesson-pages/:id/unpublish", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const [page] = await sql`UPDATE classroom.lesson_pages SET published_blocks = NULL,
      published_title = NULL, published_revision = NULL, published_quiz_links = NULL, published_at = NULL, updated_at = NOW()
      WHERE id = ${params.id} AND owner_id = ${actor.id} AND draft_revision = ${body.expectedRevision}
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
        const [lesson] = await tx`SELECT id FROM classroom.lesson_pages WHERE id = ${params.id} AND owner_id = ${actor.id} FOR UPDATE`;
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
    const [page] = await sql`SELECT id FROM classroom.lesson_pages WHERE id = ${params.id} AND owner_id = ${actor.id}`;
    if (!page) throw new HttpError(404, "ไม่พบบทเรียนนี้");
    return sql`SELECT id, original_name AS "originalName", size_bytes AS "sizeBytes"
      FROM classroom.lesson_page_images WHERE lesson_id = ${params.id} ORDER BY created_at DESC`;
  })
  .get("/lesson-pages/:id/images/:imageId/content", async ({ params, request }) => {
    const actor = await requireActor(request);
    const [image] = await sql`SELECT i.storage_name AS "storageName" FROM classroom.lesson_page_images i
      JOIN classroom.lesson_pages l ON l.id = i.lesson_id
      WHERE l.id = ${params.id} AND i.id = ${params.imageId} AND l.owner_id = ${actor.id}`;
    if (!image) throw new HttpError(404, "ไม่พบภาพนี้");
    return imageResponse(await storedFilePath(image.storageName));
  });

const publicLessonPageRoutes = new Elysia({ prefix: "/api/public/lesson-pages" })
  .get("/:id", async ({ params, set }) => {
    set.headers["cache-control"] = "no-store";
    const [page] = await sql`SELECT id, published_title AS title, editor_mode AS "editorMode", published_blocks AS blocks,
      published_quiz_links AS "quizLinks", published_at AS "publishedAt"
      FROM classroom.lesson_pages WHERE id = ${params.id} AND published_blocks IS NOT NULL`;
    if (!page) throw new HttpError(404, "ไม่พบบทเรียนที่เผยแพร่แล้ว");
    return page;
  }, { params: t.Object({ id: t.String({ format: "uuid" }) }) })
  .get("/:id/images/:imageId/content", async ({ params }) => {
    const [image] = await sql`SELECT i.storage_name AS "storageName" FROM classroom.lesson_page_images i
      JOIN classroom.lesson_pages l ON l.id = i.lesson_id
      WHERE l.id = ${params.id} AND i.id = ${params.imageId} AND l.published_blocks IS NOT NULL
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(l.published_blocks) block
          WHERE (block->>'type' = 'image' AND block->>'imageId' = i.id::text)
            OR (block->>'type' = 'code' AND block->'imageIds' ? i.id::text))`;
    if (!image) throw new HttpError(404, "ไม่พบภาพนี้");
    return imageResponse(await storedFilePath(image.storageName));
  }, { params: t.Object({ id: t.String({ format: "uuid" }), imageId: t.String({ format: "uuid" }) }) });

export const lessonPageApiRoutes = new Elysia().use(lessonPageRoutes).use(publicLessonPageRoutes);

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
