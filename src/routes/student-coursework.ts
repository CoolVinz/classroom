import { Elysia, t } from "elysia";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { requireStudent } from "../auth/session";
import { sql } from "../db/client";
import { HttpError } from "../http-error";
import { checkRequestOrigin } from "../security";
import { maxStoredBytes, saveFileThumbnail, storedFilePath, uploadRoot, uploadThumbnailPath, validateStudentUpload, validateThumbnail } from "../file-storage";

async function activeMembership(classroomId: string, assignmentId: string, accountId: string) {
  const [membership] = await sql<{ studentId: string }[]>`
    SELECT s.id AS "studentId"
    FROM classroom.students s
    JOIN classroom.classrooms c ON c.id = s.classroom_id
    JOIN classroom.assignments a ON a.classroom_id = c.id
    WHERE s.account_id = ${accountId} AND s.classroom_id = ${classroomId}
      AND s.archived_at IS NULL AND c.archived_at IS NULL
      AND a.id = ${assignmentId} AND a.archived_at IS NULL
  `;
  if (!membership) throw new HttpError(404, "ไม่พบงานนี้");
  return membership.studentId;
}

export const studentCourseworkRoutes = new Elysia({ prefix: "/api/student" })
  .get("/assignments", async ({ request }) => {
    const actor = await requireStudent(request);
    return sql`
      SELECT a.id AS "assignmentId", a.title, a.instructions,
        c.id AS "classroomId", c.name AS "classroomName",
        a.created_at AS "createdAt", q.published_score AS "publishedScore",
        q.published_max_score AS "publishedMaxScore", q.published_feedback AS "publishedFeedback",
        q.published_at AS "publishedAt",
        (SELECT COUNT(*)::int FROM classroom.files f WHERE f.assignment_id = a.id
          AND f.student_id = s.id AND f.submitted_by_account_id = ${actor.id}) AS "submissionCount",
        EXISTS (SELECT 1 FROM classroom.files newer
          WHERE newer.assignment_id = a.id AND newer.student_id = s.id
            AND newer.kind IN ('model', 'submission')
            AND NOT (newer.id = ANY(COALESCE(q.published_reviewed_file_ids, ARRAY[]::uuid[])))) AS "newWork"
      FROM classroom.students s
      JOIN classroom.classrooms c ON c.id = s.classroom_id
      JOIN classroom.assignments a ON a.classroom_id = c.id
      LEFT JOIN classroom.assignment_assessments q ON q.assignment_id = a.id AND q.student_id = s.id
      WHERE s.account_id = ${actor.id} AND s.archived_at IS NULL
        AND c.archived_at IS NULL AND a.archived_at IS NULL
      ORDER BY c.name, a.created_at DESC
    `;
  })
  .get("/classrooms/:classroomId/assignments/:assignmentId/files", async ({ params, request }) => {
    const actor = await requireStudent(request);
    const studentId = await activeMembership(params.classroomId, params.assignmentId, actor.id);
    return sql`
      SELECT f.id, f.assignment_id AS "assignmentId", f.student_id AS "studentId",
        f.kind, f.original_name AS "originalName", f.media_type AS "mediaType",
        f.size_bytes AS "sizeBytes", f.created_at AS "createdAt",
        f.submitted_by_account_id = ${actor.id} AS "studentSubmission",
        f.thumbnail_size_bytes IS NOT NULL AS "thumbnailAvailable"
      FROM classroom.files f
      WHERE f.classroom_id = ${params.classroomId} AND f.assignment_id = ${params.assignmentId}
        AND (f.kind = 'worksheet' OR f.student_id = ${studentId})
      ORDER BY f.created_at DESC
    `;
  })
  .post("/classrooms/:classroomId/assignments/:assignmentId/files", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireStudent(request);
    const valid = await validateStudentUpload(body.file);
    const studentId = await activeMembership(params.classroomId, params.assignmentId, actor.id);
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
        const [membership] = await tx<{ studentId: string }[]>`
          SELECT s.id AS "studentId"
          FROM classroom.students s
          JOIN classroom.classrooms c ON c.id = s.classroom_id
          JOIN classroom.assignments a ON a.classroom_id = c.id
          WHERE s.id = ${studentId} AND s.account_id = ${actor.id}
            AND s.classroom_id = ${params.classroomId} AND s.archived_at IS NULL
            AND c.archived_at IS NULL AND a.id = ${params.assignmentId} AND a.archived_at IS NULL
          FOR SHARE OF s, c, a
        `;
        if (!membership) throw new HttpError(404, "ไม่พบงานนี้");
        const [usage] = await tx<{ used: string }[]>`
          SELECT COALESCE(SUM(size_bytes + COALESCE(thumbnail_size_bytes, 0)), 0)::text AS used FROM classroom.files
        `;
        if (Number(usage.used) + body.file.size > maxStoredBytes()) throw new HttpError(413, "พื้นที่จัดเก็บไฟล์เต็มแล้ว");
        await rename(tempPath, storedPath);
        renamed = true;
        await tx`
          INSERT INTO classroom.files
            (id, classroom_id, assignment_id, student_id, submitted_by_account_id,
              uploaded_by, kind, original_name, storage_name, media_type, size_bytes)
          VALUES (${id}, ${params.classroomId}, ${params.assignmentId}, ${studentId},
            ${actor.id}, NULL, ${valid.kind === "model" ? "model" : "submission"},
            ${originalName}, ${storageName}, ${valid.mediaType}, ${body.file.size})
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
  }, { body: t.Object({ file: t.File() }) })
  .get("/files/:fileId/content", async ({ params, request }) => {
    const actor = await requireStudent(request);
    const [record] = await sql<{ storageName: string; mediaType: string; originalName: string }[]>`
      SELECT f.storage_name AS "storageName", f.media_type AS "mediaType", f.original_name AS "originalName"
      FROM classroom.files f
      JOIN classroom.classrooms c ON c.id = f.classroom_id
      JOIN classroom.assignments a ON a.id = f.assignment_id
      WHERE f.id = ${params.fileId} AND c.archived_at IS NULL AND a.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM classroom.students s
          WHERE s.account_id = ${actor.id} AND s.classroom_id = f.classroom_id
            AND s.archived_at IS NULL
            AND (f.kind = 'worksheet' OR f.student_id = s.id))
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
    const actor = await requireStudent(request);
    const [record] = await sql`SELECT f.thumbnail_size_bytes FROM classroom.files f
      JOIN classroom.classrooms c ON c.id = f.classroom_id
      JOIN classroom.assignments a ON a.id = f.assignment_id
      WHERE f.id = ${params.fileId} AND c.archived_at IS NULL AND a.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM classroom.students s
          WHERE s.account_id = ${actor.id} AND s.classroom_id = f.classroom_id AND s.archived_at IS NULL
            AND (f.kind = 'worksheet' OR f.student_id = s.id))`;
    if (!record || record.thumbnail_size_bytes === null) throw new HttpError(404, "ยังไม่มีภาพตัวอย่าง");
    const path = await storedFilePath("thumbnails/" + params.fileId + ".png");
    return new Response(Bun.file(path), { headers: { "content-type": "image/png", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  })
  .put("/files/:fileId/thumbnail", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireStudent(request);
    await saveFileThumbnail(params.fileId, await validateThumbnail(body.file), "student", actor.id);
    return { ok: true };
  }, { body: t.Object({ file: t.File({ type: "image/png", minSize: 57, maxSize: "256k" }) }) });
