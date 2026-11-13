import { access, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createGunzip, inflateSync } from "node:zlib";
import sharp from "sharp";
import { HttpError } from "./http-error";

export type UploadKind = "worksheet" | "model";

const FILE_TYPES: Record<string, { kind: UploadKind; mediaType: string }> = {
  pdf: { kind: "worksheet", mediaType: "application/pdf" },
  png: { kind: "worksheet", mediaType: "image/png" },
  jpg: { kind: "worksheet", mediaType: "image/jpeg" },
  jpeg: { kind: "worksheet", mediaType: "image/jpeg" },
  doc: { kind: "worksheet", mediaType: "application/msword" },
  docx: { kind: "worksheet", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  stl: { kind: "model", mediaType: "model/stl" },
  obj: { kind: "model", mediaType: "model/obj" },
};

function positiveLimit(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export const maxUploadBytes = () => positiveLimit("UPLOAD_MAX_FILE_BYTES", 50 * 1024 * 1024);
export const maxStoredBytes = () => positiveLimit("UPLOAD_MAX_TOTAL_BYTES", 5 * 1024 * 1024 * 1024);
export const uploadRoot = () => resolve(process.env.UPLOAD_DIR ?? (process.env.NODE_ENV === "production" ? "/app/uploads" : "./uploads"));
export const uploadThumbnailPath = (fileId: string, mediaType: "image/png" | "image/webp") => resolve(uploadRoot(), "thumbnails", fileId + (mediaType === "image/webp" ? ".webp" : ".png"));

function pngCrc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function validateThumbnail(file: File) {
  if (file.type !== "image/png" || file.size < 57 || file.size > 256 * 1024) {
    throw new HttpError(422, "ภาพตัวอย่างต้องเป็น PNG ขนาดไม่เกิน 256 KB");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)
    || view.getUint32(8) !== 13 || String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR"
    || view.getUint32(16) !== 256 || view.getUint32(20) !== 192
    || bytes[24] !== 8 || bytes[25] !== 6 || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0) {
    throw new HttpError(422, "ภาพตัวอย่างไม่ถูกต้อง");
  }
  let offset = 8; let hasHeader = false; let hasData = false; let hasEnd = false; let dataEnded = false;
  const data: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) throw new HttpError(422, "ภาพตัวอย่างไม่ถูกต้อง");
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = String.fromCharCode(...typeBytes);
    const chunk = bytes.subarray(offset + 4, offset + 8 + length);
    if (pngCrc32(chunk) !== view.getUint32(offset + 8 + length)) throw new HttpError(422, "ภาพตัวอย่างไม่ถูกต้อง");
    if (!hasHeader && type !== "IHDR") throw new HttpError(422, "ภาพตัวอย่างไม่ถูกต้อง");
    if (type === "IHDR") {
      if (hasHeader || length !== 13) throw new HttpError(422, "ภาพตัวอย่างไม่ถูกต้อง");
      hasHeader = true;
    } else if (type === "IDAT") {
      if (dataEnded || !length) throw new HttpError(422, "ภาพตัวอย่างไม่ถูกต้อง");
      hasData = true;
      data.push(Buffer.from(bytes.subarray(offset + 8, offset + 8 + length)));
    } else if (type === "IEND") {
      if (length !== 0 || !hasData || offset + 12 !== bytes.length) throw new HttpError(422, "ภาพตัวอย่างไม่ถูกต้อง");
      hasEnd = true;
    } else {
      if ((typeBytes[0] & 0x20) === 0) throw new HttpError(422, "ภาพตัวอย่างไม่ถูกต้อง");
      if (hasData) dataEnded = true;
    }
    offset += length + 12;
    if (hasEnd) break;
  }
  if (!hasHeader || !hasData || !hasEnd) throw new HttpError(422, "ภาพตัวอย่างไม่ถูกต้อง");
  try {
    const pixels = inflateSync(Buffer.concat(data), { maxOutputLength: 192 * (256 * 4 + 1) });
    if (pixels.length !== 192 * (256 * 4 + 1)) throw new Error("invalid dimensions");
    for (let row = 0; row < 192; row++) if (pixels[row * (256 * 4 + 1)] > 4) throw new Error("invalid scanline");
  } catch { throw new HttpError(422, "ภาพตัวอย่างไม่ถูกต้อง"); }
  try {
    const webp = await sharp(bytes, { failOn: "error", limitInputPixels: 256 * 192 }).webp({ quality: 80 }).toBuffer();
    const metadata = await sharp(webp).metadata();
    if (metadata.format !== "webp" || metadata.width !== 256 || metadata.height !== 192) throw new Error("invalid preview");
    return webp;
  } catch {
    throw new HttpError(422, "ภาพตัวอย่างไม่ถูกต้อง");
  }
}

