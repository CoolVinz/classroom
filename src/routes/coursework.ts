import { Elysia, t } from "elysia";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { sql } from "../db/client";
import { requireActor } from "../auth/session";
import { HttpError } from "../http-error";
import { checkRequestOrigin, cleanText } from "../security";
import { maxStoredBytes, uploadRoot, validateUpload, type UploadKind } from "../file-storage";

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

const importRow = t.Object({ studentCode: t.String({ minLength: 1, maxLength: 50 }), displayName: t.String({ minLength: 1, maxLength: 120 }) });

export const courseworkRoutes = new Elysia({ prefix: "/api" })
  .get("/classrooms/:classroomId/assignments", async ({ params, request }) => {
    const actor = await requireActor(request);
    await ownedClassroom(params.classroomId, actor.id);
    return sql`
      SELECT a.id, a.title, a.instructions, a.archived_at IS NOT NULL AS archived,
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
    const [assignment] = await sql`
      INSERT INTO classroom.assignments (classroom_id, title, instructions)
      VALUES (${params.classroomId}, ${cleanText(body.title, 120)}, ${body.instructions?.trim() ?? ""})
      RETURNING id, title, instructions, created_at AS "createdAt"
    `;
    return assignment;
  }, { body: t.Object({ title: t.String({ minLength: 1, maxLength: 120 }), instructions: t.Optional(t.String({ maxLength: 5000 })) }) })
  .patch("/classrooms/:classroomId/assignments/:assignmentId", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedAssignment(params.classroomId, params.assignmentId, actor.id, body.archived === false);
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
  }, { body: t.Object({ title: t.Optional(t.String({ minLength: 1, maxLength: 120 })), instructions: t.Optional(t.String({ maxLength: 5000 })), archived: t.Optional(t.Boolean()) }) })
  .get("/classrooms/:classroomId/assignments/:assignmentId/files", async ({ params, request }) => {
    const actor = await requireActor(request);
    await ownedAssignment(params.classroomId, params.assignmentId, actor.id, true);
    return sql`
      SELECT f.id, f.assignment_id AS "assignmentId", f.student_id AS "studentId",
        s.display_name AS "studentName", f.kind, f.original_name AS "originalName",
        f.media_type AS "mediaType", f.size_bytes AS "sizeBytes", f.created_at AS "createdAt"
      FROM classroom.files f LEFT JOIN classroom.students s ON s.id = f.student_id
      WHERE f.classroom_id = ${params.classroomId} AND f.assignment_id = ${params.assignmentId}
      ORDER BY f.created_at DESC
    `;
  })
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
        const [usage] = await tx<{ used: string }[]>`SELECT COALESCE(SUM(size_bytes), 0)::text AS used FROM classroom.files`;
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
    const path = resolve(uploadRoot(), record.storageName);
    const disposition = record.mediaType === "application/pdf" || record.mediaType.startsWith("image/") ? "inline" : "attachment";
    return new Response(Bun.file(path), { headers: {
      "content-type": record.mediaType,
      "content-disposition": disposition + "; filename*=UTF-8''" + encodeURIComponent(record.originalName),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    } });
  })
  .delete("/files/:fileId", async ({ params, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const [record] = await sql<{ storageName: string }[]>`
      SELECT f.storage_name AS "storageName" FROM classroom.files f
      JOIN classroom.classrooms c ON c.id = f.classroom_id
      WHERE f.id = ${params.fileId} AND c.owner_id = ${actor.id}
    `;
    if (!record) throw new HttpError(404, "ไม่พบไฟล์นี้");
    const path = resolve(uploadRoot(), record.storageName);
    const tombstone = path + ".deleting";
    await rename(path, tombstone);
    try { await sql`DELETE FROM classroom.files WHERE id = ${params.fileId}`; }
    catch (error) { await rename(tombstone, path).catch(() => {}); throw error; }
    await rm(tombstone, { force: true }).catch(() => {});
    return { ok: true };
  })
  .post("/classrooms/:classroomId/roster/import", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    await ownedClassroom(params.classroomId, actor.id);
    const seen = new Set<string>();
    const rows = body.students.map((row) => {
      const studentCode = cleanText(row.studentCode, 50);
      const displayName = cleanText(row.displayName, 120);
      if (seen.has(studentCode)) throw new HttpError(422, "ไฟล์มีรหัสนักเรียนซ้ำ");
      seen.add(studentCode);
      return { studentCode, displayName };
    });
    return sql.begin(async (tx) => {
      const [room] = await tx<{ id: string }[]>`SELECT id FROM classroom.classrooms WHERE id = ${params.classroomId} AND owner_id = ${actor.id} AND archived_at IS NULL FOR UPDATE`;
      if (!room) throw new HttpError(404, "ไม่พบห้องเรียนนี้");
      let added = 0;
      for (const row of rows) {
        const inserted = await tx<{ id: string }[]>`
          INSERT INTO classroom.students (classroom_id, student_code, display_name)
          VALUES (${params.classroomId}, ${row.studentCode}, ${row.displayName})
          ON CONFLICT (classroom_id, student_code) DO NOTHING RETURNING id
        `;
        added += inserted.length;
      }
      return { added, skipped: rows.length - added };
    });
  }, { body: t.Object({ students: t.Array(importRow, { minItems: 1, maxItems: 1000 }) }) });
