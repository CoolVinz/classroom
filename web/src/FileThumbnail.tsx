import { useEffect, useRef, useState, type Ref } from "react";
import { generateThumbnail } from "./thumbnail-jobs";

type ThumbnailFile = { id: string; originalName: string; kind: "worksheet" | "model" | "submission"; mediaType: string; thumbnailAvailable?: boolean };

export function FileThumbnail({ file, onPreview, student = false }: { file: ThumbnailFile; onPreview: () => void; student?: boolean }) {
  const element = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [source, setSource] = useState("");
  const [failed, setFailed] = useState(false);
  const [hasThumbnail, setHasThumbnail] = useState(file.thumbnailAvailable ?? false);
  const [generating, setGenerating] = useState(false);
  const model = file.mediaType.startsWith("model/");
  const image = file.mediaType.startsWith("image/");
  const apiPath = (student ? "/student/files/" : "/files/") + file.id;
  const path = "/api" + apiPath + "/content";
  const thumbnailPath = apiPath + "/thumbnail";
  const thumbnailUrl = "/api" + thumbnailPath;

  useEffect(() => {
    if ((!model && !image) || !element.current) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "150px" });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [model, image, file.id]);

  useEffect(() => {
    if ((!model && !image) || !visible || hasThumbnail || failed) return;
    const controller = new AbortController();
    setGenerating(true);
    void generateThumbnail(file, path, thumbnailPath, controller.signal)
      .then((blob) => { if (!controller.signal.aborted) { setSource(URL.createObjectURL(blob)); setHasThumbnail(true); } })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setGenerating(false); });
    return () => controller.abort();
  }, [model, image, visible, hasThumbnail, failed, file.id, file.originalName, file.mediaType, path, thumbnailPath]);

  useEffect(() => () => { if (source) URL.revokeObjectURL(source); }, [source]);
  useEffect(() => { setVisible(false); setSource(""); setFailed(false); setHasThumbnail(file.thumbnailAvailable ?? false); }, [file.id]);

  const thumbnail = source || (hasThumbnail ? thumbnailUrl : "");
  const preview = thumbnail ? <img src={thumbnail} alt={"ตัวอย่าง " + file.originalName} loading="lazy" decoding="async" onError={() => { setHasThumbnail(false); if (source) setFailed(true); }}/> : <span>{model ? "3D" : "IMG"}<small>{failed ? "ไม่มีภาพตัวอย่าง" : generating ? "กำลังสร้างภาพ…" : model ? "ตัวอย่างโมเดล" : "ตัวอย่างรูปภาพ"}</small></span>;
  if (model) return <button ref={element as Ref<HTMLButtonElement>} type="button" className="work-thumbnail" onClick={onPreview} aria-label={"แสดงตัวอย่าง " + file.originalName} title={failed ? "สร้างภาพตัวอย่างไม่สำเร็จ · คลิกเพื่อเปิดโมเดล" : "คลิกเพื่อเปิดโมเดล"}>{preview}</button>;
  if (image) return <a ref={element as Ref<HTMLAnchorElement>} className="work-thumbnail" href={path} target="_blank" rel="noreferrer" aria-label={"เปิดภาพ " + file.originalName}>{preview}</a>;
  return <span className="file-kind">{file.mediaType.includes("word") ? "DOC" : "PDF"}</span>;
}
