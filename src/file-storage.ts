import { access, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
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

export async function ensureUploadRoot() {
  const root = uploadRoot();
  await mkdir(root, { recursive: true, mode: 0o750 });
  const entries = await readdir(root, { withFileTypes: true });
  const { sql } = await import("./db/client");
  const records = await sql<{ storageName: string }[]>`SELECT storage_name AS "storageName" FROM classroom.files`;
  const referenced = new Set(records.map((record) => record.storageName));
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
