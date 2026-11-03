import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { storedFilePath, validateStudentUpload, validateThumbnail, validateUpload } from "./file-storage";

function pngChunk(type: string, data: Buffer) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0); chunk.write(type, 4); data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, data.length + 8)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
  return chunk;
}

function thumbnailPng(width = 256, height = 192, compressed?: Buffer) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(height * (width * 4 + 1));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", compressed ?? deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0))]);
}

describe("stored upload access", () => {
  test("returns a readable file, a clear missing-file 404, and a storage 503", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "classroom-stored-file-"));
    const oldUploadDir = process.env.UPLOAD_DIR;
    process.env.UPLOAD_DIR = root;
    try {
      await writeFile(resolve(root, "present"), "student work");
      expect(await storedFilePath("present")).toBe(resolve(root, "present"));
      await expect(storedFilePath("missing")).rejects.toMatchObject({ status: 404 });
      await mkdir(resolve(root, "not-a-file"));
      await expect(storedFilePath("not-a-file")).rejects.toMatchObject({ status: 503 });
      process.env.UPLOAD_DIR = resolve(root, "unmounted");
      await expect(storedFilePath("present")).rejects.toMatchObject({ status: 503 });
    } finally {
      if (oldUploadDir === undefined) delete process.env.UPLOAD_DIR;
      else process.env.UPLOAD_DIR = oldUploadDir;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("file upload validation", () => {
  test("accepts bounded 256 by 192 PNG thumbnails and rejects other dimensions", async () => {
    await expect(validateThumbnail(new File([thumbnailPng()], "thumb.png", { type: "image/png" }))).resolves.toBeInstanceOf(Uint8Array);
    await expect(validateThumbnail(new File([thumbnailPng(512, 384)], "thumb.png", { type: "image/png" }))).rejects.toThrow("ไม่ถูกต้อง");
    await expect(validateThumbnail(new File([thumbnailPng(256, 192, Buffer.from("not a zlib stream"))], "thumb.png", { type: "image/png" }))).rejects.toThrow("ไม่ถูกต้อง");
    const brokenCrc = thumbnailPng(); brokenCrc[brokenCrc.length - 1] ^= 1;
    await expect(validateThumbnail(new File([brokenCrc], "thumb.png", { type: "image/png" }))).rejects.toThrow("ไม่ถูกต้อง");
    await expect(validateThumbnail(new File([new Uint8Array(256 * 1024 + 1)], "thumb.png", { type: "image/png" }))).rejects.toThrow("256 KB");
  });

  test("accepts a PDF worksheet by its content signature", async () => {
    const file = new File(["%PDF-1.7\nworksheet"], "lesson.pdf", { type: "text/plain" });
    await expect(validateUpload(file, "worksheet")).resolves.toEqual({ mediaType: "application/pdf", originalName: "lesson.pdf" });
  });

  test("rejects a renamed script and a model uploaded as a worksheet", async () => {
    await expect(validateUpload(new File(["<script>"], "lesson.pdf"), "worksheet")).rejects.toThrow("PDF");
    await expect(validateUpload(new File(["solid model"], "model.stl"), "worksheet")).rejects.toThrow("ประเภท");
  });

  test("sanitizes path separators from the original filename", async () => {
    const file = new File(["%PDF-1.7"], "../lesson.pdf");
    await expect(validateUpload(file, "worksheet")).resolves.toMatchObject({ originalName: ".._lesson.pdf" });
  });

  test("accepts legacy Word signature and bounded STL/OBJ files", async () => {
    const doc = new File([Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])], "lesson.doc");
    await expect(validateUpload(doc, "worksheet")).resolves.toMatchObject({ mediaType: "application/msword" });
    await expect(validateUpload(new File(["solid test\nendsolid test"], "model.stl"), "model")).resolves.toMatchObject({ mediaType: "model/stl" });
    await expect(validateUpload(new File(["v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3"], "model.obj"), "model")).resolves.toMatchObject({ mediaType: "model/obj" });
  });

  test("detects supported student submission types without a client-selected kind", async () => {
    const pdf = await validateStudentUpload(new File(["%PDF-1.7"], "work.pdf"));
    const model = await validateStudentUpload(new File(["solid test"], "work.stl"));
    expect(pdf.kind).toBe("worksheet");
    expect(model.kind).toBe("model");
    await expect(validateStudentUpload(new File(["nope"], "run.exe"))).rejects.toThrow("ไม่รองรับ");
  });

  test("enforces an explicitly configured upload limit", async () => {
    const oldLimit = process.env.UPLOAD_MAX_FILE_BYTES;
    process.env.UPLOAD_MAX_FILE_BYTES = "4";
    try { await expect(validateUpload(new File(["12345"], "lesson.pdf"), "worksheet")).rejects.toThrow("ไม่เกิน"); }
    finally { if (oldLimit === undefined) delete process.env.UPLOAD_MAX_FILE_BYTES; else process.env.UPLOAD_MAX_FILE_BYTES = oldLimit; }
  });
});
