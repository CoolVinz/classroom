import { useEffect, useRef, useState } from "react";

export type LessonImage = { id: string; originalName: string; sizeBytes: number | string | null; source: "upload" | "drive" };
export type LessonImageInput = File | string;

export function LessonImagePreview({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [failedSrc, setFailedSrc] = useState<string>();
  return failedSrc === src
    ? <span className="lesson-image-placeholder" role="img" aria-label={alt || "รูปภาพไม่พร้อมใช้งาน"}>รูปภาพไม่พร้อมใช้งาน</span>
    : <img className={className} src={src} alt={alt} loading="lazy" onError={() => setFailedSrc(src)} />;
}

export function LessonImagePicker({ images, imageUrl, driveEnabled, onAdd, onChoose, onClose, replacing, initialFile, describeImage }: {
  images: LessonImage[];
  imageUrl: (id: string) => string;
  driveEnabled: boolean;
  onAdd: (input: LessonImageInput, signal: AbortSignal) => Promise<LessonImage>;
  onChoose: (image: LessonImage, alt: string) => void;
  onClose: () => void;
  replacing: boolean;
  initialFile?: File;
  describeImage?: boolean;
}) {
  const [alt, setAlt] = useState("");
  const [link, setLink] = useState("");
  const [file, setFile] = useState(initialFile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const action = replacing ? "เปลี่ยนรูปภาพ" : "แทรกรูปภาพ";

  useEffect(() => {
    closeButton.current?.focus();
    return () => request.current?.abort();
  }, []);

  async function add(input: LessonImageInput) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const image = await onAdd(input, controller.signal);
      if (!controller.signal.aborted) onChoose(image, alt);
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "เพิ่มรูปภาพไม่สำเร็จ");
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <section className="lesson-image-picker panel" aria-label={action} onKeyDown={(event) => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); }
  }}>
    <div className="lesson-image-picker-header"><strong>{action}</strong><button ref={closeButton} className="text-button" onClick={onClose}>ปิดตัวเลือกรูป</button></div>
    {describeImage && !replacing && <label>คำอธิบายภาพ (ไม่บังคับ)<input value={alt} disabled={busy} maxLength={300} onChange={(event) => setAlt(event.target.value)} /></label>}
    <form className="lesson-image-picker-row" onSubmit={(event) => { event.preventDefault(); if (file) void add(file); }}>
      <label>ไฟล์รูปภาพ<input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={(event) => setFile(event.target.files?.[0])} /></label>
      {initialFile === file && file && <span className="muted">{file.name}</span>}
      <button className="button button-quiet" disabled={busy || !file}>อัปโหลดและ{action}</button>
    </form>
    {driveEnabled && <form className="lesson-image-picker-row" onSubmit={(event) => { event.preventDefault(); if (link.trim()) void add(link.trim()); }}>
      <label>ลิงก์รูปจาก Google Drive<input type="url" placeholder="https://drive.google.com/file/d/…/view" value={link} maxLength={2048} disabled={busy} onChange={(event) => setLink(event.target.value)} /></label>
      <button className="button button-quiet" disabled={busy || !link.trim()}>ใช้ลิงก์จาก Drive</button>
    </form>}
    {busy && <p className="muted" role="status">กำลังเพิ่มรูปภาพ…</p>}
    {error && <p className="notice" role="alert">{error}</p>}
    {images.length > 0 && <div className="lesson-image-picker-grid" aria-label="รูปภาพในบทเรียนนี้">{images.map((image) =>
      <button className="lesson-image-option" key={image.id} disabled={busy} title={image.originalName} onClick={() => onChoose(image, alt)}>
        <LessonImagePreview src={imageUrl(image.id)} alt="" /><span>{image.originalName}</span>
        {image.source === "drive" && <small>Google Drive</small>}
      </button>
    )}</div>}
  </section>;
}
