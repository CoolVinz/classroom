import { Elysia, t } from "elysia";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { sql } from "../db/client";
import { requireActor } from "../auth/session";
import { HttpError } from "../http-error";
import { checkRequestOrigin, cleanText, normalizeEmail, studentEmailForCode } from "../security";
import { maxStoredBytes, saveFileThumbnail, storedFilePath, uploadRoot, uploadThumbnailPath, validateThumbnail, validateUpload, type UploadKind } from "../file-storage";

async function ownedClassroom(classroomId: string, ownerId: string, includeArchived = false) {
  const [room] = await sql<{ id: string }[]>`
    SELECT id FROM classroom.classrooms
    WHERE id = ${classroomId} AND owner_id = ${ownerId}
      AND (${includeArchived} OR archived_at IS NULL)
  `;
  if (!room) throw new HttpError(404, "ไม่พบห้องเรียนนี้");
}

async function ownedAssignment(classroomId: string, assignmentId: string, ownerId: string, includeArchived = false) {
  const [assignment] = await sql<{ id: string }[]>`
    SELECT a.id FROM classroom.assignments a
    JOIN classroom.classrooms c ON c.id = a.classroom_id
    WHERE a.id = ${assignmentId} AND a.classroom_id = ${classroomId}
      AND c.owner_id = ${ownerId} AND c.archived_at IS NULL
      AND (${includeArchived} OR a.archived_at IS NULL)
  `;
  if (!assignment) throw new HttpError(404, "ไม่พบงานนี้");
}

const importRow = t.Object({ studentCode: t.String({ minLength: 1, maxLength: 50 }), studentNumber: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 2147483647 }))), displayName: t.Optional(t.String({ minLength: 1, maxLength: 120 })), email: t.Optional(t.String({ maxLength: 254 })) });
const maximumScore = t.Number({ minimum: 0.01, maximum: 9999999999.99 });

function hasTwoDecimalPlaces(value: number) {
  return Number.isFinite(value) && Math.round(value * 100) === value * 100;
}

