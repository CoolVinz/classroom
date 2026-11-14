import { useEffect, useRef, useState } from "react";
import { createCodeLessonDocument, imageDataUrl, lessonImageIds, type CodeBlock } from "./code-lesson";

type LessonImage = { id: string; originalName: string; sizeBytes: number };
type Field = "html" | "css" | "javascript";

export function CodeLessonEditor({ code, images, onChange, onUpload }: {
  code: CodeBlock;
  images: LessonImage[];
  onChange: (code: CodeBlock) => void;
  onUpload: (file: File) => Promise<LessonImage>;
}) {
  const [field, setField] = useState<Field>("html");
  const editors = useRef<Partial<Record<Field, HTMLTextAreaElement>>>({});

  function insertImage(id: string) {
    const text = field === "html" ? `<img src="lesson-image://${id}" alt="">`
      : field === "css" ? `url("lesson-image://${id}")`
        : `"lesson-image://${id}"`;
    const editor = editors.current[field];
    const start = editor?.selectionStart ?? code[field].length;
    const end = editor?.selectionEnd ?? start;
    onChange({ ...code, [field]: code[field].slice(0, start) + text + code[field].slice(end) });
    requestAnimationFrame(() => { editor?.focus(); editor?.setSelectionRange(start + text.length, start + text.length); });
  }

  return <section className="code-lesson-editor" aria-label="ตัวแก้ไขโค้ดบทเรียน">
    <label>Framework<select value={code.framework ?? "none"} onChange={(event) => onChange({ ...code, framework: event.target.value as CodeBlock["framework"] })}>
      <option value="none">None — ไม่ใช้เฟรมเวิร์ก</option><option value="bootstrap">Bootstrap 5.3.9 — CSS + JavaScript</option>
    </select></label>
    {code.framework === "bootstrap" && <p className="muted">ระบบโหลด Bootstrap CSS และ JavaScript ให้แล้ว ไม่ต้องเพิ่มลิงก์ Bootstrap ในโค้ดซ้ำ ใช้ CSS และ JavaScript ของคุณเพิ่มเติมได้</p>}
    <div className="code-editor-tabs" role="tablist" aria-label="ภาษาในบทเรียน">
      {(["html", "css", "javascript"] as const).map((name) => <button key={name} role="tab" aria-selected={field === name} onClick={() => setField(name)}>{name === "javascript" ? "JavaScript" : name.toUpperCase()}</button>)}
    </div>
    <label className="code-editor-label">{field === "javascript" ? "JavaScript" : field.toUpperCase()}
      <textarea ref={(node) => { if (node) editors.current[field] = node; }} spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off" wrap="off" rows={20} value={code[field]} onChange={(event) => onChange({ ...code, [field]: event.target.value })} onKeyDown={(event) => {
        if (event.key === "Tab") {
          event.preventDefault();
          const editor = event.currentTarget; const start = editor.selectionStart; const end = editor.selectionEnd;
          onChange({ ...code, [field]: code[field].slice(0, start) + "  " + code[field].slice(end) });
          requestAnimationFrame(() => editor.setSelectionRange(start + 2, start + 2));
        }
      }} aria-label={`${field} source`} />
    </label>
    <div className="code-image-tools"><label className="button button-quiet">＋ อัปโหลดรูปภาพ<input hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
      if (file) void onUpload(file).then((image) => insertImage(image.id)).catch(() => {});
    }} /></label>{images.length > 0 && <div><span>แทรกรูปที่อัปโหลด:</span>{images.map((image) => <button className="text-button" key={image.id} title={image.originalName} onClick={() => insertImage(image.id)}>{image.originalName}</button>)}</div>}</div>
    <p className="muted">ใช้ lesson-image://… เพื่อแสดงรูปที่อัปโหลด ลิงก์รูปภายนอกต้องมาจากบริการที่อนุญาต</p>
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
      const ids = [...new Set([...captured.imageIds, ...lessonImageIds(captured.html, captured.css, captured.javascript)])];
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
