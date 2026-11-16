import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "./api";
import { exportQuizForAI, parseQuizImportText, quizAITemplate } from "../../src/quiz-import";
import "./quiz.css";

type Choice = { id: string; text: string; imageId: string | null };
type Question = { id: string; type: "multiple-choice" | "true-false"; prompt: string; imageId: string | null; points: number; choices: Choice[]; correctChoiceId: string | null; explanation: string };
type Content = { description: string; questions: Question[] };
type Quiz = { id: string; title: string; content: Content; revision: number; publishedTitle: string | null; publishedAt: string | null };
type QuizRow = { id: string; title: string; draftRevision: number; publishedTitle: string | null; publishedAt: string | null; updatedAt: string };
type Classroom = { id: string; name: string; studentCount: number };
type Round = { id: string; quizId: string; title: string; status: "awaiting_open" | "open" | "closed"; durationMinutes: number | null; openedAt?: string | null; closedAt?: string | null; solutionsReleasedAt?: string | null; startedCount: number; finishedCount: number };
type Result = { round: Round & { content: Content }; attempts: { id: string | null; studentId: string; studentNumber: number | null; displayName: string; answers: Record<string, string | null> | null; startedAt: string | null; expiresAt: string | null; finishedAt: string | null; finishReason: string | null; score: string | null }[] };

const uuid = () => crypto.randomUUID();
const newChoice = (text = "") => ({ id: uuid(), text, imageId: null });
const newQuestion = (): Question => ({ id: uuid(), type: "multiple-choice", prompt: "", imageId: null, points: 1,
  choices: [newChoice(), newChoice(), newChoice(), newChoice()], correctChoiceId: null, explanation: "" });