export const courseworkRoutes = new Elysia({ prefix: "/api" })
  .get("/classrooms/:classroomId/assignments", async ({ params, request }) => {
    const actor = await requireActor(request);
    await ownedClassroom(params.classroomId, actor.id);
    return sql`
      SELECT a.id, a.title, a.instructions, a.max_score AS "maxScore", a.archived_at IS NOT NULL AS archived,
        a.created_at AS "createdAt", COUNT(f.id)::int AS "fileCount"
      FROM classroom.assignments a
      LEFT JOIN classroom.files f ON f.assignment_id = a.id
      WHERE a.classroom_id = ${params.classroomId}
      GROUP BY a.id ORDER BY a.archived_at NULLS FIRST, a.created_at DESC
    `;
  })
  .post("/classrooms/:classroomId/assignments", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedClassroom(params.classroomId, actor.id);
    const maxScore = body.maxScore ?? 100;
    if (!hasTwoDecimalPlaces(maxScore)) throw new HttpError(422, "คะแนนเต็มต้องใช้ทศนิยมไม่เกิน 2 ตำแหน่ง");
    const [assignment] = await sql`
      INSERT INTO classroom.assignments (classroom_id, title, instructions, max_score)
      VALUES (${params.classroomId}, ${cleanText(body.title, 120)}, ${body.instructions?.trim() ?? ""}, ${maxScore})
      RETURNING id, title, instructions, max_score AS "maxScore", created_at AS "createdAt"
    `;
    return assignment;
  }, { body: t.Object({ title: t.String({ minLength: 1, maxLength: 120 }), instructions: t.Optional(t.String({ maxLength: 5000 })), maxScore: t.Optional(maximumScore) }) })
  .patch("/classrooms/:classroomId/assignments/:assignmentId", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedAssignment(params.classroomId, params.assignmentId, actor.id, body.archived === false);
    if (body.maxScore !== undefined) {
      const maxScore = body.maxScore;
      if (!hasTwoDecimalPlaces(maxScore)) throw new HttpError(422, "คะแนนเต็มต้องใช้ทศนิยมไม่เกิน 2 ตำแหน่ง");
      await sql.begin(async (tx) => {
        const [assignment] = await tx<{ id: string }[]>`
          SELECT a.id FROM classroom.assignments a JOIN classroom.classrooms c ON c.id = a.classroom_id
          WHERE a.id = ${params.assignmentId} AND a.classroom_id = ${params.classroomId}
            AND c.owner_id = ${actor.id} AND c.archived_at IS NULL FOR UPDATE OF a
        `;
        if (!assignment) throw new HttpError(404, "ไม่พบงานนี้");
        const [scores] = await tx<{ highest: number }[]>`
          SELECT GREATEST(COALESCE(MAX(draft_score), 0), COALESCE(MAX(published_score), 0)) AS highest
          FROM classroom.assignment_assessments WHERE assignment_id = ${params.assignmentId}
        `;
        if (maxScore < scores.highest) throw new HttpError(422, "คะแนนเต็มต้องไม่น้อยกว่าคะแนนที่บันทึกไว้");
        await tx`UPDATE classroom.assignments SET max_score = ${maxScore} WHERE id = ${params.assignmentId}`;
      });
    }
    if (body.title !== undefined || body.instructions !== undefined) {
      await sql`
        UPDATE classroom.assignments SET
          title = COALESCE(${body.title === undefined ? null : cleanText(body.title, 120)}, title),
          instructions = COALESCE(${body.instructions ?? null}, instructions)
        WHERE id = ${params.assignmentId} AND classroom_id = ${params.classroomId}
      `;
    }
    if (body.archived !== undefined) {
      await sql`UPDATE classroom.assignments SET archived_at = ${body.archived ? sql`NOW()` : sql`NULL`} WHERE id = ${params.assignmentId} AND classroom_id = ${params.classroomId}`;
    }
    return { ok: true };
  }, { body: t.Object({ title: t.Optional(t.String({ minLength: 1, maxLength: 120 })), instructions: t.Optional(t.String({ maxLength: 5000 })), maxScore: t.Optional(maximumScore), archived: t.Optional(t.Boolean()) }) })
  .get("/classrooms/:classroomId/assignments/:assignmentId/assessments", async ({ params, query, request }) => {
    const actor = await requireActor(request);
    await ownedAssignment(params.classroomId, params.assignmentId, actor.id, true);
    const page = query.page ?? 1;
    const [count] = await sql<{ total: number }[]>`
      SELECT COUNT(*)::int AS total FROM classroom.students WHERE classroom_id = ${params.classroomId}
    `;
    const students = await sql`
      SELECT s.id AS "studentId", s.display_name AS "studentName", s.student_code AS "studentCode",
        s.student_number AS "studentNumber", s.archived_at IS NOT NULL AS archived,
        COALESCE(work.submission_count, 0)::int AS "submissionCount",
        latest.id AS "latestFileId", latest.kind AS "latestFileKind", latest.original_name AS "latestFileName",
        latest.media_type AS "latestMediaType", latest.size_bytes AS "latestFileSize", latest.created_at AS "latestFileCreatedAt",
        latest.submitted_by_account_id IS NOT NULL AS "latestStudentSubmission",
        latest.thumbnail_size_bytes IS NOT NULL AS "latestThumbnailAvailable",
        q.draft_score AS "draftScore", COALESCE(q.draft_feedback, '') AS "draftFeedback",
        COALESCE(q.draft_revision, 0)::int AS "draftRevision", q.draft_updated_at AS "draftUpdatedAt",
        q.published_score AS "publishedScore", q.published_max_score AS "publishedMaxScore",
        q.published_feedback AS "publishedFeedback", q.published_revision AS "publishedRevision", q.published_at AS "publishedAt",
        (q.draft_updated_at IS NOT NULL AND EXISTS (
          SELECT 1 FROM classroom.files f WHERE f.assignment_id = ${params.assignmentId}
            AND f.student_id = s.id AND f.kind IN ('model', 'submission')
            AND NOT (f.id = ANY(COALESCE(q.draft_reviewed_file_ids, ARRAY[]::uuid[])))
        )) AS "draftHasNewWork",
        (q.published_at IS NOT NULL AND EXISTS (
          SELECT 1 FROM classroom.files f WHERE f.assignment_id = ${params.assignmentId}
            AND f.student_id = s.id AND f.kind IN ('model', 'submission')
            AND NOT (f.id = ANY(COALESCE(q.published_reviewed_file_ids, ARRAY[]::uuid[])))
        )) AS "publishedHasNewWork"
      FROM classroom.students s
      LEFT JOIN classroom.assignment_assessments q
        ON q.assignment_id = ${params.assignmentId} AND q.student_id = s.id
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS submission_count FROM classroom.files f
        WHERE f.assignment_id = ${params.assignmentId} AND f.student_id = s.id AND f.kind IN ('model', 'submission')
      ) work ON TRUE
      LEFT JOIN LATERAL (
        SELECT f.id, f.kind, f.original_name, f.media_type, f.size_bytes, f.created_at,
          f.submitted_by_account_id, f.thumbnail_size_bytes FROM classroom.files f
        WHERE f.assignment_id = ${params.assignmentId} AND f.student_id = s.id AND f.kind IN ('model', 'submission')
        ORDER BY f.work_version DESC LIMIT 1
      ) latest ON TRUE
      WHERE s.classroom_id = ${params.classroomId}
      ORDER BY s.archived_at NULLS FIRST, s.student_number NULLS LAST, s.display_name, s.id
      LIMIT 20 OFFSET ${(page - 1) * 20}
    `;
    const [assignment] = await sql<{ maxScore: number }[]>`SELECT max_score AS "maxScore" FROM classroom.assignments WHERE id = ${params.assignmentId}`;
    return {
      maxScore: assignment!.maxScore, page, pageSize: 20, total: count.total,
      students: students.map((student) => ({
        studentId: student.studentId, studentName: student.studentName, studentCode: student.studentCode,
        studentNumber: student.studentNumber, archived: student.archived, submissionCount: student.submissionCount,
        latestFile: student.latestFileId ? {
          id: student.latestFileId, studentId: student.studentId, studentName: student.studentName,
          kind: student.latestFileKind, originalName: student.latestFileName, mediaType: student.latestMediaType,
          sizeBytes: student.latestFileSize, createdAt: student.latestFileCreatedAt,
          studentSubmission: student.latestStudentSubmission, thumbnailAvailable: student.latestThumbnailAvailable,
        } : null,
        draftScore: student.draftScore, draftFeedback: student.draftFeedback, draftRevision: student.draftRevision,
        draftUpdatedAt: student.draftUpdatedAt, draftHasNewWork: student.draftHasNewWork,
        publishedScore: student.publishedScore, publishedMaxScore: student.publishedMaxScore,
        publishedFeedback: student.publishedFeedback, publishedRevision: student.publishedRevision, publishedAt: student.publishedAt,
        publishedHasNewWork: student.publishedHasNewWork,
      })),
    };
  }, { query: t.Object({ page: t.Optional(t.Integer({ minimum: 1, maximum: 10000 })) }) })
  .put("/classrooms/:classroomId/assignments/:assignmentId/students/:studentId/assessment", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    if (!hasTwoDecimalPlaces(body.score)) throw new HttpError(422, "คะแนนต้องใช้ทศนิยมไม่เกิน 2 ตำแหน่ง");
    const revision = await sql.begin(async (tx) => {
      const [assignment] = await tx<{ maxScore: number }[]>`
        SELECT a.max_score AS "maxScore" FROM classroom.assignments a
        JOIN classroom.classrooms c ON c.id = a.classroom_id
        WHERE a.id = ${params.assignmentId} AND a.classroom_id = ${params.classroomId}
          AND c.owner_id = ${actor.id} AND c.archived_at IS NULL FOR SHARE OF a
      `;
      if (!assignment) throw new HttpError(404, "ไม่พบงานนี้");
      if (body.score > assignment.maxScore) throw new HttpError(422, "คะแนนต้องไม่เกินคะแนนเต็ม");
      const [student] = await tx`SELECT id FROM classroom.students WHERE id = ${params.studentId} AND classroom_id = ${params.classroomId}`;
      if (!student) throw new HttpError(404, "ไม่พบนักเรียนนี้");
      const [current] = await tx<{ draftRevision: number }[]>`
        SELECT draft_revision AS "draftRevision" FROM classroom.assignment_assessments
        WHERE assignment_id = ${params.assignmentId} AND student_id = ${params.studentId} FOR UPDATE
      `;
      if ((!current && body.revision !== 0) || (current && current.draftRevision !== body.revision)) {
        throw new HttpError(409, "งานถูกแก้ไขจากหน้าจออื่น กรุณาโหลดข้อมูลใหม่");
      }
      if (new Set(body.reviewedFileIds).size !== body.reviewedFileIds.length) throw new HttpError(422, "รายการไฟล์ที่ตรวจซ้ำกัน");
      const [reviewed] = await tx<{ ids: string[] }[]>`
        SELECT COALESCE(array_agg(id ORDER BY work_version), ARRAY[]::uuid[]) AS ids
        FROM classroom.files WHERE assignment_id = ${params.assignmentId} AND student_id = ${params.studentId}
          AND kind IN ('model', 'submission') AND id = ANY(${body.reviewedFileIds}::uuid[])
      `;
      if (reviewed.ids.length !== body.reviewedFileIds.length) throw new HttpError(409, "ไฟล์งานเปลี่ยนไปแล้ว กรุณาโหลดใหม่ก่อนบันทึก");
      const [saved] = await tx<{ draftRevision: number }[]>`
        INSERT INTO classroom.assignment_assessments
          (assignment_id, classroom_id, student_id, draft_score, draft_feedback, draft_reviewed_file_ids, draft_revision, draft_updated_at)
        VALUES (${params.assignmentId}, ${params.classroomId}, ${params.studentId}, ${body.score}, ${body.feedback.trim()}, ${reviewed.ids}, 1, NOW())
        ON CONFLICT (assignment_id, student_id) DO UPDATE SET
          draft_score = EXCLUDED.draft_score, draft_feedback = EXCLUDED.draft_feedback,
          draft_reviewed_file_ids = EXCLUDED.draft_reviewed_file_ids,
          draft_revision = classroom.assignment_assessments.draft_revision + 1, draft_updated_at = NOW()
        WHERE classroom.assignment_assessments.draft_revision = ${body.revision}
        RETURNING draft_revision AS "draftRevision"
      `;
      if (!saved) throw new HttpError(409, "งานถูกแก้ไขจากหน้าจออื่น กรุณาโหลดข้อมูลใหม่");
      return saved.draftRevision;
    });
    return { ok: true, revision };
  }, { body: t.Object({ score: t.Number({ minimum: 0, maximum: 9999999999.99 }), feedback: t.String({ maxLength: 5000 }), revision: t.Integer({ minimum: 0 }), reviewedFileIds: t.Array(t.String({ format: "uuid" })) }) })
  .post("/classrooms/:classroomId/assignments/:assignmentId/students/:studentId/assessment/publish", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const publishedAt = await sql.begin(async (tx) => {
      const [assignment] = await tx<{ maxScore: number }[]>`
        SELECT a.max_score AS "maxScore" FROM classroom.assignments a
        JOIN classroom.classrooms c ON c.id = a.classroom_id
        WHERE a.id = ${params.assignmentId} AND a.classroom_id = ${params.classroomId}
          AND c.owner_id = ${actor.id} AND c.archived_at IS NULL FOR SHARE OF a
      `;
      if (!assignment) throw new HttpError(404, "ไม่พบงานนี้");
      const [published] = await tx<{ publishedAt: string }[]>`
        UPDATE classroom.assignment_assessments SET
          published_score = draft_score, published_max_score = ${assignment.maxScore},
          published_feedback = draft_feedback, published_reviewed_file_ids = draft_reviewed_file_ids,
          published_revision = ${body.revision}, published_at = NOW()
        WHERE assignment_id = ${params.assignmentId} AND classroom_id = ${params.classroomId}
          AND student_id = ${params.studentId} AND draft_revision = ${body.revision} AND draft_score IS NOT NULL
        RETURNING published_at AS "publishedAt"
      `;
      if (!published) throw new HttpError(409, "ยังไม่มีฉบับร่างล่าสุดให้เผยแพร่");
      return published.publishedAt;
    });
    return { ok: true, publishedAt };
  }, { body: t.Object({ revision: t.Integer({ minimum: 0 }) }) })
  .post("/classrooms/:classroomId/assignments/:assignmentId/students/:studentId/assessment/unpublish", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedAssignment(params.classroomId, params.assignmentId, actor.id, true);
    const [result] = await sql`
      UPDATE classroom.assignment_assessments q SET published_score = NULL, published_max_score = NULL,
        published_feedback = NULL, published_reviewed_file_ids = NULL, published_revision = NULL, published_at = NULL
      FROM classroom.classrooms c WHERE q.assignment_id = ${params.assignmentId}
        AND q.classroom_id = ${params.classroomId} AND q.student_id = ${params.studentId}
        AND c.id = q.classroom_id AND c.owner_id = ${actor.id} AND c.archived_at IS NULL
        AND q.published_revision = ${body.revision}
      RETURNING q.student_id
    `;
    if (!result) throw new HttpError(409, "ผลคะแนนเปลี่ยนไปแล้ว กรุณาโหลดข้อมูลใหม่");
    return { ok: true };
  }, { body: t.Object({ revision: t.Integer({ minimum: 0 }) }) })
  .get("/classrooms/:classroomId/assignments/:assignmentId/files", async ({ params, query, request }) => {
    const actor = await requireActor(request);
    await ownedAssignment(params.classroomId, params.assignmentId, actor.id, true);
    return sql`
      SELECT f.id, f.assignment_id AS "assignmentId", f.student_id AS "studentId",
        s.display_name AS "studentName", f.kind, f.original_name AS "originalName",
        f.media_type AS "mediaType", f.size_bytes AS "sizeBytes", f.created_at AS "createdAt",
        f.submitted_by_account_id IS NOT NULL AS "studentSubmission",
        f.thumbnail_size_bytes IS NOT NULL AS "thumbnailAvailable"
      FROM classroom.files f LEFT JOIN classroom.students s ON s.id = f.student_id
      WHERE f.classroom_id = ${params.classroomId} AND f.assignment_id = ${params.assignmentId}
        AND (${query.studentId ?? null}::uuid IS NULL OR f.student_id = ${query.studentId ?? null})
        AND (${query.kind ?? null}::text IS NULL OR f.kind = ${query.kind ?? null})
      ORDER BY f.created_at DESC
    `;
  }, { query: t.Object({ studentId: t.Optional(t.String({ format: "uuid" })), kind: t.Optional(t.Union([t.Literal("worksheet"), t.Literal("model"), t.Literal("submission")])) }) })
  .post("/classrooms/:classroomId/files", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const kind = body.kind as UploadKind;
    const valid = await validateUpload(body.file, kind);
    const originalName = basename(valid.originalName);
    const id = randomUUID();
    const storageName = id;
    const root = uploadRoot();
    await mkdir(root, { recursive: true, mode: 0o750 });
    const tempPath = resolve(root, id + ".upload");
    const storedPath = resolve(root, storageName);
    let renamed = false;
    try {
      await Bun.write(tempPath, body.file);
      await sql.begin(async (tx) => {
        await tx.unsafe("SELECT pg_advisory_xact_lock(870010022)");
        const [context] = await tx<{ id: string; student: string | null }[]>`
          SELECT a.id,
            CASE WHEN ${body.studentId ?? null}::uuid IS NULL THEN NULL ELSE s.id END AS student
          FROM classroom.assignments a
          JOIN classroom.classrooms c ON c.id = a.classroom_id
          LEFT JOIN classroom.students s ON s.id = ${body.studentId ?? null}
            AND s.classroom_id = a.classroom_id AND s.archived_at IS NULL
          WHERE a.id = ${body.assignmentId} AND a.classroom_id = ${params.classroomId}
            AND a.archived_at IS NULL AND c.owner_id = ${actor.id} AND c.archived_at IS NULL
        `;
        if (!context || (kind === "model" && !context.student) || (kind === "worksheet" && body.studentId)) {
          throw new HttpError(422, "ห้องเรียน งาน หรือนักเรียนไม่ถูกต้อง");
        }
        const [usage] = await tx<{ used: string }[]>`
          SELECT COALESCE(SUM(size_bytes + COALESCE(thumbnail_size_bytes, 0)), 0)::text AS used FROM classroom.files
        `;
        if (Number(usage.used) + body.file.size > maxStoredBytes()) throw new HttpError(413, "พื้นที่จัดเก็บไฟล์เต็มแล้ว");
        await rename(tempPath, storedPath);
        renamed = true;
        await tx`
          INSERT INTO classroom.files
            (id, classroom_id, assignment_id, student_id, uploaded_by, kind, original_name, storage_name, media_type, size_bytes)
          VALUES (${id}, ${params.classroomId}, ${body.assignmentId}, ${context.student}, ${actor.id}, ${kind}, ${originalName}, ${storageName}, ${valid.mediaType}, ${body.file.size})
        `;
      });
      return { id, originalName, mediaType: valid.mediaType, sizeBytes: body.file.size };
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      if (renamed) {
        try {
          const [record] = await sql<{ id: string }[]>`SELECT id FROM classroom.files WHERE id = ${id}`;
          if (!record) await rm(storedPath, { force: true });
        } catch { /* Startup reconciliation removes orphaned files when the commit result is unknown. */ }
      }
      throw error;
    }
  }, { body: t.Object({ file: t.File(), assignmentId: t.String({ format: "uuid" }), kind: t.Union([t.Literal("worksheet"), t.Literal("model")]), studentId: t.Optional(t.String({ format: "uuid" })) }) })
  .get("/files/:fileId/content", async ({ params, request }) => {
    const actor = await requireActor(request);
    const [record] = await sql<{ storageName: string; mediaType: string; originalName: string }[]>`
      SELECT f.storage_name AS "storageName", f.media_type AS "mediaType", f.original_name AS "originalName"
      FROM classroom.files f JOIN classroom.classrooms c ON c.id = f.classroom_id
      WHERE f.id = ${params.fileId} AND c.owner_id = ${actor.id}
    `;
    if (!record) throw new HttpError(404, "ไม่พบไฟล์นี้");
    const path = await storedFilePath(record.storageName);
    const disposition = record.mediaType === "application/pdf" || record.mediaType.startsWith("image/") ? "inline" : "attachment";
    return new Response(Bun.file(path), { headers: {
      "content-type": record.mediaType,
      "content-disposition": disposition + "; filename*=UTF-8''" + encodeURIComponent(record.originalName),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    } });
  })
  .get("/files/:fileId/thumbnail", async ({ params, request }) => {
    const actor = await requireActor(request);
    const [record] = await sql`SELECT f.thumbnail_size_bytes FROM classroom.files f
      JOIN classroom.classrooms c ON c.id = f.classroom_id
      WHERE f.id = ${params.fileId} AND c.owner_id = ${actor.id}`;
    if (!record || record.thumbnail_size_bytes === null) throw new HttpError(404, "ยังไม่มีภาพตัวอย่าง");
    const path = await storedFilePath("thumbnails/" + params.fileId + ".png");
    return new Response(Bun.file(path), { headers: { "content-type": "image/png", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  })
  .put("/files/:fileId/thumbnail", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await saveFileThumbnail(params.fileId, await validateThumbnail(body.file), "teacher", actor.id);
    return { ok: true };
  }, { body: t.Object({ file: t.File({ type: "image/png", minSize: 57, maxSize: "256k" }) }) })
  .delete("/files/:fileId", async ({ params, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const staged: { path: string; tombstone: string }[] = [];
    try {
      const [record] = await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(870010022)`;
        const [file] = await tx<{ storageName: string; thumbnail: boolean }[]>`
          SELECT f.storage_name AS "storageName", f.thumbnail_size_bytes IS NOT NULL AS thumbnail FROM classroom.files f
          JOIN classroom.classrooms c ON c.id = f.classroom_id
          WHERE f.id = ${params.fileId} AND c.owner_id = ${actor.id} FOR UPDATE OF f
        `;
        if (!file) throw new HttpError(404, "ไม่พบไฟล์นี้");
        const path = resolve(uploadRoot(), file.storageName);
        const tombstone = path + ".deleting";
        staged.push({ path, tombstone });
        try { await rename(path, tombstone); }
        catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
        if (file.thumbnail) {
          const thumbnail = uploadThumbnailPath(params.fileId);
          const thumbnailTombstone = thumbnail + ".deleting";
          staged.push({ path: thumbnail, tombstone: thumbnailTombstone });
          try { await rename(thumbnail, thumbnailTombstone); }
          catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
        }
        await tx`DELETE FROM classroom.files WHERE id = ${params.fileId}`;
        return [file];
      });
      if (!record) throw new HttpError(404, "ไม่พบไฟล์นี้");
    } catch (error) {
      try {
        const [record] = await sql`SELECT id FROM classroom.files WHERE id = ${params.fileId}`;
        for (const file of staged) {
          if (record) await rename(file.tombstone, file.path).catch(() => {});
          else await rm(file.tombstone, { force: true }).catch(() => {});
        }
      } catch { /* Startup reconciliation resolves staged files if the transaction result is unknown. */ }
      throw error;
    }
    const cleanup = await Promise.all(staged.map((file) => rm(file.tombstone, { force: true }).then(() => false, () => true)));
    const cleanupPending = cleanup.some(Boolean);
    return { ok: true, cleanupPending };
  })
  .post("/classrooms/:classroomId/roster/import", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedClassroom(params.classroomId, actor.id);
    const seen = new Set<string>();
    const seenEmails = new Set<string>();
    const rows = body.students.map((row) => {
      const studentCode = cleanText(row.studentCode, 50);
      if (!studentCode || seen.has(studentCode)) throw new HttpError(422, "ไฟล์มีรหัสนักเรียนซ้ำหรือว่าง");
      seen.add(studentCode);
      return { studentCode, studentNumber: row.studentNumber ?? null, displayName: row.displayName === undefined ? null : cleanText(row.displayName, 120), email: row.email };
    });
    return sql.begin(async (tx) => {
      const [room] = await tx<{ id: string }[]>`SELECT id FROM classroom.classrooms WHERE id = ${params.classroomId} AND owner_id = ${actor.id} AND archived_at IS NULL FOR UPDATE`;
      if (!room) throw new HttpError(404, "ไม่พบห้องเรียนนี้");
      const assignedNumbers = await tx<{ studentNumber: number }[]>`
        SELECT student_number AS "studentNumber" FROM classroom.students
        WHERE classroom_id = ${params.classroomId} AND archived_at IS NULL AND student_number IS NOT NULL
      `;
      const claimedNumbers = new Set(assignedNumbers.map(({ studentNumber }) => studentNumber));
      let added = 0;
      let updated = 0;
      let skipped = 0;
      for (const row of rows) {
        const [existing] = await tx<{ id: string; archived: boolean; studentNumber: number | null }[]>`
          SELECT id, archived_at IS NOT NULL AS archived, student_number AS "studentNumber"
          FROM classroom.students WHERE classroom_id = ${params.classroomId} AND student_code = ${row.studentCode} FOR UPDATE
        `;
        if (existing) {
          if (existing.archived || existing.studentNumber !== null || row.studentNumber === null) { skipped++; continue; }
          if (claimedNumbers.has(row.studentNumber)) throw new HttpError(409, "เลขที่ซ้ำในห้องเรียน");
          await tx`UPDATE classroom.students SET student_number = ${row.studentNumber} WHERE id = ${existing.id}`;
          claimedNumbers.add(row.studentNumber); updated++;
          continue;
        }
        if (!row.displayName) throw new HttpError(422, "นักเรียนใหม่ต้องมีชื่อ");
        if (row.studentNumber !== null && claimedNumbers.has(row.studentNumber)) throw new HttpError(409, "เลขที่ซ้ำในห้องเรียน");
        const email = normalizeEmail(row.email) ?? studentEmailForCode(row.studentCode);
        if (email && seenEmails.has(email)) throw new HttpError(422, "อีเมลนักเรียนซ้ำในไฟล์");
        if (email) seenEmails.add(email);
        await tx`
          INSERT INTO classroom.students (classroom_id, student_code, student_number, display_name, email)
          VALUES (${params.classroomId}, ${row.studentCode}, ${row.studentNumber}, ${row.displayName}, ${email})
        `;
        if (row.studentNumber !== null) claimedNumbers.add(row.studentNumber);
        added++;
      }
      return { added, updated, skipped };
    }).catch((error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") {
        throw new HttpError(409, "รหัส อีเมล หรือเลขที่นักเรียนนี้มีอยู่ในห้องเรียนแล้ว");
      }
      throw error;
    });
  }, { body: t.Object({ students: t.Array(importRow, { minItems: 1, maxItems: 1000 }) }) });