export async function saveFileThumbnail(fileId: string, bytes: Uint8Array, role: "teacher" | "student", accountId: string) {
  const root = uploadRoot();
  const folder = resolve(root, "thumbnails");
  await mkdir(folder, { recursive: true, mode: 0o750 });
  const path = uploadThumbnailPath(fileId, "image/webp");
  const temporary = path + ".upload";
  let renamed = false;
  const { sql } = await import("./db/client");
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(870010022)`;
      const [file] = await tx<{ id: string; thumbnailSizeBytes: number | null; thumbnailMediaType: "image/png" | "image/webp" | null }[]>`
        SELECT f.id, f.thumbnail_size_bytes AS "thumbnailSizeBytes", f.thumbnail_media_type AS "thumbnailMediaType"
        FROM classroom.files f
        WHERE f.id = ${fileId} AND f.kind <> 'working' AND (
          (${role} = 'teacher' AND EXISTS (
            SELECT 1 FROM classroom.classrooms c WHERE c.id = f.classroom_id AND c.owner_id = ${accountId}
          )) OR (${role} = 'student' AND EXISTS (
            SELECT 1 FROM classroom.students s
            JOIN classroom.assignments a ON a.id = f.assignment_id AND a.classroom_id = s.classroom_id
            JOIN classroom.classrooms c ON c.id = s.classroom_id
            WHERE s.classroom_id = f.classroom_id AND s.account_id = ${accountId}
              AND (f.kind = 'worksheet' OR f.student_id = s.id)
              AND s.archived_at IS NULL AND c.archived_at IS NULL AND a.archived_at IS NULL
          ))
        ) FOR UPDATE OF f
      `;
      if (!file) throw new HttpError(404, "ไม่พบไฟล์นี้");
      if (file.thumbnailSizeBytes !== null) {
        const mediaType = file.thumbnailMediaType ?? "image/png";
        try { await storedFilePath("thumbnails/" + fileId + (mediaType === "image/webp" ? ".webp" : ".png")); return; }
        catch (error) {
          if (!(error instanceof HttpError) || error.status !== 404) throw error;
          await tx`UPDATE classroom.files SET thumbnail_size_bytes = NULL, thumbnail_media_type = NULL WHERE id = ${fileId}`;
        }
      }
      const [usage] = await tx<{ used: string }[]>`
        SELECT ((SELECT COALESCE(SUM(size_bytes + COALESCE(thumbnail_size_bytes, 0)), 0) FROM classroom.files) +
          (SELECT COALESCE(SUM(size_bytes), 0) FROM classroom.lesson_page_images))::text AS used
      `;
      if (Number(usage.used) + bytes.byteLength > maxStoredBytes()) throw new HttpError(413, "พื้นที่จัดเก็บไฟล์เต็มแล้ว");
      await Bun.write(temporary, bytes);
      await rename(temporary, path);
      renamed = true;
      await tx`UPDATE classroom.files SET thumbnail_size_bytes = ${bytes.byteLength}, thumbnail_media_type = 'image/webp' WHERE id = ${fileId}`;
    });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    if (renamed) {
      try {
        const [record] = await sql`SELECT thumbnail_media_type FROM classroom.files WHERE id = ${fileId}`;
        if (!record || record.thumbnail_media_type !== "image/webp") await rm(path, { force: true });
      } catch { /* Startup reconciliation removes orphaned previews when the commit result is unknown. */ }
    }
    throw error;
  }
}

export async function storedFilePath(storageName: string) {
  const root = uploadRoot();
  try {
    if (!(await stat(root)).isDirectory()) throw new Error("upload root is not a directory");
  } catch {
    throw new HttpError(503, "พื้นที่จัดเก็บไฟล์ไม่พร้อมใช้งาน กรุณาติดต่อครู");
  }

  const path = resolve(root, storageName);
  try {
    if (!(await stat(path)).isFile()) throw new Error("stored upload is not a file");
    await access(path, constants.R_OK);
    return path;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      throw new HttpError(404, "ไม่พบไฟล์ต้นฉบับในพื้นที่จัดเก็บ กรุณาติดต่อครู");
    }
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "พื้นที่จัดเก็บไฟล์ไม่พร้อมใช้งาน กรุณาติดต่อครู");
  }
}

export async function ensureUploadRoot() {
  const root = uploadRoot();
  await mkdir(root, { recursive: true, mode: 0o750 });
  const thumbnails = resolve(root, "thumbnails");
  await mkdir(thumbnails, { recursive: true, mode: 0o750 });
  const entries = await readdir(root, { withFileTypes: true });
  const { sql } = await import("./db/client");
  const records = await sql<{ storageName: string; id: string; thumbnailSizeBytes: number | null; thumbnailMediaType: "image/png" | "image/webp" | null }[]>`
    SELECT storage_name AS "storageName", id, thumbnail_size_bytes AS "thumbnailSizeBytes", thumbnail_media_type AS "thumbnailMediaType" FROM classroom.files
    UNION ALL SELECT storage_name AS "storageName", id, NULL::bigint AS "thumbnailSizeBytes", NULL::text AS "thumbnailMediaType" FROM classroom.lesson_page_images
  `;
  const referenced = new Set(records.map((record) => record.storageName));
  const referencedThumbnails = new Set(records.filter((record) => record.thumbnailSizeBytes !== null && record.thumbnailMediaType).map((record) => record.id + (record.thumbnailMediaType === "image/webp" ? ".webp" : ".png")));
  const expired = Date.now() - 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = resolve(root, entry.name);
    const fileStat = await stat(path);
    if (fileStat.mtimeMs > expired) continue;
    if (/^[0-9a-f-]{36}\.deleting$/.test(entry.name)) {
      const storedName = entry.name.slice(0, -".deleting".length);
      if (referenced.has(storedName)) {
        const original = resolve(root, storedName);
        try { await access(original); } catch { await rename(path, original); }
      } else await rm(path, { force: true });
    } else if (/^[0-9a-f-]{36}(?:\.upload)?$/.test(entry.name) && !referenced.has(entry.name)) {
      await rm(path, { force: true });
    }
  }
  for (const entry of await readdir(thumbnails, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = resolve(thumbnails, entry.name);
    const fileStat = await stat(path);
    if (fileStat.mtimeMs > expired) continue;
    const deleting = entry.name.match(/^([0-9a-f-]{36}\.(?:png|webp))\.deleting$/);
    if (deleting) {
      const name = deleting[1];
      if (referencedThumbnails.has(name)) {
        try { await access(resolve(thumbnails, name)); } catch { await rename(path, resolve(thumbnails, name)); }
      } else await rm(path, { force: true });
    } else if (/^[0-9a-f-]{36}\.(?:png|webp)(?:\.upload)?$/.test(entry.name) && !referencedThumbnails.has(entry.name)) {
      await rm(path, { force: true });
    }
  }
}

export async function cleanupUnusedLessonImages() {
  const { sql } = await import("./db/client");
  const root = uploadRoot();
  const staged: { id: string; original: string; tombstone: string }[] = [];
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(870010022)`;
      const unused = await tx<{ id: string; storageName: string }[]>`
        SELECT i.id, i.storage_name AS "storageName" FROM classroom.lesson_page_images i
        WHERE i.created_at < NOW() - INTERVAL '24 hours'
          AND NOT EXISTS (
            SELECT 1 FROM classroom.lesson_pages l
            WHERE l.id = i.lesson_id AND (
              EXISTS (SELECT 1 FROM jsonb_array_elements(l.draft_blocks) b WHERE b->>'type' = 'image' AND b->>'imageId' = i.id::text)
              OR (l.published_blocks IS NOT NULL AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(l.published_blocks) b WHERE b->>'type' = 'image' AND b->>'imageId' = i.id::text
              ))
            )
          ) FOR UPDATE OF i
      `;
      for (const image of unused) {
        const original = resolve(root, image.storageName); const tombstone = original + ".deleting";
        try { await rename(original, tombstone); staged.push({ id: image.id, original, tombstone }); }
        catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
      }
      if (unused.length) await tx`DELETE FROM classroom.lesson_page_images WHERE id = ANY(${unused.map((image) => image.id)}::uuid[])`;
    });
  } catch (error) {
    for (const item of staged) {
      const [record] = await sql`SELECT id FROM classroom.lesson_page_images WHERE id = ${item.id}`.catch(() => []);
      if (record) await rename(item.tombstone, item.original).catch(() => {});
      else await rm(item.tombstone, { force: true }).catch(() => {});
    }
    throw error;
  }
  for (const item of staged) await rm(item.tombstone, { force: true }).catch(() => {});
}

