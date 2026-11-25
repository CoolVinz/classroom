import { wioLabs } from "../../src/wio-labs";
import { useRef, useState } from "react";
import { maxAiImportBytes } from "../../src/ai-import-json";
import { aiImportTemplate, parseLessonPackImportText, parseWorksheetImportText } from "../../src/lesson-pack-import";
import { api } from "./api";

type Pack = ReturnType<typeof parseLessonPackImportText>;
type Worksheet = ReturnType<typeof parseWorksheetImportText>;
type Preview = { worksheet: Worksheet | null; pack?: Pack };

export function AiImportPanel({ kind, onImported }: { kind: "worksheet" | "pack"; onImported: (id: string) => void }) {
  const [packTemplate, setPackTemplate] = useState<"pack" | "wio">("pack");
  const [topic, setTopic] = useState("");
  const [grade, setGrade] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  const [copyFallback, setCopyFallback] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [pasted, setPasted] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const isPack = kind === "pack";

  async function copyPrompt() {
    const prompt = aiImportTemplate(isPack ? packTemplate : "worksheet", topic, grade);
    try {
      await navigator.clipboard.writeText(prompt);
      setCopyFallback(""); setCopyNotice("คัดลอกคำสั่งสำหรับ AI แล้ว");
    } catch {
      setCopyFallback(prompt); setCopyNotice("เลือกและคัดลอกคำสั่งด้านล่าง");
    }
  }

  function review() {
    setPreview(null); setError("");
    try {
      if (isPack) {
        const pack = parseLessonPackImportText(pasted);
        setPreview({ pack, worksheet: pack.worksheet });
      } else {
        setPreview({ worksheet: parseWorksheetImportText(pasted) });
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "รูปแบบข้อมูลไม่ถูกต้อง"); }
  }

  async function importDrafts() {
    if (!preview || submitting.current) return;
    submitting.current = true;
    setSaving(true); setError("");
    let id: string;
    try {
      const request = { method: "POST", body: JSON.stringify({ json: pasted }) };
      id = isPack
        ? (await api<{ lessonId: string }>("/lesson-packs/import", request)).lessonId
        : (await api<{ id: string }>("/worksheets/import", request)).id;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "นำเข้าไม่สำเร็จ");
      return;
    } finally { setSaving(false); submitting.current = false; }
    setPasted(""); setPreview(null); setImportOpen(false);
    onImported(id);
  }

  return <details className="panel learning-panel ai-import-panel">
    <summary>{isPack ? "สร้างชุดบทเรียนด้วย AI" : "สร้างใบงานด้วย AI"}</summary>
    <p className="muted">{isPack ? "วาง JSON จาก AI เพื่อสร้างชุดบทเรียนฉบับร่าง จากนั้นตรวจทานก่อนมอบหมาย" : "วางผลลัพธ์จาก AI เพื่อสร้างใบงานฉบับร่าง"}</p>
    <div className="lesson-actions">
      {isPack && <label>รูปแบบคำสั่ง AI<select value={packTemplate} onChange={(event) => {
        setPackTemplate(event.target.value as "pack" | "wio");
        setCopyFallback(""); setCopyNotice("");
      }}><option value="pack">Lesson + Quiz + Worksheet</option><option value="wio">Lesson + Wio Lab</option></select></label>}
      <label>หัวข้อสำหรับ AI<input value={topic} maxLength={160} onChange={(event) => setTopic(event.target.value)} placeholder="เช่น พื้นฐาน Blender" /></label>
      <label>ระดับชั้น<input value={grade} maxLength={80} onChange={(event) => setGrade(event.target.value)} placeholder="เช่น ม.3" /></label>
    </div>
    <div className="lesson-actions">
      <button className="button button-quiet" disabled={saving} onClick={() => void copyPrompt()}>Copy AI template</button>
      <button className="button button-quiet" disabled={saving} aria-expanded={importOpen} onClick={() => setImportOpen((value) => !value)}>Import from AI</button>
    </div>
    {copyNotice && <p className="muted" role="status">{copyNotice}</p>}
    {copyFallback && <label>คำสั่งสำหรับคัดลอก<textarea rows={7} readOnly value={copyFallback} onFocus={(event) => event.currentTarget.select()} /></label>}
    {importOpen && <div className="ai-import-review">
      <label>วาง JSON จาก AI<textarea rows={9} spellCheck={false} maxLength={maxAiImportBytes} value={pasted} disabled={saving}
        onChange={(event) => { setPasted(event.target.value); setPreview(null); setError(""); }} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button button-quiet" disabled={saving || !pasted.trim()} onClick={review}>ตรวจสอบและดูตัวอย่าง</button>
      {preview && <div className="ai-import-review">
        {preview.pack && <PackPreview pack={preview.pack} />}
        {preview.worksheet && <section>
          <h3>ใบงาน · {preview.worksheet.title}</h3>
          <p className="muted">{preview.worksheet.questions.length} ข้อ · {totalPoints(preview.worksheet.questions)} คะแนน</p>
          <ol>{preview.worksheet.questions.map((question) => <li key={question.id}>
            <strong>{question.prompt} ({question.points} คะแนน)</strong>
            {question.choices.length > 0 && <ol>{question.choices.map((choice, index) => <li key={index}>{choice}{index === question.correctChoice ? " · คำตอบถูก" : ""}</li>)}</ol>}
            {question.type === "blank" && <p>คำตอบที่ยอมรับได้ · {question.acceptedAnswers.join(" / ")}</p>}
          </li>)}</ol>
        </section>}
        {preview.pack?.quiz && <p className="muted">แบบทดสอบที่นำเข้าจะเชื่อมกับบทเรียน</p>}
        {preview.pack && preview.worksheet && <p className="muted">แนบใบงานได้เมื่อสร้างรอบของห้องเรียน</p>}
        {preview.pack?.lab && <p className="muted">งาน Wio จะสร้างเมื่อมอบหมายบทเรียนที่เผยแพร่แล้วให้ห้องเรียน</p>}
        {!isPack && <p className="muted">ตรวจเฉลยก่อนเผยแพร่ใบงาน</p>}
        <button className="button button-primary" disabled={saving} onClick={() => void importDrafts()}>
          {saving ? "กำลังนำเข้า…" : isPack ? "สร้างชุดฉบับร่าง" : "สร้างใบงานฉบับร่าง"}
        </button>
      </div>}
    </div>}
  </details>;
}

