import { useEffect, useRef, useState } from "react";
import { createCodeLessonDocument, imageDataUrl, lessonImageIds, type CodeBlock } from "./code-lesson";
import { LessonImagePicker, type LessonImage, type LessonImageInput } from "./LessonImagePicker";
import { findImageSource, lessonImageTag, type SourceRange } from "./lesson-image-source";

type Field = "html" | "css" | "javascript";
type ImageTarget = SourceRange & { field: Field; source: string; replacing: boolean; file?: File };

export function CodeLessonEditor({ code, images, imageUrl, driveEnabled, onChange, onAdd }: {
  code: CodeBlock;
  images: LessonImage[];
  imageUrl: (id: string) => string;
  driveEnabled: boolean;
  onChange: (update: (code: CodeBlock) => CodeBlock) => void;
  onAdd: (input: LessonImageInput, signal: AbortSignal) => Promise<LessonImage>;
}) {
  const [field, setField] = useState<Field>("html");
  const [target, setTarget] = useState<ImageTarget | null>(null);
  const [notice, setNotice] = useState("");
  const editor = useRef<HTMLTextAreaElement>(null);

  function openImages(replacing: boolean, file?: File) {
    const source = code[field];
    const start = editor.current?.selectionStart ?? source.length;
    const end = editor.current?.selectionEnd ?? start;
    const range = replacing ? findImageSource(source, { start, end }) : { start: end, end };
    if (!range || range === "responsive") {
      setNotice(range === "responsive" ? "รูปนี้ใช้ srcset หรือ <picture> กรุณาแก้แหล่งรูปใน HTML โดยตรง" : "วางเคอร์เซอร์ในแท็ก <img> ที่มี src แล้วลองอีกครั้ง");
      return;
    }
    setNotice("");
    setTarget({ ...range, field, source, replacing, file });
  }

  function useImage(image: LessonImage, alt: string) {
    if (!target) return;
    const node = editor.current;
    setTarget(null);
    if (!node || node.value !== target.source) {
      setNotice("โค้ดเปลี่ยนระหว่างเพิ่มรูป กรุณาเลือกตำแหน่งอีกครั้ง แล้วเลือกรูปจากรายการ");
      return;
    }
    const marker = `lesson-image://${image.id}`;
    const text = target.replacing ? marker : target.field === "html" ? lessonImageTag(image.id, alt)
      : target.field === "css" ? `url("${marker}")` : `"${marker}"`;
    const next = target.source.slice(0, target.start) + text + target.source.slice(target.end);
    onChange((current) => current[target.field] === target.source ? { ...current, [target.field]: next } : current);
    requestAnimationFrame(() => {
      if (editor.current !== node) return;
      node.focus();
      node.setSelectionRange(target.start + text.length, target.start + text.length);
    });
  }

  return <section className="code-lesson-editor" aria-label="ตัวแก้ไขโค้ดบทเรียน">
    <label>Framework<select value={code.framework ?? "none"} onChange={(event) => { const framework = event.target.value as CodeBlock["framework"]; onChange((current) => ({ ...current, framework })); }}>
      <option value="none">None — ไม่ใช้เฟรมเวิร์ก</option><option value="bootstrap">Bootstrap 5.3.9 — CSS + JavaScript</option>
    </select></label>
    {code.framework === "bootstrap" && <p className="muted">ระบบโหลด Bootstrap CSS และ JavaScript ให้แล้ว ไม่ต้องเพิ่มลิงก์ Bootstrap ในโค้ดซ้ำ ใช้ CSS และ JavaScript ของคุณเพิ่มเติมได้</p>}
    <div className="code-editor-tabs" role="tablist" aria-label="ภาษาในบทเรียน">
      {(["html", "css", "javascript"] as const).map((name) => <button key={name} role="tab" aria-selected={field === name} onClick={() => { if (name !== field) { setTarget(null); setNotice(""); setField(name); } }}>{name === "javascript" ? "JavaScript" : name.toUpperCase()}</button>)}
    </div>
    <div className="code-image-tools">
      <button className="button button-quiet" disabled={Boolean(target)} onClick={() => openImages(false)}>＋ {field === "html" ? "แทรกรูปภาพ" : "แทรกอ้างอิงรูปภาพ"}</button>
      {field === "html" && <button className="button button-quiet" disabled={Boolean(target)} onClick={() => openImages(true)}>เปลี่ยนรูปภาพ</button>}
    </div>
    {field === "html" && <p className="muted">วางเคอร์เซอร์ที่ตำแหน่งแทรกรูป หรือในแท็ก &lt;img&gt; เพื่อเปลี่ยนรูป วางภาพหน้าจอจากคลิปบอร์ดได้</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {target && <LessonImagePicker images={images} imageUrl={imageUrl} driveEnabled={driveEnabled} onAdd={onAdd} onChoose={useImage}
      onClose={() => { setTarget(null); editor.current?.focus(); }} replacing={target.replacing} initialFile={target.file} describeImage={field === "html"} />}
    <label className="code-editor-label">{field === "javascript" ? "JavaScript" : field.toUpperCase()}
      <textarea key={field} ref={editor} spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off" wrap="off" rows={20} value={code[field]}
        onChange={(event) => { const value = event.target.value; onChange((current) => ({ ...current, [field]: value })); }}
        onPaste={(event) => {
          const file = [...event.clipboardData.files].find((item) => ["image/png", "image/jpeg", "image/webp"].includes(item.type));
          if (field === "html" && file) {
            event.preventDefault();
            if (!target) openImages(false, file);
            else setNotice("ปิดตัวเลือกรูปปัจจุบันก่อนวางรูปใหม่");
          }
        }} onKeyDown={(event) => {
        if (event.key === "Tab" && !event.shiftKey) {
          event.preventDefault();
          const editor = event.currentTarget; const start = editor.selectionStart; const end = editor.selectionEnd;
          onChange((current) => ({ ...current, [field]: current[field].slice(0, start) + "  " + current[field].slice(end) }));
          requestAnimationFrame(() => editor.setSelectionRange(start + 2, start + 2));
        }
      }} aria-label={`${field} source`} />
    </label>
  </section>;
}

export function CodeLessonFrame({ code, imageUrl, autoRun = false }: {
  code: CodeBlock;
  imageUrl: (id: string) => string;
  autoRun?: boolean;
}) {
  const [running, setRunning] = useState(autoRun);
  const [captured, setCaptured] = useState<CodeBlock | null>(autoRun ? code : null);
  const [html, setHtml] = useState("");
  const [imageWarning, setImageWarning] = useState(false);
  const [run, setRun] = useState(0);

  function runPreview() { setCaptured({ ...code }); setImageWarning(false); setRunning(true); setRun((value) => value + 1); }

  useEffect(() => {
    if (!running || !captured) { setHtml(""); return; }
    const controller = new AbortController();
    setHtml(""); setImageWarning(false);
    void (async () => {
      const ids = lessonImageIds(captured.html, captured.css, captured.javascript);
      const resolved = new Map<string, string>(); let missing = false;
      await Promise.all(ids.map(async (id) => {
        try {
          const response = await fetch(imageUrl(id), { credentials: "same-origin", cache: "no-store", signal: controller.signal });
          if (!response.ok) throw new Error("Image unavailable");
          const url = await imageDataUrl(await response.blob());
          if (!controller.signal.aborted) resolved.set(id, url);
        } catch (error) {
          if (controller.signal.aborted) return;
          missing = true;
          resolved.set(id, `data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='640' height='360'><rect width='100%' height='100%' fill='#e8efed'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' fill='#526966' font-family='sans-serif' font-size='24'>Image unavailable</text></svg>")}`);
        }
      }));
      if (controller.signal.aborted) return;
      const replace = (source: string) => source.replace(/lesson-image:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/gi, (token, id: string) => resolved.get(id.toLowerCase()) ?? token);
      const css = replace(captured.css); const javascript = replace(captured.javascript); const content = replace(captured.html);
      setImageWarning(missing);
      setHtml(createCodeLessonDocument(content, css, javascript, captured.framework));
    })().catch(() => { if (!controller.signal.aborted) setImageWarning(true); });
    return () => controller.abort();
  }, [running, captured, run, imageUrl]);

  return <section className="code-lesson-output">
    {!autoRun && <div className="code-preview-controls"><button className="button button-primary" onClick={runPreview}>▶ Run Preview</button><button className="button button-quiet" disabled={!running} onClick={runPreview}>↻ Restart</button><button className="button button-quiet" disabled={!running} onClick={() => setRunning(false)}>■ Stop</button></div>}
    {imageWarning && <p className="notice" role="status">รูปภาพบางรูปโหลดไม่ได้ จะแสดงตำแหน่งสำรองแทน</p>}
    {html && <iframe key={run} className="code-lesson-frame" title="ตัวอย่างบทเรียน" sandbox="allow-scripts" allow="fullscreen" referrerPolicy="no-referrer" srcDoc={html} />}
    {!running && autoRun && <p className="muted">บทเรียนนี้หยุดทำงานแล้ว กรุณาโหลดหน้าใหม่เพื่อเริ่มอีกครั้ง</p>}
  </section>;
}