export async function validateUpload(file: File, kind: UploadKind) {
  if (file.size < 1 || file.size > maxUploadBytes()) throw new HttpError(413, "ไฟล์ต้องมีขนาดไม่เกิน " + Math.floor(maxUploadBytes() / (1024 * 1024)) + " MB");
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const type = FILE_TYPES[extension];
  if (!type || type.kind !== kind) throw new HttpError(422, "ชนิดไฟล์ไม่ตรงกับประเภทที่เลือก");

  const header = new Uint8Array(await file.slice(0, 84).arrayBuffer());
  const signature = new TextDecoder().decode(header.slice(0, 8));
  if (extension === "pdf" && !signature.startsWith("%PDF-")) throw new HttpError(422, "ไฟล์ PDF ไม่ถูกต้อง");
  if (extension === "png" && !(header[0] === 137 && signature.slice(1, 4) === "PNG")) throw new HttpError(422, "ไฟล์รูปภาพไม่ถูกต้อง");
  if ((extension === "jpg" || extension === "jpeg") && !(header[0] === 255 && header[1] === 216 && header[2] === 255)) throw new HttpError(422, "ไฟล์รูปภาพไม่ถูกต้อง");
  if (extension === "doc" && ![0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((byte, index) => header[index] === byte)) throw new HttpError(422, "ไฟล์ Word ไม่ถูกต้อง");
  if (extension === "docx" && !(header[0] === 80 && header[1] === 75)) throw new HttpError(422, "ไฟล์ Word ไม่ถูกต้อง");
  if (extension === "stl" && !isStl(header, file.size)) throw new HttpError(422, "ไฟล์ STL ไม่ถูกต้อง");
  if (extension === "obj" && !await isObj(file)) throw new HttpError(422, "ไฟล์ OBJ ไม่ถูกต้อง");

  const safeName = file.name.replace(/[\\/\0-\x1f\x7f]/g, "_").trim().slice(-255);
  if (!safeName) throw new HttpError(422, "กรุณาตรวจสอบชื่อไฟล์");
  return { mediaType: type.mediaType, originalName: safeName };
}

export async function validateStudentUpload(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const type = FILE_TYPES[extension];
  if (!type) throw new HttpError(422, "ไม่รองรับชนิดไฟล์นี้");
  return { ...(await validateUpload(file, type.kind)), kind: type.kind };
}

function isStl(header: Uint8Array, size: number) {
  const prefix = new TextDecoder().decode(header.slice(0, 5)).toLowerCase();
  if (prefix === "solid") return true;
  if (header.length < 84) return false;
  const triangles = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(80, true);
  return 84 + triangles * 50 === size;
}

async function isObj(file: File) {
  const text = (await file.slice(0, 65536).text()).replace(/^\uFEFF/, "");
  let vertex = false;
  let face = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*v\s+-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+(?:\s|$)/.test(line)) vertex = true;
    if (/^\s*f\s+\S+\s+\S+\s+\S+/.test(line)) face = true;
    if (vertex && face) return true;
  }
  return false;
}