function totalPoints(questions: { points: number }[]) {
  return questions.reduce((sum, question) => sum + question.points, 0);
}

function PackPreview({ pack }: { pack: Pack }) {
  const { lesson, quiz, lab } = pack;
  return <>
    <section>
      <h3>บทเรียน · {lesson.title}</h3>
      <p className="muted">{lesson.code.framework === "bootstrap" ? "Bootstrap 5" : "HTML / CSS / JavaScript"}</p>
      <details><summary>ดูโค้ดบทเรียน</summary>
        {(["html", "css", "javascript"] as const).filter((language) => lesson.code[language]).map((language) => <div key={language}>
          <h4>{language.toUpperCase()}</h4><pre>{lesson.code[language]}</pre>
        </div>)}
      </details>
    </section>
    {lab && <section>
      <h3>Wio Terminal · {lab.title}</h3>
      <p className="muted">{wioLabs[lab.preset].title} · {lab.maxScore} คะแนน</p>
      <p className="assignment-instructions">{lab.instructions}</p>
    </section>}
    {quiz && <section>
      <h3>แบบทดสอบ · {quiz.title}</h3>
      <p className="muted">{quiz.content.questions.length} ข้อ · {totalPoints(quiz.content.questions)} คะแนน</p>
      {quiz.content.description && <p>{quiz.content.description}</p>}
      <ol>{quiz.content.questions.map((question) => <li key={question.id}>
        <strong>{question.prompt} ({question.points} คะแนน)</strong>
        <ol>{question.choices.map((choice) => <li key={choice.id}>{choice.text}{choice.id === question.correctChoiceId ? " · คำตอบถูก" : ""}</li>)}</ol>
        {question.explanation && <p>{question.explanation}</p>}
      </li>)}</ol>
    </section>}
  </>;
}
