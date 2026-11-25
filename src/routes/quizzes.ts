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
import { gradeQuiz, normalizeQuizContent, referencedQuizImages, studentQuizQuestions, validateAnswers, type QuizAnswers, type QuizContent } from "../quiz-core";
import { cleanupUnusedLessonImages, maxStoredBytes, maxUploadBytes, storedFilePath, uploadRoot } from "../file-storage";

const contentBody = t.Object({ title: t.String({ minLength: 1, maxLength: 120 }), content: t.Any(), expectedRevision: t.Integer({ minimum: 0 }) });
const revisionBody = t.Object({ expectedRevision: t.Integer({ minimum: 0 }) });

async function ownedQuiz(id: string, ownerId: string, tx: postgres.ISql = sql) {
  const [quiz] = await tx`SELECT id FROM classroom.quizzes WHERE id = ${id} AND owner_id = ${ownerId} AND trashed_at IS NULL`;
  if (!quiz) throw new HttpError(404, "ไม่พบแบบทดสอบนี้");
}

async function quizTrashFailure(id: string, ownerId: string): Promise<never> {
  const [quiz] = await sql`SELECT id FROM classroom.quizzes WHERE id = ${id} AND owner_id = ${ownerId}`;
  if (!quiz) throw new HttpError(404, "ไม่พบแบบทดสอบในถังขยะนี้");
  throw new HttpError(409, "แบบทดสอบถูกเปลี่ยนจากอีกหน้าต่าง กรุณาโหลดรายการใหม่");
}

async function validateImages(quizId: string, ownerId: string, content: QuizContent, tx: postgres.ISql) {
  const ids = referencedQuizImages(content);
  if (!ids.length) return;
  const rows = await tx`SELECT i.id FROM classroom.quiz_images i JOIN classroom.quizzes q ON q.id = i.quiz_id
    WHERE i.quiz_id = ${quizId} AND i.id = ANY(${ids}::uuid[]) AND q.owner_id = ${ownerId}`;
  if (rows.length !== ids.length) throw new HttpError(422, "มีภาพที่ไม่ได้อยู่ในแบบทดสอบนี้");
}

async function usedBytes(tx: postgres.ISql) {
  const [row] = await tx<{ used: string }[]>`SELECT (
    (SELECT COALESCE(SUM(size_bytes + COALESCE(material_size_bytes, 0) + COALESCE(thumbnail_size_bytes, 0)), 0) FROM classroom.files) +
    (SELECT COALESCE(SUM(size_bytes), 0) FROM classroom.lesson_page_images) +
    (SELECT COALESCE(SUM(size_bytes), 0) FROM classroom.quiz_images))::text AS used`;
  return Number(row.used);
}

async function classOwned(classroomId: string, ownerId: string, tx: postgres.ISql = sql) {
  const [room] = await tx`SELECT id FROM classroom.classrooms WHERE id = ${classroomId} AND owner_id = ${ownerId} AND archived_at IS NULL`;
  if (!room) throw new HttpError(404, "ไม่พบห้องเรียนนี้");
}

async function finalizeExpired(tx: postgres.ISql, roundId: string) {
  const [round] = await tx<{ status: string; content: QuizContent }[]>`
    SELECT r.status, r.content_snapshot AS content FROM classroom.classroom_quizzes r
      JOIN classroom.quizzes q ON q.id = r.quiz_id AND q.trashed_at IS NULL WHERE r.id = ${roundId} FOR UPDATE OF r`;
  if (!round || round.status !== "open") return;
  const expired = await tx<{ id: string; answers: QuizAnswers }[]>`
    SELECT id, answers FROM classroom.quiz_attempts WHERE classroom_quiz_id = ${roundId}
      AND finished_at IS NULL AND expires_at <= NOW() FOR UPDATE`;
  for (const attempt of expired) {
    const score = gradeQuiz(round.content, attempt.answers).score;
    await tx`UPDATE classroom.quiz_attempts SET score = ${score}, finished_at = NOW(), finish_reason = 'expired'
      WHERE id = ${attempt.id} AND finished_at IS NULL`;
  }
}

