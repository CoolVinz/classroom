import { basename } from "node:path";
import { JWT } from "google-auth-library";
import sharp from "sharp";
import { maxUploadBytes } from "./file-storage";
import { HttpError } from "./http-error";

const driveIdPattern = /^[A-Za-z0-9_-]{1,200}$/;
const driveScope = "https://www.googleapis.com/auth/drive.readonly";
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const driveTimeout = 8_000;
let driveClient: JWT | undefined;
const pendingImages = new Map<string, Promise<{ name: string; bytes: Buffer }>>();
const driveWorkers = Array.from({ length: 4 }, () => Promise.resolve());
let nextWorker = 0;

export function lessonImageName(name: string) {
  return basename(name).replace(/[\\/\0-\x1f\x7f]/g, "_").trim().slice(-255) || "image";
}

export async function optimizeLessonImage(input: Buffer) {
  let image: Buffer;
  try {
    const processor = sharp(input, { failOn: "error", limitInputPixels: 40_000_000 });
    const metadata = await processor.metadata();
    if (!metadata.width || !metadata.height || (metadata.pages ?? 1) > 1 || !["jpeg", "png", "webp"].includes(metadata.format ?? "")) {
      throw new Error("unsupported image");
    }
    image = await processor.rotate().resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 }).toBuffer();
  } catch {
    throw new HttpError(422, "รองรับภาพ PNG, JPEG หรือ WebP ที่เปิดได้เท่านั้น");
  }
  if (image.byteLength > maxUploadBytes()) throw new HttpError(413, "ภาพหลังปรับขนาดมีขนาดเกินกำหนด");
  return image;
}

export function driveImageId(link: string) {
  const url = URL.canParse(link) ? new URL(link) : null;
  if (!url || url.origin !== "https://drive.google.com" || url.username || url.password) return null;
  const id = /^\/file\/d\/([A-Za-z0-9_-]+)(?:\/view)?\/?$/.exec(url.pathname)?.[1]
    ?? (url.pathname === "/open" ? url.searchParams.get("id") : null);
  return id && driveIdPattern.test(id) ? id : null;
}

export function lessonDriveEnabled() {
  return Boolean(process.env.LESSON_DRIVE_SERVICE_ACCOUNT_JSON?.trim() && driveIdPattern.test(process.env.LESSON_DRIVE_FOLDER_ID ?? ""));
}

export async function readDriveLessonImage(fileId: string) {
  const folderId = process.env.LESSON_DRIVE_FOLDER_ID ?? "";
  if (!lessonDriveEnabled()) throw new HttpError(503, "ยังไม่ได้ตั้งค่า Google Drive สำหรับบทเรียน");
  if (!driveIdPattern.test(fileId)) throw new HttpError(422, "ลิงก์รูปจาก Google Drive ไม่ถูกต้อง");
  const key = `${folderId}/${fileId}`;
  const pending = pendingImages.get(key);
  if (pending) return pending;
  if (pendingImages.size >= 100) throw new HttpError(503, "มีการโหลดรูปจาก Google Drive หลายรายการ กรุณาลองอีกครั้ง");
  const slot = nextWorker;
  nextWorker = (nextWorker + 1) % driveWorkers.length;
  const queuedAt = Date.now();
  const result = driveWorkers[slot].then(() => {
    if (Date.now() - queuedAt >= driveTimeout) throw new HttpError(503, "รอโหลดรูปจาก Google Drive นานเกินไป กรุณาลองอีกครั้ง");
    return fetchDriveImage(folderId, fileId);
  }).finally(() => pendingImages.delete(key));
  driveWorkers[slot] = result.then(() => {}, () => {});
  pendingImages.set(key, result);
  return result;
}

async function fetchDriveImage(folderId: string, fileId: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), driveTimeout);
  const signal = controller.signal;
  try {
    if (!driveClient) {
      const credentials = JSON.parse(process.env.LESSON_DRIVE_SERVICE_ACCOUNT_JSON ?? "{}");
      if (credentials.type !== "service_account" || typeof credentials.client_email !== "string" || typeof credentials.private_key !== "string") {
        throw new Error("invalid Drive configuration");
      }
      driveClient = new JWT({
        email: credentials.client_email, key: credentials.private_key, scopes: [driveScope],
        transporterOptions: { timeout: driveTimeout, retry: false },
      });
    }
    const { token } = await driveClient.getAccessToken();
    if (!token) throw new Error("Drive authorization unavailable");
    const endpoint = `https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`;
    const options: RequestInit = { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal };
    const metadata = await fetch(endpoint + "&fields=name,mimeType,parents,trashed,size,capabilities(canDownload)", options);
    if (metadata.status === 403 || metadata.status === 404) throw new HttpError(404, "เปิดรูปไม่ได้ กรุณาตรวจสอบสิทธิ์และโฟลเดอร์ Google Drive");
    if (!metadata.ok) throw new Error("Drive metadata unavailable");
    const image = await metadata.json() as { name: string; mimeType: string; parents?: string[]; trashed?: boolean; size?: string; capabilities?: { canDownload?: boolean } };
    if (image.trashed || !image.parents?.includes(folderId) || !image.capabilities?.canDownload) {
      throw new HttpError(404, "รูปต้องอยู่ในโฟลเดอร์ Google Drive สำหรับบทเรียนและอนุญาตให้ดาวน์โหลด");
    }
    if (!imageTypes.has(image.mimeType)) throw new HttpError(422, "รองรับรูป PNG, JPEG หรือ WebP จาก Google Drive เท่านั้น");
    const limit = Math.min(maxUploadBytes(), 10 * 1024 * 1024);
    if (Number(image.size) > limit) throw new HttpError(413, "ไฟล์ภาพจาก Google Drive มีขนาดเกินกำหนด");
    const response = await fetch(endpoint + "&alt=media", options);
    if (response.status === 403 || response.status === 404) throw new HttpError(404, "ดาวน์โหลดรูปจาก Google Drive ไม่ได้");
    if (!response.ok || !response.body) throw new Error("Drive download unavailable");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        controller.abort();
        throw new HttpError(413, "ไฟล์ภาพจาก Google Drive มีขนาดเกินกำหนด");
      }
      chunks.push(value);
    }
    return { name: lessonImageName(image.name), bytes: await optimizeLessonImage(Buffer.concat(chunks, bytes)) };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "Google Drive ไม่พร้อมใช้งาน กรุณาลองอีกครั้ง");
  } finally {
    clearTimeout(timeout);
  }
}