function blenderHeader(bytes: Uint8Array) {
  const prefix = new TextDecoder().decode(bytes.subarray(0, 7));
  if (prefix !== "BLENDER") return false;
  if ((bytes[7] === 45 || bytes[7] === 95) && (bytes[8] === 118 || bytes[8] === 86)) {
    return bytes.length >= 12 && /^\d{3}$/.test(new TextDecoder().decode(bytes.subarray(9, 12)));
  }
  return bytes.length >= 17 && new TextDecoder().decode(bytes.subarray(7, 13)) === "17-01v"
    && /^\d{4}$/.test(new TextDecoder().decode(bytes.subarray(13, 17)));
}

type DecompressStream = {
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "end", listener: () => void): void;
  end(bytes: Uint8Array): void;
  destroy(): void;
};

async function compressedBlenderHeader(bytes: Uint8Array, compression: "gzip" | "zstd") {
  let stream: DecompressStream;
  if (compression === "gzip") stream = createGunzip({ chunkSize: 64 * 1024 });
  else {
    const zstd = (await import("node:zlib") as unknown as {
      createZstdDecompress?: (options: { chunkSize: number }) => DecompressStream;
    }).createZstdDecompress;
    if (!zstd) throw new HttpError(422, "รันไทม์นี้ยังไม่รองรับไฟล์ Blender แบบ Zstandard");
    stream = zstd({ chunkSize: 64 * 1024 });
  }

  return new Promise<boolean>((resolveHeader) => {
    let header = Buffer.alloc(0);
    let finished = false;
    const timeout = setTimeout(() => finish(false), 2000);
    const finish = (valid: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      stream.destroy();
      resolveHeader(valid);
    };
    stream.on("data", (chunk) => {
      header = Buffer.concat([header, chunk.subarray(0, 17 - header.length)]);
      if (blenderHeader(header)) finish(true);
      else if (header.length >= 17) finish(false);
    });
    stream.on("error", () => finish(false));
    stream.on("end", () => finish(blenderHeader(header)));
    stream.end(bytes);
  });
}