async function finishRound(tx: postgres.ISql, roundId: string) {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"quiz-round:" + roundId}, 0))`;
  const [round] = await tx<{ status: string; content: QuizContent }[]>`
    SELECT r.status, r.content_snapshot AS content FROM classroom.classroom_quizzes r
      JOIN classroom.quizzes q ON q.id = r.quiz_id AND q.trashed_at IS NULL WHERE r.id = ${roundId} FOR UPDATE OF r`;
  if (!round) throw new HttpError(404, "ไม่พบรอบแบบทดสอบนี้");
  if (round.status === "closed") return;
  if (round.status !== "open") throw new HttpError(409, "เปิดรอบแบบทดสอบก่อนปิดรอบ");
  const attempts = await tx<{ id: string; answers: QuizAnswers }[]>`
    SELECT id, answers FROM classroom.quiz_attempts WHERE classroom_quiz_id = ${roundId}
      AND finished_at IS NULL FOR UPDATE`;
  for (const attempt of attempts) {
    const score = gradeQuiz(round.content, attempt.answers).score;
    await tx`UPDATE classroom.quiz_attempts SET score = ${score}, finished_at = NOW(), finish_reason = 'closed'
      WHERE id = ${attempt.id} AND finished_at IS NULL`;
  }
  await tx`UPDATE classroom.classroom_quizzes SET status = 'closed', closed_at = NOW() WHERE id = ${roundId}`;
}

export const quizRoutes = new Elysia({ prefix: "/api" })
  .get("/quizzes", async ({ request }) => {
    const actor = await requireActor(request);
    const trashed = new URL(request.url).searchParams.get("trashed") === "true";
    return sql`SELECT q.id, q.title, q.draft_revision AS "draftRevision", q.published_title AS "publishedTitle",
      q.published_at AS "publishedAt", q.updated_at AS "updatedAt",
      (SELECT COUNT(*)::int FROM classroom.classroom_quizzes r WHERE r.quiz_id = q.id) AS "roundCount",
      (SELECT COUNT(*)::int FROM classroom.quiz_attempts a JOIN classroom.classroom_quizzes r ON r.id = a.classroom_quiz_id WHERE r.quiz_id = q.id) AS "attemptCount"
      FROM classroom.quizzes q WHERE q.owner_id = ${actor.id} AND (q.trashed_at IS NOT NULL) = ${trashed} ORDER BY q.updated_at DESC`;
  })
  .post("/quizzes/:id/trash", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const trashed = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(870010022)`;
      const [quiz] = await tx`SELECT id FROM classroom.quizzes WHERE id = ${params.id} AND owner_id = ${actor.id}
        AND trashed_at IS NULL AND draft_revision = ${body.expectedRevision} FOR UPDATE`;
      if (!quiz) return false;
      const rounds = await tx<{ id: string }[]>`SELECT id FROM classroom.classroom_quizzes WHERE quiz_id = ${params.id} ORDER BY id`;
      for (const round of rounds) await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"quiz-round:" + round.id}, 0))`;
      const openRounds = await tx<{ id: string }[]>`SELECT id FROM classroom.classroom_quizzes WHERE quiz_id = ${params.id} AND status = 'open' ORDER BY id`;
      for (const round of openRounds) await finishRound(tx, round.id);
      await tx`UPDATE classroom.quizzes SET trashed_at = NOW(), draft_revision = draft_revision + 1, updated_at = NOW()
        WHERE id = ${params.id} AND owner_id = ${actor.id} AND trashed_at IS NULL`;
      return true;
    });
    if (!trashed) await quizTrashFailure(params.id, actor.id);
    return { ok: true };
  }, { params: t.Object({ id: t.String({ format: "uuid" }) }), body: revisionBody })
  .post("/quizzes/:id/restore", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const [quiz] = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(870010022)`;
      return tx`UPDATE classroom.quizzes SET trashed_at = NULL, draft_revision = draft_revision + 1, updated_at = NOW()
        WHERE id = ${params.id} AND owner_id = ${actor.id} AND trashed_at IS NOT NULL
          AND draft_revision = ${body.expectedRevision} RETURNING id`;
    });
    if (!quiz) await quizTrashFailure(params.id, actor.id);
    return { ok: true };
  }, { params: t.Object({ id: t.String({ format: "uuid" }) }), body: revisionBody })
  .delete("/quizzes/:id", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const quizId = params.id.toLowerCase();
    const staged: { id: string; path: string; tombstone: string }[] = [];
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(870010022)`;
        const [quiz] = await tx<{ title: string; revision: number }[]>`SELECT title, draft_revision AS revision FROM classroom.quizzes
          WHERE id = ${params.id} AND owner_id = ${actor.id} AND trashed_at IS NOT NULL FOR UPDATE`;
        if (!quiz) throw new HttpError(404, "ไม่พบแบบทดสอบในถังขยะนี้");
        if (quiz.revision !== body.expectedRevision) throw new HttpError(409, "แบบทดสอบถูกเปลี่ยนจากอีกหน้าต่าง กรุณาโหลดรายการใหม่");
        if (body.confirmTitle !== quiz.title) throw new HttpError(422, "ชื่อแบบทดสอบที่ยืนยันไม่ตรงกัน");
        const rounds = await tx<{ id: string }[]>`SELECT id FROM classroom.classroom_quizzes WHERE quiz_id = ${params.id} ORDER BY id`;
        for (const round of rounds) await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"quiz-round:" + round.id}, 0))`;
        const images = await tx<{ id: string; storageName: string }[]>`SELECT id, storage_name AS "storageName" FROM classroom.quiz_images WHERE quiz_id = ${params.id} FOR UPDATE`;
        for (const image of images) {
          const path = resolve(uploadRoot(), image.storageName); const tombstone = path + ".deleting";
          try { await rename(path, tombstone); staged.push({ id: image.id, path, tombstone }); }
          catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
        }
        const lessons = await tx<{ id: string; draftLinks: { quizId: string; label: string }[]; publishedLinks: { quizId: string; label: string }[] | null }[]>`
          SELECT id, draft_quiz_links AS "draftLinks", published_quiz_links AS "publishedLinks" FROM classroom.lesson_pages
          WHERE owner_id = ${actor.id} FOR UPDATE`;
        for (const lesson of lessons) {
          const draftLinks = lesson.draftLinks.filter((link) => link.quizId !== quizId);
          const publishedLinks = lesson.publishedLinks?.filter((link) => link.quizId !== quizId) ?? null;
          const draftChanged = draftLinks.length !== lesson.draftLinks.length;
          const publishedChanged = (publishedLinks?.length ?? 0) !== (lesson.publishedLinks?.length ?? 0);
          if (!draftChanged && !publishedChanged) continue;
          await tx`UPDATE classroom.lesson_pages SET draft_quiz_links = ${sql.json(draftLinks)},
            draft_revision = draft_revision + 1,
            published_quiz_links = ${publishedLinks === null ? null : sql.json(publishedLinks)},
            published_revision = CASE WHEN ${publishedChanged} AND published_revision IS NOT NULL THEN published_revision + 1 ELSE published_revision END,
            updated_at = NOW() WHERE id = ${lesson.id}`;
        }
        await tx`DELETE FROM classroom.classroom_quizzes WHERE quiz_id = ${params.id}`;
        await tx`DELETE FROM classroom.quizzes WHERE id = ${params.id} AND owner_id = ${actor.id} AND trashed_at IS NOT NULL`;
      });
    } catch (error) {
      for (const image of staged) {
        try {
          const [record] = await sql`SELECT id FROM classroom.quiz_images WHERE id = ${image.id}`;
          if (record) await rename(image.tombstone, image.path).catch(() => {});
          else await rm(image.tombstone, { force: true }).catch(() => {});
        } catch { /* Startup reconciliation resolves uncertain commits. */ }
      }
      throw error;
    }
    let cleanupPending = false;
    for (const image of staged) if (await rm(image.tombstone, { force: true }).then(() => false, () => true)) cleanupPending = true;
    void cleanupUnusedLessonImages().catch(() => {});
    return { ok: true, cleanupPending };
  }, { params: t.Object({ id: t.String({ format: "uuid" }) }), body: t.Object({ expectedRevision: t.Integer({ minimum: 0 }), confirmTitle: t.String({ minLength: 1, maxLength: 120 }) }) })
  .post("/quizzes", async ({ body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const title = cleanText(body.title, 120);
    const [quiz] = await sql`INSERT INTO classroom.quizzes (owner_id, title)
      VALUES (${actor.id}, ${title}) RETURNING id, title, draft_content AS content, draft_revision AS revision,
        published_title AS "publishedTitle", published_at AS "publishedAt"`;
    return quiz;
  }, { body: t.Object({ title: t.String({ minLength: 1, maxLength: 120 }) }) })
  .get("/quizzes/:id", async ({ params, request }) => {
    const actor = await requireActor(request);
    const [quiz] = await sql`SELECT id, title, draft_content AS content, draft_revision AS revision,
      published_title AS "publishedTitle", published_at AS "publishedAt"
      FROM classroom.quizzes WHERE id = ${params.id} AND owner_id = ${actor.id} AND trashed_at IS NULL`;
    if (!quiz) throw new HttpError(404, "ไม่พบแบบทดสอบนี้");
    return quiz;
  }, { params: t.Object({ id: t.String({ format: "uuid" }) }) })
  .put("/quizzes/:id/draft", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const content = normalizeQuizContent(body.content);
    const [quiz] = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(870010022)`;
      const [current] = await tx`SELECT id FROM classroom.quizzes WHERE id = ${params.id} AND owner_id = ${actor.id}
        AND trashed_at IS NULL AND draft_revision = ${body.expectedRevision} FOR UPDATE`;
      if (!current) return [];
      await validateImages(params.id, actor.id, content, tx);
      return tx`UPDATE classroom.quizzes SET title = ${cleanText(body.title, 120)}, draft_content = ${sql.json(content)},
        draft_revision = draft_revision + 1, updated_at = NOW()
        WHERE id = ${params.id} AND owner_id = ${actor.id}
        RETURNING id, title, draft_content AS content, draft_revision AS revision,
          published_title AS "publishedTitle", published_at AS "publishedAt"`;
    });
    if (!quiz) { await ownedQuiz(params.id, actor.id); throw new HttpError(409, "แบบทดสอบถูกแก้ไขอีกหน้าต่าง กรุณาโหลดใหม่"); }
    void cleanupUnusedLessonImages().catch(() => {});
    return quiz;
  }, { params: t.Object({ id: t.String({ format: "uuid" }) }), body: contentBody })
  .post("/quizzes/:id/publish", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const content = normalizeQuizContent(body.content, true);
    const title = cleanText(body.title, 120);
    const [quiz] = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(870010022)`;
      const [current] = await tx`SELECT id FROM classroom.quizzes WHERE id = ${params.id} AND owner_id = ${actor.id}
        AND trashed_at IS NULL AND draft_revision = ${body.expectedRevision} FOR UPDATE`;
      if (!current) return [];
      await validateImages(params.id, actor.id, content, tx);
      return tx`UPDATE classroom.quizzes SET title = ${title}, draft_content = ${sql.json(content)},
        draft_revision = draft_revision + 1, published_title = ${title}, published_content = ${sql.json(content)},
        published_revision = draft_revision + 1, published_at = NOW(), updated_at = NOW()
        WHERE id = ${params.id} AND owner_id = ${actor.id}
        RETURNING id, title, draft_content AS content, draft_revision AS revision,
          published_title AS "publishedTitle", published_at AS "publishedAt"`;
    });
    if (!quiz) { await ownedQuiz(params.id, actor.id); throw new HttpError(409, "แบบทดสอบถูกแก้ไขอีกหน้าต่าง กรุณาโหลดใหม่"); }
    void cleanupUnusedLessonImages().catch(() => {});
    return quiz;
  }, { params: t.Object({ id: t.String({ format: "uuid" }) }), body: contentBody })
  .post("/quizzes/:id/unpublish", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const [quiz] = await sql`UPDATE classroom.quizzes SET published_title = NULL, published_content = NULL,
      published_revision = NULL, published_at = NULL, updated_at = NOW()
      WHERE id = ${params.id} AND owner_id = ${actor.id} AND trashed_at IS NULL AND draft_revision = ${body.expectedRevision} RETURNING id`;
    if (!quiz) { await ownedQuiz(params.id, actor.id); throw new HttpError(409, "แบบทดสอบถูกแก้ไขอีกหน้าต่าง กรุณาโหลดใหม่"); }
    void cleanupUnusedLessonImages().catch(() => {});
    return { ok: true };
  }, { params: t.Object({ id: t.String({ format: "uuid" }) }), body: revisionBody })
  .post("/quizzes/:id/images", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedQuiz(params.id, actor.id);
    if (!body.file.size || body.file.size > maxUploadBytes()) throw new HttpError(413, "ไฟล์ภาพมีขนาดเกินกำหนด");
    let bytes: Buffer;
    try {
      const input = Buffer.from(await body.file.arrayBuffer());
      const image = sharp(input, { failOn: "error", limitInputPixels: 40_000_000 });
      const meta = await image.metadata();
      if (!meta.width || !meta.height || meta.pages && meta.pages > 1 || !["jpeg", "png", "webp"].includes(meta.format ?? "")) throw new Error("invalid image");
      bytes = await sharp(input, { failOn: "error", limitInputPixels: 40_000_000 })
        .rotate().resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    } catch { throw new HttpError(422, "รองรับภาพ PNG, JPEG หรือ WebP ที่เปิดได้เท่านั้น"); }
    if (bytes.byteLength > maxUploadBytes()) throw new HttpError(413, "ภาพหลังปรับขนาดมีขนาดเกินกำหนด");
    const originalName = basename(body.file.name).replace(/[\\/\0-\x1f\x7f]/g, "_").trim().slice(-255) || "image";
    const id = randomUUID(); const storageName = id; const root = uploadRoot();
    await mkdir(root, { recursive: true, mode: 0o750 });
    const temporary = resolve(root, id + ".upload"); const destination = resolve(root, id); let renamed = false;
    try {
      await Bun.write(temporary, bytes);
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(870010022)`;
        await ownedQuiz(params.id, actor.id, tx);
        if (await usedBytes(tx) + bytes.byteLength > maxStoredBytes()) throw new HttpError(413, "พื้นที่จัดเก็บไฟล์เต็มแล้ว");
        await rename(temporary, destination); renamed = true;
        await tx`INSERT INTO classroom.quiz_images (id, quiz_id, original_name, storage_name, size_bytes)
          VALUES (${id}, ${params.id}, ${originalName}, ${storageName}, ${bytes.byteLength})`;
      });
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      if (renamed) { try { const [row] = await sql`SELECT id FROM classroom.quiz_images WHERE id = ${id}`; if (!row) await rm(destination, { force: true }); } catch { /* Startup reconciliation handles uncertain commits. */ } }
      throw error;
    }
    void cleanupUnusedLessonImages().catch(() => {});
    return { id, originalName, mediaType: "image/webp" };
  }, { params: t.Object({ id: t.String({ format: "uuid" }) }), body: t.Object({ file: t.File() }) })
  .get("/quizzes/:id/images", async ({ params, request }) => {
    const actor = await requireActor(request);
    await ownedQuiz(params.id, actor.id);
    return sql`SELECT id, original_name AS "originalName", size_bytes AS "sizeBytes" FROM classroom.quiz_images
      WHERE quiz_id = ${params.id} ORDER BY created_at DESC`;
  }, { params: t.Object({ id: t.String({ format: "uuid" }) }) })
  .get("/quizzes/:id/images/:imageId/content", async ({ params, request }) => {
    const actor = await requireActor(request);
    const [image] = await sql`SELECT i.storage_name AS "storageName" FROM classroom.quiz_images i
      JOIN classroom.quizzes q ON q.id = i.quiz_id
      WHERE q.id = ${params.id} AND i.id = ${params.imageId} AND q.owner_id = ${actor.id} AND q.trashed_at IS NULL`;
    if (!image) throw new HttpError(404, "ไม่พบภาพนี้");
    const path = await storedFilePath(image.storageName);
    return new Response(Bun.file(path), { headers: { "content-type": "image/webp", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  }, { params: t.Object({ id: t.String({ format: "uuid" }), imageId: t.String({ format: "uuid" }) }) })
  .get("/classrooms/:classroomId/quizzes", async ({ params, request }) => {
    const actor = await requireActor(request);
    await classOwned(params.classroomId, actor.id);
    return sql`SELECT r.id, r.quiz_id AS "quizId", r.title, r.status, r.duration_minutes AS "durationMinutes",
      r.opened_at AS "openedAt", r.closed_at AS "closedAt", r.solutions_released_at AS "solutionsReleasedAt",
      r.created_at AS "createdAt", (SELECT COUNT(*)::int FROM classroom.quiz_attempts a WHERE a.classroom_quiz_id = r.id) AS "startedCount",
      (SELECT COUNT(*)::int FROM classroom.quiz_attempts a WHERE a.classroom_quiz_id = r.id AND a.finished_at IS NOT NULL) AS "finishedCount"
      FROM classroom.classroom_quizzes r JOIN classroom.quizzes q ON q.id = r.quiz_id AND q.trashed_at IS NULL
      WHERE r.classroom_id = ${params.classroomId} ORDER BY r.created_at DESC`;
  }, { params: t.Object({ classroomId: t.String({ format: "uuid" }) }) })
  .post("/classrooms/:classroomId/quizzes", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await classOwned(params.classroomId, actor.id);
    const [round] = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(870010022)`;
      const [quiz] = await tx`SELECT published_title AS title, published_content AS content FROM classroom.quizzes
        WHERE id = ${body.quizId} AND owner_id = ${actor.id} AND trashed_at IS NULL AND published_content IS NOT NULL FOR SHARE`;
      if (!quiz) throw new HttpError(422, "เผยแพร่แบบทดสอบก่อนนำไปใช้กับห้องเรียน");
      return tx`INSERT INTO classroom.classroom_quizzes
        (classroom_id, owner_id, quiz_id, title, content_snapshot, duration_minutes)
        VALUES (${params.classroomId}, ${actor.id}, ${body.quizId}, ${quiz.title}, ${sql.json(quiz.content)}, ${body.durationMinutes ?? null})
        RETURNING id, quiz_id AS "quizId", title, status, duration_minutes AS "durationMinutes", created_at AS "createdAt"`;
    });
    return round;
  }, { params: t.Object({ classroomId: t.String({ format: "uuid" }) }), body: t.Object({ quizId: t.String({ format: "uuid" }), durationMinutes: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 240 }))) }) })
  .post("/classrooms/:classroomId/quizzes/:roundId/open", async ({ params, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await classOwned(params.classroomId, actor.id);
    const [round] = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"quiz-round:" + params.roundId}, 0))`;
      return tx`UPDATE classroom.classroom_quizzes r SET status = 'open', opened_at = NOW()
        WHERE r.id = ${params.roundId} AND r.classroom_id = ${params.classroomId} AND r.owner_id = ${actor.id} AND r.status = 'awaiting_open'
          AND EXISTS (SELECT 1 FROM classroom.quizzes q WHERE q.id = r.quiz_id AND q.trashed_at IS NULL)
        RETURNING id`;
    });
    if (!round) throw new HttpError(409, "รอบนี้เปิดแล้วหรือปิดไปแล้ว");
    return { ok: true };
  }, { params: t.Object({ classroomId: t.String({ format: "uuid" }), roundId: t.String({ format: "uuid" }) }) })
  .post("/classrooms/:classroomId/quizzes/:roundId/close", async ({ params, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await classOwned(params.classroomId, actor.id);
    const [round] = await sql`SELECT r.id FROM classroom.classroom_quizzes r JOIN classroom.quizzes q ON q.id = r.quiz_id
      WHERE r.id = ${params.roundId} AND r.classroom_id = ${params.classroomId} AND r.owner_id = ${actor.id} AND q.trashed_at IS NULL`;
    if (!round) throw new HttpError(404, "ไม่พบรอบแบบทดสอบนี้");
    await sql.begin((tx) => finishRound(tx, params.roundId));
    return { ok: true };
  }, { params: t.Object({ classroomId: t.String({ format: "uuid" }), roundId: t.String({ format: "uuid" }) }) })
  .post("/classrooms/:classroomId/quizzes/:roundId/release-solutions", async ({ params, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await classOwned(params.classroomId, actor.id);
    const [round] = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"quiz-round:" + params.roundId}, 0))`;
      return tx`UPDATE classroom.classroom_quizzes r SET solutions_released_at = COALESCE(solutions_released_at, NOW())
        WHERE r.id = ${params.roundId} AND r.classroom_id = ${params.classroomId} AND r.owner_id = ${actor.id} AND r.status = 'closed'
          AND EXISTS (SELECT 1 FROM classroom.quizzes q WHERE q.id = r.quiz_id AND q.trashed_at IS NULL) RETURNING id`;
    });
    if (!round) throw new HttpError(409, "ปิดรอบแบบทดสอบก่อนเผยแพร่เฉลย");
    return { ok: true };
  }, { params: t.Object({ classroomId: t.String({ format: "uuid" }), roundId: t.String({ format: "uuid" }) }) })
  .get("/classrooms/:classroomId/quizzes/:roundId/results", async ({ params, request }) => {
    const actor = await requireActor(request);
    await classOwned(params.classroomId, actor.id);
    const result = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"quiz-round:" + params.roundId}, 0))`;
      const [owned] = await tx<{ id: string }[]>`SELECT r.id FROM classroom.classroom_quizzes r JOIN classroom.quizzes q ON q.id = r.quiz_id
        WHERE r.id = ${params.roundId} AND r.classroom_id = ${params.classroomId} AND r.owner_id = ${actor.id} AND q.trashed_at IS NULL`;
      if (!owned) return null;
      await finalizeExpired(tx, params.roundId);
      const [round] = await tx`SELECT r.id, r.quiz_id AS "quizId", r.title, r.content_snapshot AS content, r.status,
        duration_minutes AS "durationMinutes", opened_at AS "openedAt", closed_at AS "closedAt",
        solutions_released_at AS "solutionsReleasedAt" FROM classroom.classroom_quizzes r WHERE r.id = ${params.roundId}`;
      const attempts = await tx`SELECT a.id, a.student_id AS "studentId", s.student_number AS "studentNumber",
        s.display_name AS "displayName", a.answers, a.revision, a.started_at AS "startedAt", a.expires_at AS "expiresAt",
        a.finished_at AS "finishedAt", a.finish_reason AS "finishReason", a.score::text AS score
        FROM classroom.students s LEFT JOIN classroom.quiz_attempts a
          ON a.student_id = s.id AND a.classroom_id = s.classroom_id AND a.classroom_quiz_id = ${params.roundId}
        WHERE s.classroom_id = ${params.classroomId}
        ORDER BY s.archived_at NULLS FIRST, s.student_number NULLS LAST, s.display_name, s.id`;
      return { round, attempts };
    });
    if (!result) throw new HttpError(404, "ไม่พบรอบแบบทดสอบนี้");
    return result;
  }, { params: t.Object({ classroomId: t.String({ format: "uuid" }), roundId: t.String({ format: "uuid" }) }) });

export const studentQuizRoutes = new Elysia({ prefix: "/api/student" })
  .get("/quizzes", async ({ request }) => {
    const actor = await requireStudent(request);
    return studentRoundList(actor.id);
  })
  .get("/quizzes/:quizId", async ({ params, request }) => {
    const actor = await requireStudent(request);
    return studentRoundList(actor.id, params.quizId);
  }, { params: t.Object({ quizId: t.String({ format: "uuid" }) }) })
  .post("/quiz-rounds/:roundId/start", async ({ params, request }) => {
    checkRequestOrigin(request);
    const actor = await requireStudent(request);
    const attemptId = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"quiz-round:" + params.roundId}, 0))`;
      const [round] = await tx<{ id: string; classroomId: string; status: string; durationMinutes: number | null }[]>`
        SELECT r.id, r.classroom_id AS "classroomId", r.status, r.duration_minutes AS "durationMinutes"
        FROM classroom.classroom_quizzes r JOIN classroom.quizzes q ON q.id = r.quiz_id AND q.trashed_at IS NULL
        WHERE r.id = ${params.roundId} FOR UPDATE OF r`;
      if (!round) throw new HttpError(404, "ไม่พบรอบแบบทดสอบนี้");
      const [membership] = await tx<{ id: string }[]>`SELECT s.id FROM classroom.students s JOIN classroom.classrooms c ON c.id = s.classroom_id
        WHERE s.account_id = ${actor.id} AND s.classroom_id = ${round.classroomId} AND s.archived_at IS NULL AND c.archived_at IS NULL FOR SHARE OF s, c`;
      if (!membership) throw new HttpError(404, "ไม่พบรอบแบบทดสอบนี้");
      await finalizeExpired(tx, round.id);
      const [existing] = await tx<{ id: string }[]>`SELECT id FROM classroom.quiz_attempts WHERE classroom_quiz_id = ${round.id} AND student_id = ${membership.id}`;
      if (existing) return existing.id;
      if (round.status !== "open") throw new HttpError(409, "แบบทดสอบยังไม่เปิดหรือปิดไปแล้ว");
      const [attempt] = await tx`INSERT INTO classroom.quiz_attempts (classroom_quiz_id, classroom_id, student_id, expires_at)
        VALUES (${round.id}, ${round.classroomId}, ${membership.id},
          CASE WHEN ${round.durationMinutes}::int IS NULL THEN NULL ELSE NOW() + ${round.durationMinutes ?? 0} * INTERVAL '1 minute' END)
        RETURNING id`;
      return attempt.id;
    });
    return getStudentAttempt(attemptId, actor.id);
  }, { params: t.Object({ roundId: t.String({ format: "uuid" }) }) })
  .get("/quiz-attempts/:attemptId", async ({ params, request }) => {
    const actor = await requireStudent(request);
    return getStudentAttempt(params.attemptId, actor.id);
  }, { params: t.Object({ attemptId: t.String({ format: "uuid" }) }) })
  .put("/quiz-attempts/:attemptId/answers", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireStudent(request);
    const result = await sql.begin(async (tx) => {
      const attempt = await lockStudentAttempt(tx, params.attemptId, actor.id);
      if (attempt.finishedAt) throw new HttpError(409, "หมดเวลาหรือส่งแบบทดสอบแล้ว");
      if (attempt.status !== "open") throw new HttpError(409, "แบบทดสอบปิดแล้ว");
      if (attempt.revision !== body.expectedRevision) throw new HttpError(409, "คำตอบเปลี่ยนจากอีกหน้าต่าง กรุณาโหลดใหม่");
      const answers = validateAnswers(attempt.content, body.answers);
      const [saved] = await tx`UPDATE classroom.quiz_attempts SET answers = ${sql.json(answers)}, revision = revision + 1
        WHERE id = ${attempt.id} AND revision = ${body.expectedRevision} AND finished_at IS NULL RETURNING revision`;
      if (!saved) throw new HttpError(409, "หมดเวลาหรือส่งแบบทดสอบแล้ว");
      return { revision: saved.revision };
    });
    return result;
  }, { params: t.Object({ attemptId: t.String({ format: "uuid" }) }), body: t.Object({ expectedRevision: t.Integer({ minimum: 0 }), answers: t.Record(t.String({ format: "uuid" }), t.Nullable(t.String({ format: "uuid" }))) }) })
  .post("/quiz-attempts/:attemptId/submit", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireStudent(request);
    await sql.begin(async (tx) => {
      const attempt = await lockStudentAttempt(tx, params.attemptId, actor.id);
      if (attempt.finishedAt) return;
      if (attempt.status !== "open") throw new HttpError(409, "แบบทดสอบปิดแล้ว");
      if (attempt.revision !== body.expectedRevision) throw new HttpError(409, "คำตอบเปลี่ยนจากอีกหน้าต่าง กรุณาโหลดใหม่");
      const answers = validateAnswers(attempt.content, body.answers);
      const score = gradeQuiz(attempt.content, answers).score;
      const [submitted] = await tx`UPDATE classroom.quiz_attempts SET answers = ${sql.json(answers)}, revision = revision + 1,
        score = ${score}, finished_at = NOW(), finish_reason = 'submitted' WHERE id = ${attempt.id}
          AND finished_at IS NULL AND revision = ${body.expectedRevision} RETURNING id`;
      if (!submitted) throw new HttpError(409, "หมดเวลาหรือคำตอบถูกส่งไปแล้ว");
    });
    return getStudentAttempt(params.attemptId, actor.id);
  }, { params: t.Object({ attemptId: t.String({ format: "uuid" }) }), body: t.Object({ expectedRevision: t.Integer({ minimum: 0 }), answers: t.Record(t.String({ format: "uuid" }), t.Nullable(t.String({ format: "uuid" }))) }) })
  .get("/quiz-attempts/:attemptId/images/:imageId", async ({ params, request }) => {
    const actor = await requireStudent(request);
    const [image] = await sql`SELECT i.storage_name AS "storageName" FROM classroom.quiz_attempts a
      JOIN classroom.students s ON s.id = a.student_id AND s.classroom_id = a.classroom_id
      JOIN classroom.classrooms c ON c.id = s.classroom_id
      JOIN classroom.classroom_quizzes r ON r.id = a.classroom_quiz_id
      JOIN classroom.quizzes q ON q.id = r.quiz_id AND q.trashed_at IS NULL
      JOIN classroom.quiz_images i ON i.id = ${params.imageId} AND i.quiz_id = r.quiz_id
      WHERE a.id = ${params.attemptId} AND s.account_id = ${actor.id} AND s.archived_at IS NULL AND c.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.content_snapshot->'questions') q
          WHERE q->>'imageId' = i.id::text OR EXISTS (SELECT 1 FROM jsonb_array_elements(q->'choices') choice WHERE choice->>'imageId' = i.id::text))`;
    if (!image) throw new HttpError(404, "ไม่พบภาพนี้");
    const path = await storedFilePath(image.storageName);
    return new Response(Bun.file(path), { headers: { "content-type": "image/webp", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  }, { params: t.Object({ attemptId: t.String({ format: "uuid" }), imageId: t.String({ format: "uuid" }) }) });

async function lockStudentAttempt(tx: postgres.ISql, attemptId: string, accountId: string) {
  const [identity] = await tx<{ roundId: string }[]>`SELECT a.classroom_quiz_id AS "roundId" FROM classroom.quiz_attempts a
    JOIN classroom.students s ON s.id = a.student_id AND s.classroom_id = a.classroom_id
    JOIN classroom.classrooms c ON c.id = s.classroom_id
    JOIN classroom.classroom_quizzes r ON r.id = a.classroom_quiz_id
    JOIN classroom.quizzes q ON q.id = r.quiz_id AND q.trashed_at IS NULL
    WHERE a.id = ${attemptId} AND s.account_id = ${accountId} AND s.archived_at IS NULL AND c.archived_at IS NULL
    FOR SHARE OF s, c`;
  if (!identity) throw new HttpError(404, "ไม่พบความพยายามนี้");
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"quiz-round:" + identity.roundId}, 0))`;
  const [attempt] = await tx<{ id: string; roundId: string; studentId: string; revision: number; finishedAt: string | null; answers: QuizAnswers; content: QuizContent; status: string; solutionsReleasedAt: string | null; score: string | null; expiresAt: string | null; startedAt: string }[]>`
    SELECT a.id, a.classroom_quiz_id AS "roundId", a.student_id AS "studentId", a.revision, a.finished_at AS "finishedAt",
      a.answers, r.content_snapshot AS content, r.status, r.solutions_released_at AS "solutionsReleasedAt",
      a.score::text AS score, a.expires_at AS "expiresAt", a.started_at AS "startedAt"
    FROM classroom.quiz_attempts a JOIN classroom.classroom_quizzes r ON r.id = a.classroom_quiz_id
      JOIN classroom.quizzes q ON q.id = r.quiz_id AND q.trashed_at IS NULL
    WHERE a.id = ${attemptId} FOR UPDATE OF a, r`;
  if (!attempt) throw new HttpError(404, "ไม่พบความพยายามนี้");
  await finalizeExpired(tx, attempt.roundId);
  const [current] = await tx<{ id: string; roundId: string; studentId: string; revision: number; finishedAt: string | null; answers: QuizAnswers; content: QuizContent; status: string; solutionsReleasedAt: string | null; score: string | null; expiresAt: string | null; startedAt: string }[]>`
    SELECT a.id, a.classroom_quiz_id AS "roundId", a.student_id AS "studentId", a.revision, a.finished_at AS "finishedAt",
      a.answers, r.content_snapshot AS content, r.status, r.solutions_released_at AS "solutionsReleasedAt",
      a.score::text AS score, a.expires_at AS "expiresAt", a.started_at AS "startedAt"
    FROM classroom.quiz_attempts a JOIN classroom.classroom_quizzes r ON r.id = a.classroom_quiz_id
      JOIN classroom.quizzes q ON q.id = r.quiz_id AND q.trashed_at IS NULL WHERE a.id = ${attemptId}`;
  return current;
}

async function getStudentAttempt(attemptId: string, accountId: string) {
  const attempt = await sql.begin(async (tx) => {
    await lockStudentAttempt(tx, attemptId, accountId);
    const [fresh] = await tx<{ id: string; roundId: string; revision: number; finishedAt: string | null; answers: QuizAnswers; content: QuizContent; status: string; solutionsReleasedAt: string | null; score: string | null; expiresAt: string | null; startedAt: string; title: string }[]>`
      SELECT a.id, a.classroom_quiz_id AS "roundId", a.revision, a.finished_at AS "finishedAt", a.answers,
        r.content_snapshot AS content, r.status, r.solutions_released_at AS "solutionsReleasedAt",
        a.score::text AS score, a.expires_at AS "expiresAt", a.started_at AS "startedAt", r.title
      FROM classroom.quiz_attempts a JOIN classroom.classroom_quizzes r ON r.id = a.classroom_quiz_id
        JOIN classroom.quizzes q ON q.id = r.quiz_id AND q.trashed_at IS NULL WHERE a.id = ${attemptId}`;
    return fresh;
  });
  const released = attempt.status === "closed" && attempt.solutionsReleasedAt !== null;
  const grading = attempt.finishedAt ? gradeQuiz(attempt.content, attempt.answers) : undefined;
  return {
    id: attempt.id, roundId: attempt.roundId, title: attempt.title, status: attempt.status,
    description: attempt.content.description,
    revision: attempt.revision, answers: attempt.answers, startedAt: attempt.startedAt, expiresAt: attempt.expiresAt,
    finishedAt: attempt.finishedAt, score: attempt.score, maxScore: attempt.content.questions.reduce((sum, question) => sum + question.points, 0),
    solutionsReleased: released,
    questions: studentQuizQuestions(attempt.content, attempt.answers, released, grading),
  };
}

async function studentRoundList(accountId: string, quizId?: string) {
  return sql.begin(async (tx) => {
    const rounds = await tx<{ roundId: string; quizId: string; classroomId: string; classroomName: string; title: string; status: string; durationMinutes: number | null; attemptId: string | null; finishedAt: string | null; score: string | null }[]>`
      SELECT r.id AS "roundId", r.quiz_id AS "quizId", r.classroom_id AS "classroomId", c.name AS "classroomName",
        r.title, r.status, r.duration_minutes AS "durationMinutes", a.id AS "attemptId", a.finished_at AS "finishedAt", a.score::text AS score
      FROM classroom.classroom_quizzes r JOIN classroom.quizzes q ON q.id = r.quiz_id AND q.trashed_at IS NULL
      JOIN classroom.classrooms c ON c.id = r.classroom_id
      JOIN classroom.students s ON s.classroom_id = c.id AND s.account_id = ${accountId}
      LEFT JOIN classroom.quiz_attempts a ON a.classroom_quiz_id = r.id AND a.student_id = s.id
      WHERE (${quizId ?? null}::uuid IS NULL OR r.quiz_id = ${quizId ?? null}::uuid)
        AND s.archived_at IS NULL AND c.archived_at IS NULL
        AND (r.status <> 'closed' OR a.id IS NOT NULL) ORDER BY r.id`;
    for (const round of rounds) {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"quiz-round:" + round.roundId}, 0))`;
      await finalizeExpired(tx, round.roundId);
    }
    return tx`SELECT r.id AS "roundId", r.quiz_id AS "quizId", r.classroom_id AS "classroomId", c.name AS "classroomName",
        r.title, r.status, r.duration_minutes AS "durationMinutes", a.id AS "attemptId", a.finished_at AS "finishedAt", a.score::text AS score
      FROM classroom.classroom_quizzes r JOIN classroom.quizzes q ON q.id = r.quiz_id AND q.trashed_at IS NULL
      JOIN classroom.classrooms c ON c.id = r.classroom_id
      JOIN classroom.students s ON s.classroom_id = c.id AND s.account_id = ${accountId}
      LEFT JOIN classroom.quiz_attempts a ON a.classroom_quiz_id = r.id AND a.student_id = s.id
      WHERE (${quizId ?? null}::uuid IS NULL OR r.quiz_id = ${quizId ?? null}::uuid)
        AND s.archived_at IS NULL AND c.archived_at IS NULL
        AND (r.status <> 'closed' OR a.id IS NOT NULL) ORDER BY r.created_at DESC`;
  });
}
