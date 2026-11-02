import { useEffect, useRef, useState } from "react";

type ThumbnailFile = { id: string; originalName: string; kind: "worksheet" | "model" | "submission"; mediaType: string };

export function FileThumbnail({ file, onPreview }: { file: ThumbnailFile; onPreview: () => void }) {
  const element = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [source, setSource] = useState("");
  const [failed, setFailed] = useState(false);
  const model = file.kind === "model";
  const image = file.mediaType.startsWith("image/");
  const path = "/api/files/" + file.id + "/content";

  useEffect(() => {
    if (!model || !element.current) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "150px" });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [model]);

  useEffect(() => {
    if (!model || !visible || source || failed) return;
    const controller = new AbortController();
    void import("./model-view").then(({ renderModelThumbnail }) => renderModelThumbnail(file, path, controller.signal))
      .then((url) => { if (!controller.signal.aborted) setSource(url); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [model, visible, source, failed, file.id, file.originalName, path]);

  if (model) return <button ref={element} type="button" className="work-thumbnail" onClick={onPreview} aria-label={"แสดงตัวอย่าง " + file.originalName} title={failed ? "สร้างภาพตัวอย่างไม่สำเร็จ · คลิกเพื่อเปิดโมเดล" : "คลิกเพื่อเปิดโมเดล"}>
    {source ? <img src={source} alt={"ตัวอย่าง " + file.originalName}/> : <span>3D<small>{failed ? "ไม่มีภาพตัวอย่าง" : visible ? "กำลังสร้างภาพ…" : "ตัวอย่างโมเดล"}</small></span>}
  </button>;
  if (image) return <a className="work-thumbnail" href={path} target="_blank" rel="noreferrer" aria-label={"เปิดภาพ " + file.originalName}>
    {failed ? <span>IMG<small>ไม่มีภาพตัวอย่าง</small></span> : <img src={path} alt={"ตัวอย่าง " + file.originalName} loading="lazy" decoding="async" onError={() => setFailed(true)}/>}
  </a>;
  return <span className="file-kind">{file.mediaType.includes("word") ? "DOC" : "PDF"}</span>;
}