export async function validateWorkingFile(file: File) {
  if (file.size < 1 || file.size > maxUploadBytes()) {
    throw new HttpError(413, "ไฟล์ต้องมีขนาดไม่เกิน " + Math.floor(maxUploadBytes() / (1024 * 1024)) + " MB");
  }
  if (file.name.split(".").pop()?.toLowerCase() !== "blend") throw new HttpError(422, "รองรับเฉพาะไฟล์ Blender .blend");

  const prefix = new Uint8Array(await file.slice(0, 17).arrayBuffer());
  let valid = blenderHeader(prefix);
  if (!valid) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) valid = await compressedBlenderHeader(bytes, "gzip");
    else if (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) {
      valid = await compressedBlenderHeader(bytes, "zstd");
    }
  }
  if (!valid) throw new HttpError(422, "ไฟล์ Blender ไม่ถูกต้อง");
  const originalName = file.name.replace(/[\\/\0-\x1f\x7f]/g, "_").trim().slice(-255);
  if (!originalName) throw new HttpError(422, "กรุณาตรวจสอบชื่อไฟล์");
  return { mediaType: "application/octet-stream", originalName };
}

export async function saveStudentWorkingFile(input: {
  classroomId: string; assignmentId: string; studentId: string; accountId: string;
  file: File; originalName: string; expectedFileId: string | null;
}) {
  const root = uploadRoot();
  await mkdir(root, { recursive: true, mode: 0o750 });
  const id = randomUUID();
  const storageName = id;
  const temporary = resolve(root, id + ".upload");
  const path = resolve(root, storageName);
  const { sql } = await import("./db/client");
  let renamedNew = false;
  let oldTombstone: string | null = null;
  let oldStorageName: string | null = null;
  try {
    await Bun.write(temporary, input.file);
    const [result] = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(870010022)`;
      const [membership] = await tx<{ id: string }[]>`
        SELECT s.id FROM classroom.students s
        JOIN classroom.classrooms c ON c.id = s.classroom_id
        JOIN classroom.assignments a ON a.classroom_id = c.id
        WHERE s.id = ${input.studentId} AND s.account_id = ${input.accountId}
          AND s.classroom_id = ${input.classroomId} AND s.archived_at IS NULL
          AND c.archived_at IS NULL AND a.id = ${input.assignmentId} AND a.archived_at IS NULL
        FOR SHARE OF s, c, a
      `;
      if (!membership) throw new HttpError(404, "ไม่พบงานนี้");
      const [existing] = await tx<{ id: string; storageName: string; sizeBytes: number; thumbnailSizeBytes: number | null }[]>`
        SELECT id, storage_name AS "storageName", size_bytes AS "sizeBytes", thumbnail_size_bytes AS "thumbnailSizeBytes"
        FROM classroom.files WHERE classroom_id = ${input.classroomId} AND assignment_id = ${input.assignmentId}
          AND student_id = ${input.studentId} AND kind = 'working' FOR UPDATE
      `;
      if ((existing?.id ?? null) !== input.expectedFileId) throw new HttpError(409, "ไฟล์ทำงานเปลี่ยนไปแล้ว กรุณาโหลดข้อมูลใหม่");
      const [usage] = await tx<{ used: string }[]>`
          SELECT ((SELECT COALESCE(SUM(size_bytes + COALESCE(thumbnail_size_bytes, 0)), 0) FROM classroom.files) +
            (SELECT COALESCE(SUM(size_bytes), 0) FROM classroom.lesson_page_images))::text AS used
      `;
      const currentSize = Number(existing?.sizeBytes ?? 0) + Number(existing?.thumbnailSizeBytes ?? 0);
      if (Number(usage.used) - currentSize + input.file.size > maxStoredBytes()) {
        throw new HttpError(413, "พื้นที่จัดเก็บไฟล์เต็มแล้ว");
      }

      await rename(temporary, path);
      renamedNew = true;
      if (existing) {
        oldStorageName = existing.storageName;
        const oldPath = resolve(root, existing.storageName);
        oldTombstone = oldPath + ".deleting";
        try { await rename(oldPath, oldTombstone); }
        catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
          oldTombstone = null;
        }
        await tx`DELETE FROM classroom.files WHERE id = ${existing.id}`;
      }
      await tx`
        INSERT INTO classroom.files
          (id, classroom_id, assignment_id, student_id, submitted_by_account_id, uploaded_by,
            kind, original_name, storage_name, media_type, size_bytes)
        VALUES (${id}, ${input.classroomId}, ${input.assignmentId}, ${input.studentId},
          NULL, NULL, 'working', ${input.originalName}, ${storageName}, 'application/octet-stream', ${input.file.size})
      `;
      return [{ id, originalName: input.originalName, mediaType: "application/octet-stream", sizeBytes: input.file.size }];
    });
    const cleanupPending = oldTombstone ? await rm(oldTombstone, { force: true }).then(() => false, () => true) : false;
    return { ...result, cleanupPending };
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    try {
      const records = await sql<{ id: string }[]>`SELECT id FROM classroom.files WHERE id = ${id} OR id = ${input.expectedFileId}`;
      const newRecord = records.some((record) => record.id === id);
      const oldRecord = input.expectedFileId !== null && records.some((record) => record.id === input.expectedFileId);
      if (oldTombstone) {
        if (oldRecord && oldStorageName) await rename(oldTombstone, resolve(root, oldStorageName)).catch(() => {});
        else await rm(oldTombstone, { force: true }).catch(() => {});
      }
      if (renamedNew && !newRecord) await rm(path, { force: true }).catch(() => {});
    } catch { /* Startup reconciliation restores referenced tombstones and removes orphaned uploads. */ }
    throw error;
  }
}

export async function deleteStoredFile(fileId: string, scope: { teacherId: string } | { studentAccountId: string }) {
  const root = uploadRoot();
  const teacherId = "teacherId" in scope ? scope.teacherId : null;
  const studentAccountId = "studentAccountId" in scope ? scope.studentAccountId : null;
  const staged: { path: string; tombstone: string }[] = [];
  const { sql } = await import("./db/client");
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(870010022)`;
      const [file] = await tx<{ storageName: string; thumbnailMediaType: "image/png" | "image/webp" | null }[]>`
        SELECT f.storage_name AS "storageName", f.thumbnail_media_type AS "thumbnailMediaType"
        FROM classroom.files f JOIN classroom.classrooms c ON c.id = f.classroom_id
        WHERE f.id = ${fileId} AND (
          (${teacherId}::uuid IS NOT NULL AND c.owner_id = ${teacherId})
          OR (${studentAccountId}::uuid IS NOT NULL AND f.kind = 'working'
            AND c.archived_at IS NULL
            AND EXISTS (SELECT 1 FROM classroom.students s JOIN classroom.assignments a ON a.id = f.assignment_id
              WHERE s.id = f.student_id AND s.account_id = ${studentAccountId}
                AND s.classroom_id = f.classroom_id AND s.archived_at IS NULL AND a.archived_at IS NULL))
        ) FOR UPDATE OF f
      `;
      if (!file) throw new HttpError(404, "ไม่พบไฟล์นี้");
      const paths = [resolve(root, file.storageName), ...(file.thumbnailMediaType ? [uploadThumbnailPath(fileId, file.thumbnailMediaType)] : [])];
      for (const path of paths) {
        const tombstone = path + ".deleting";
        staged.push({ path, tombstone });
        try { await rename(path, tombstone); }
        catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
        }
      }
      await tx`DELETE FROM classroom.files WHERE id = ${fileId}`;
    });
  } catch (error) {
    try {
      const [record] = await sql`SELECT id FROM classroom.files WHERE id = ${fileId}`;
      for (const file of staged) {
        if (record) await rename(file.tombstone, file.path).catch(() => {});
        else await rm(file.tombstone, { force: true }).catch(() => {});
      }
    } catch { /* Startup reconciliation resolves staged files if the transaction result is unknown. */ }
    throw error;
  }
  const cleanup = await Promise.all(staged.map((file) => rm(file.tombstone, { force: true }).then(() => false, () => true)));
  return { ok: true, cleanupPending: cleanup.some(Boolean) };
}