export function QuizLibrary({ classrooms, onError, onDirtyChange }: { classrooms: Classroom[]; onError: (message: string) => void; onDirtyChange: (dirty: boolean) => void }) {
  const [list, setList] = useState<QuizRow[]>([]); const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [title, setTitle] = useState(""); const [content, setContent] = useState<Content>({ description: "", questions: [] });
  const [classroomId, setClassroomId] = useState(""); const [rounds, setRounds] = useState<Round[]>([]);
  const [duration, setDuration] = useState(""); const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false); const [preview, setPreview] = useState(false);
  const [aiTopic, setAiTopic] = useState(""); const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState(""); const [importPreview, setImportPreview] = useState<ReturnType<typeof parseQuizImportText> | null>(null);
  const [importError, setImportError] = useState(""); const [copyFallback, setCopyFallback] = useState(""); const [aiNotice, setAiNotice] = useState("");
  const dirty = Boolean(quiz && (quiz.title !== title || JSON.stringify(quiz.content) !== JSON.stringify(content)));
  const selectedClass = classrooms.find((item) => item.id === classroomId);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty || busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy]);

  const loadList = useCallback(async () => setList(await api<QuizRow[]>("/quizzes")), []);
  useEffect(() => { void loadList().catch((error) => onError(error instanceof Error ? error.message : "โหลดแบบทดสอบไม่สำเร็จ")); }, [loadList, onError]);
  const loadRounds = useCallback(async () => {
    if (!classroomId) { setRounds([]); return; }
    setRounds(await api<Round[]>(`/classrooms/${classroomId}/quizzes`));
  }, [classroomId]);
  useEffect(() => { void loadRounds().catch((error) => onError(error instanceof Error ? error.message : "โหลดรอบแบบทดสอบไม่สำเร็จ")); }, [loadRounds, onError]);

  async function open(id: string) {
    try { const next = await api<Quiz>(`/quizzes/${id}`); setQuiz(next); setTitle(next.title); setContent(next.content); setPreview(false); setResult(null); }
    catch (error) { onError(error instanceof Error ? error.message : "เปิดแบบทดสอบไม่สำเร็จ"); }
  }
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try { const next = await api<Quiz>("/quizzes", { method: "POST", body: JSON.stringify({ title }) }); await loadList(); setQuiz(next); setTitle(next.title); setContent(next.content); }
    catch (error) { onError(error instanceof Error ? error.message : "สร้างแบบทดสอบไม่สำเร็จ"); }
    finally { setBusy(false); }
  }
  async function save(publish = false) {
    if (!quiz) return;
    setBusy(true);
    try {
      const next = await api<Quiz>(`/quizzes/${quiz.id}/${publish ? "publish" : "draft"}`, { method: publish ? "POST" : "PUT",
        body: JSON.stringify({ title, content, expectedRevision: quiz.revision }) });
      setQuiz(next); setTitle(next.title); setContent(next.content); await loadList();
    } catch (error) { onError(error instanceof Error ? error.message : "บันทึกแบบทดสอบไม่สำเร็จ"); }
    finally { setBusy(false); }
  }
  async function unpublish() {
    if (!quiz || !window.confirm("ยกเลิกเผยแพร่แบบทดสอบนี้หรือไม่? รอบที่สร้างไว้แล้วจะยังใช้งานได้")) return;
    setBusy(true);
    try { await api(`/quizzes/${quiz.id}/unpublish`, { method: "POST", body: JSON.stringify({ expectedRevision: quiz.revision }) }); await open(quiz.id); await loadList(); }
    catch (error) { onError(error instanceof Error ? error.message : "ยกเลิกเผยแพร่ไม่สำเร็จ"); }
    finally { setBusy(false); }
  }
  async function uploadImage(file: File, update: (id: string) => void) {
    if (!quiz) return;
    const form = new FormData(); form.set("file", file);
    try { const image = await api<{ id: string }>(`/quizzes/${quiz.id}/images`, { method: "POST", body: form }); update(image.id); }
    catch (error) { onError(error instanceof Error ? error.message : "อัปโหลดภาพไม่สำเร็จ"); }
  }
  async function assign(event: FormEvent) {
    event.preventDefault(); if (!quiz || !classroomId) return;
    setBusy(true);
    try {
      await api(`/classrooms/${classroomId}/quizzes`, { method: "POST", body: JSON.stringify({ quizId: quiz.id, durationMinutes: duration ? Number(duration) : null }) });
      setDuration(""); await loadRounds();
    } catch (error) { onError(error instanceof Error ? error.message : "สร้างรอบแบบทดสอบไม่สำเร็จ"); }
    finally { setBusy(false); }
  }
  async function roundAction(round: Round, action: "open" | "close" | "release-solutions") {
    if (!classroomId) return;
    if (action === "close" && !window.confirm("ปิดรอบนี้หรือไม่? นักเรียนที่เริ่มแล้วจะถูกส่งด้วยคำตอบที่บันทึกไว้")) return;
    try { await api(`/classrooms/${classroomId}/quizzes/${round.id}/${action}`, { method: "POST" }); await loadRounds(); if (result?.round.id === round.id) await viewResults(round.id); }
    catch (error) { onError(error instanceof Error ? error.message : "เปลี่ยนสถานะแบบทดสอบไม่สำเร็จ"); }
  }
  async function viewResults(roundId: string) {
    if (!classroomId) return;
    try { setResult(await api<Result>(`/classrooms/${classroomId}/quizzes/${roundId}/results`)); }
    catch (error) { onError(error instanceof Error ? error.message : "โหลดผลแบบทดสอบไม่สำเร็จ"); }
  }
  function patchQuestion(index: number, patch: Partial<Question>) {
    setContent((value) => ({ ...value, questions: value.questions.map((item, i) => i === index ? { ...item, ...patch } : item) }));
  }
  const maxScore = useMemo(() => content.questions.reduce((sum, question) => sum + Number(question.points || 0), 0), [content]);

  async function copyForAI(value: string, note: string) {
    setAiNotice(note);
    try { await navigator.clipboard.writeText(value); setCopyFallback(""); }
    catch { setCopyFallback(value); setAiNotice(`${note} · คัดลอกอัตโนมัติไม่ได้ กรุณาเลือกข้อความด้านล่างแล้วคัดลอก`); }
  }
  function previewImport() {
    setImportError(""); setImportPreview(null);
    try { setImportPreview(parseQuizImportText(importText)); }
    catch (error) { setImportError(error instanceof Error ? error.message : "รูปแบบแบบทดสอบไม่ถูกต้อง"); }
  }
  async function createImportedDraft() {
    if (!importPreview) return;
    setBusy(true); setImportError("");
    try {
      await api<Quiz>("/quizzes/import", { method: "POST", body: JSON.stringify({ json: importText }) });
      await loadList(); setImportOpen(false); setImportText(""); setImportPreview(null);
      setAiNotice("นำเข้าเป็นฉบับร่างใหม่แล้ว เปิดจากรายการแบบทดสอบเพื่อตรวจสอบ");
    } catch (error) { setImportError(error instanceof Error ? error.message : "นำเข้าไม่สำเร็จ"); }
    finally { setBusy(false); }
  }
  const aiTools = <section className="panel quiz-ai-tools"><h2>สร้างแบบทดสอบด้วย AI</h2>
    <label>หัวข้อสำหรับ AI<input value={aiTopic} onChange={(event) => setAiTopic(event.target.value)} placeholder="เช่น พื้นฐาน Blender" /></label>
    <div className="lesson-actions">
      <button className="button button-quiet" onClick={() => void copyForAI(quizAITemplate.replace("__REPLACE_WITH_TOPIC__", aiTopic || "ใส่หัวข้อที่ต้องการ"), "คัดลอกคำสั่งสำหรับ AI แล้ว")}>Copy AI template</button>
      <button className="button button-quiet" onClick={() => { setImportOpen((value) => !value); setImportError(""); }}>Import from AI</button>
      {quiz && <button className="button button-quiet" onClick={() => {
        const hasImages = content.questions.some((question) => question.imageId || question.choices.some((choice) => choice.imageId));
        void copyForAI(JSON.stringify(exportQuizForAI(title, content), null, 2), hasImages ? "ส่งออกเฉพาะข้อความ ไม่รวมรูป คำถามที่พึ่งพารูปอาจต้องเขียนใหม่" : "คัดลอกแบบทดสอบปัจจุบัน รวมการแก้ไขที่ยังไม่บันทึกแล้ว");
      }}>Copy quiz for AI</button>}
    </div>
    {aiNotice && <p className="muted" role="status">{aiNotice}</p>}
    {copyFallback && <label>ข้อความสำหรับคัดลอก<textarea rows={8} readOnly value={copyFallback} onFocus={(event) => event.currentTarget.select()} /></label>}
    {importOpen && <div className="quiz-ai-import"><label>วาง JSON จาก AI<textarea rows={10} maxLength={1048576} value={importText} onChange={(event) => { setImportText(event.target.value); setImportPreview(null); setImportError(""); }} placeholder='{"format":"classroom-quiz","version":1,...}' /></label>
      {importError && <p className="form-error" role="alert">{importError}</p>}
      <button className="button button-quiet" disabled={!importText.trim()} onClick={previewImport}>ตรวจสอบและดูตัวอย่าง</button>
      {importPreview && <div className="quiz-import-preview"><h3>{importPreview.title}</h3><p>{importPreview.content.description}</p><p>{importPreview.content.questions.length} ข้อ · {importPreview.content.questions.reduce((sum, question) => sum + question.points, 0)} คะแนน</p>
        {importPreview.content.questions.map((question, index) => <article key={question.id}><strong>{index + 1}. {question.prompt} ({question.points} คะแนน)</strong><ol>{question.choices.map((choice) => <li key={choice.id}>{choice.text}{choice.id === question.correctChoiceId ? " · คำตอบถูก" : ""}</li>)}</ol>{question.explanation && <p>{question.explanation}</p>}</article>)}
        <button className="button button-primary" disabled={busy} onClick={() => void createImportedDraft()}>{busy ? "กำลังนำเข้า…" : "สร้างฉบับร่างใหม่"}</button>
      </div>}
    </div>}
    <p className="muted">AI อาจตอบผิด โปรดตรวจคำตอบก่อนเผยแพร่ · เพิ่มรูปได้ในตัวสร้างหลังนำเข้า</p>
  </section>;

  if (!quiz) return <section className="quiz-library"><header className="page-heading"><div><p className="eyebrow">แบบทดสอบสำหรับนักเรียน</p><h1>แบบทดสอบ</h1><p className="muted page-description">สร้างแบบทดสอบ แล้วทำสำเนาแยกรอบให้แต่ละห้อง</p></div></header>
    {aiTools}
    <form className="lesson-create" onSubmit={create}><label>ชื่อแบบทดสอบ<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required/></label><button className="button button-primary" disabled={busy}>＋ สร้างแบบทดสอบ</button></form>
    {list.length ? <div className="lesson-list">{list.map((item) => <button className="lesson-list-item" key={item.id} onClick={() => void open(item.id)}><span><strong>{item.title}</strong><small>{item.publishedAt ? "เผยแพร่แล้ว" : "ฉบับร่าง"}</small></span><b>แก้ไข ↗</b></button>)}</div> : <div className="panel"><h2>ยังไม่มีแบบทดสอบ</h2><p className="muted">แบบทดสอบรองรับปรนัยเลือกคำตอบเดียวและถูก/ผิด</p></div>}
  </section>;

  return <section className="quiz-editor"><header className="page-heading"><div><button className="text-button" onClick={() => { if (dirty && !window.confirm("ออกจากแบบทดสอบโดยไม่บันทึกหรือไม่?")) return; setQuiz(null); void loadList(); }}>← แบบทดสอบทั้งหมด</button><p className="eyebrow">{quiz.publishedAt ? "เผยแพร่แล้ว" : "ฉบับร่าง"}</p><h1>ตัวสร้างแบบทดสอบ</h1></div><div className="lesson-actions">
    <button className="button button-quiet" disabled={busy || !dirty} onClick={() => void save()}>บันทึกฉบับร่าง</button>
    <button className="button button-primary" disabled={busy || !dirty && Boolean(quiz.publishedAt)} onClick={() => void save(true)}>{quiz.publishedAt ? "บันทึกและเผยแพร่" : "เผยแพร่"}</button>
    {quiz.publishedAt && <button className="button button-danger" disabled={busy || dirty} onClick={() => void unpublish()}>ยกเลิกเผยแพร่</button>}
  </div></header>
    {aiTools}
    <label className="lesson-title-field">ชื่อแบบทดสอบ<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120}/></label>
    <label className="quiz-description">คำชี้แจง<textarea rows={3} value={content.description} maxLength={4000} onChange={(event) => setContent((value) => ({ ...value, description: event.target.value }))}/></label>
    <div className="quiz-toolbar"><span>{content.questions.length} / 100 ข้อ · รวม {maxScore} คะแนน</span><button className="button button-quiet" onClick={() => setPreview((value) => !value)}>{preview ? "ปิดตัวอย่าง" : "ดูตัวอย่าง"}</button><button className="button button-quiet" disabled={content.questions.length >= 100} onClick={() => setContent((value) => ({ ...value, questions: [...value.questions, newQuestion()] }))}>＋ เพิ่มคำถาม</button></div>
    {content.questions.map((question, index) => <article className="quiz-question-editor panel" key={question.id}><header><strong>ข้อ {index + 1}</strong><div><button aria-label="เลื่อนคำถามขึ้น" disabled={!index} onClick={() => setContent((value) => { const next = [...value.questions]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return { ...value, questions: next }; })}>↑</button><button aria-label="เลื่อนคำถามลง" disabled={index === content.questions.length - 1} onClick={() => setContent((value) => { const next = [...value.questions]; [next[index], next[index + 1]] = [next[index + 1], next[index]]; return { ...value, questions: next }; })}>↓</button><button className="text-button danger" onClick={() => setContent((value) => ({ ...value, questions: value.questions.filter((_, i) => i !== index) }))}>ลบข้อ</button></div></header>
      <div className="quiz-question-fields"><label>ชนิด<select value={question.type} onChange={(event) => patchQuestion(index, event.target.value === "true-false" ? { type: "true-false", choices: [newChoice("จริง"), newChoice("เท็จ")] } : { type: "multiple-choice", choices: [newChoice(), newChoice(), newChoice(), newChoice()] })}><option value="multiple-choice">ปรนัยเลือกคำตอบเดียว</option><option value="true-false">ถูก / ผิด</option></select></label><label>คะแนน<input type="number" min={1} max={2147483647} step={1} value={question.points} onChange={(event) => patchQuestion(index, { points: Number(event.target.value) })}/></label></div>
      <label>คำถาม<textarea rows={3} value={question.prompt} maxLength={4000} onChange={(event) => patchQuestion(index, { prompt: event.target.value })}/></label>
      <label className="quiz-image-upload">ภาพประกอบคำถาม<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadImage(file, (imageId) => patchQuestion(index, { imageId })); event.currentTarget.value = ""; }}/></label>
      {question.imageId && <div className="quiz-image-preview"><img src={`/api/quizzes/${quiz.id}/images/${question.imageId}/content`} alt="ภาพประกอบคำถาม"/><button className="text-button danger" onClick={() => patchQuestion(index, { imageId: null })}>นำภาพออก</button></div>}
      <fieldset className="quiz-choices"><legend>ตัวเลือก — เลือกคำตอบที่ถูกต้อง</legend>{question.choices.map((choice, choiceIndex) => <div className="quiz-choice-editor" key={choice.id}><label><input type="radio" name={`correct-${question.id}`} checked={question.correctChoiceId === choice.id} onChange={() => patchQuestion(index, { correctChoiceId: choice.id })}/><span>คำตอบถูก</span></label><label>ข้อความ<input value={choice.text} maxLength={1000} onChange={(event) => patchQuestion(index, { choices: question.choices.map((item) => item.id === choice.id ? { ...item, text: event.target.value } : item) })}/></label><label>ภาพ<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadImage(file, (imageId) => patchQuestion(index, { choices: question.choices.map((item) => item.id === choice.id ? { ...item, imageId } : item) })); event.currentTarget.value = ""; }}/></label>{choice.imageId && <img src={`/api/quizzes/${quiz.id}/images/${choice.imageId}/content`} alt="ภาพตัวเลือก"/>}{question.type === "multiple-choice" && question.choices.length > 2 && <button className="text-button danger" onClick={() => patchQuestion(index, { choices: question.choices.filter((item) => item.id !== choice.id), correctChoiceId: question.correctChoiceId === choice.id ? null : question.correctChoiceId })}>ลบ</button>}</div>)}{question.type === "multiple-choice" && question.choices.length < 8 && <button className="button button-quiet" onClick={() => patchQuestion(index, { choices: [...question.choices, newChoice()] })}>＋ เพิ่มตัวเลือก</button>}</fieldset>
      <label>คำอธิบายเฉลย<textarea rows={2} value={question.explanation} maxLength={4000} onChange={(event) => patchQuestion(index, { explanation: event.target.value })}/></label>
    </article>)}
    {preview && <section className="panel quiz-preview"><h2>ตัวอย่างสำหรับนักเรียน</h2><p>{content.description}</p>{content.questions.map((question, index) => <div key={question.id}><strong>{index + 1}. {question.prompt} ({question.points} คะแนน)</strong>{question.imageId && <img src={`/api/quizzes/${quiz.id}/images/${question.imageId}/content`} alt=""/>}{question.choices.map((choice) => <p key={choice.id}>○ {choice.text}{choice.imageId && <img src={`/api/quizzes/${quiz.id}/images/${choice.imageId}/content`} alt=""/>}</p>)}</div>)}</section>}

    <section className="panel quiz-round-management"><h2>สร้างรอบในห้องเรียน</h2><form className="quiz-assign-form" onSubmit={(event) => void assign(event)}><label>ห้องเรียน<select value={classroomId} onChange={(event) => setClassroomId(event.target.value)} required><option value="">เลือกห้องเรียน</option>{classrooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}</select></label><label>เวลาทำ (นาที)<input type="number" min={1} max={240} value={duration} onChange={(event) => setDuration(event.target.value)} placeholder="ไม่จำกัดเวลา"/></label><button className="button button-primary" disabled={busy || !quiz.publishedAt || !classroomId}>สร้างรอบจากฉบับเผยแพร่</button></form><p className="muted">รอบจะคัดลอกคำถามและเฉลยฉบับที่เผยแพร่ไว้ การแก้คลังภายหลังไม่เปลี่ยนรอบนี้</p>
      {selectedClass && <><h3>รอบของ {selectedClass.name}</h3>{rounds.length ? <div className="quiz-round-list">{rounds.map((round) => <article key={round.id}><div><strong>{round.title}</strong><small>{round.status === "awaiting_open" ? "รอเปิด" : round.status === "open" ? "กำลังทำ" : "ปิดแล้ว"} · เริ่มแล้ว {round.startedCount} · ส่งแล้ว {round.finishedCount}{round.durationMinutes ? ` · ${round.durationMinutes} นาที` : " · ไม่จำกัดเวลา"}</small></div><div className="quiz-round-actions">{round.status === "awaiting_open" && <button className="button button-primary" onClick={() => void roundAction(round, "open")}>เปิดรอบ</button>}{round.status === "open" && <button className="button button-danger" onClick={() => void roundAction(round, "close")}>ปิดรอบ</button>}{round.status === "closed" && !round.solutionsReleasedAt && <button className="button button-quiet" onClick={() => void roundAction(round, "release-solutions")}>เผยแพร่เฉลย</button>}<button className="button button-quiet" onClick={() => void viewResults(round.id)}>ผลรายคน</button></div></article>)}</div> : <p className="muted">ยังไม่มีรอบในห้องนี้</p>}</>}
    </section>
    {result && <section className="panel quiz-results">
      <header><div><h2>ผลแบบทดสอบ · {result.round.title}</h2><p className="muted">คำตอบของนักเรียนแสดงเฉพาะครู</p></div><button className="text-button" onClick={() => setResult(null)}>ปิด</button></header>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>เลขที่</th><th>นักเรียน</th><th>สถานะ</th><th>คะแนน</th><th>เริ่ม</th><th>ส่ง</th><th>คำตอบ</th></tr></thead><tbody>
        {result.attempts.map((attempt) => <tr key={attempt.studentId}>
          <td>{attempt.studentNumber ?? "—"}</td><td>{attempt.displayName}</td>
          <td>{!attempt.id ? "ยังไม่เริ่ม" : attempt.finishedAt ? attempt.finishReason === "submitted" ? "ส่งแล้ว" : "หมดเวลา/ครูปิด" : "กำลังทำ"}</td>
          <td>{attempt.score ?? "—"} / {result.round.content.questions.reduce((sum, question) => sum + question.points, 0)}</td>
          <td>{attempt.startedAt ? showTime(attempt.startedAt) : "—"}</td><td>{attempt.finishedAt ? showTime(attempt.finishedAt) : "—"}</td>
          <td>{attempt.id ? result.round.content.questions.map((question, i) => {
            const selected = question.choices.find((choice) => choice.id === attempt.answers?.[question.id]);
            return <div key={question.id}>{i + 1}. {question.prompt}: {selected?.text ?? "เว้นว่าง"} {attempt.answers?.[question.id] === question.correctChoiceId ? "✓" : ""}
              {question.imageId && <img className="quiz-result-image" src={`/api/quizzes/${result.round.quizId}/images/${question.imageId}/content`} alt="ภาพคำถาม"/>}
              {selected?.imageId && <img className="quiz-result-image" src={`/api/quizzes/${result.round.quizId}/images/${selected.imageId}/content`} alt="ภาพคำตอบที่เลือก"/>}
            </div>;
          }) : "—"}</td>
        </tr>)}
      </tbody></table></div>
    </section>}
  </section>;
}

function showTime(value: string) { return new Intl.DateTimeFormat("th-TH", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(value)); }
