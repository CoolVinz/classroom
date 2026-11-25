import { AiImportPanel } from "./AiImportPanel";
import { useEffect, useState } from "react";
import type { WorksheetAnswers, WorksheetQuestion, WorksheetQuestionType } from "../../src/worksheet-core";
import { api } from "./api";
import { worksheetStatus, type WorksheetRound } from "./WorksheetActivity";

type Classroom = { id: string; name: string };
type LibraryItem = { id: string; title: string; publishedTitle: string | null };
type Round = WorksheetRound & { classroomId: string; lessonId: string | null; lessonTitle: string | null };
type Editor = LibraryItem & { revision: number; questions: WorksheetQuestion[]; rounds: Round[] };
type Results = { status: Round["status"]; questions: WorksheetQuestion[]; students: { id: string; displayName: string; studentNumber: number | null; startedAt: string | null; submittedAt: string | null; score: number | null; answers: WorksheetAnswers | null }[] };
const newQuestion = (type: WorksheetQuestionType): WorksheetQuestion => ({ id: crypto.randomUUID(), type, prompt: "", points: 1, choices: type === "choice" ? ["", ""] : type === "boolean" ? ["ถูก", "ผิด"] : [], correctChoice: null, acceptedAnswers: [] });

export function WorksheetLibrary({ classrooms, onError, onDirtyChange }: { classrooms: Classroom[]; onError: (message: string) => void; onDirtyChange: (dirty: boolean) => void }) {
  const [library, setLibrary] = useState<LibraryItem[] | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [createTitle, setCreateTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [classroomId, setClassroomId] = useState("");
  const [lessonId, setLessonId] = useState("");
  const [resultsRound, setResultsRound] = useState<Round | null>(null);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { void reloadLibrary(); }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function reloadLibrary() {
    try { setLibrary(await api<LibraryItem[]>("/worksheets")); }
    catch (error) { onError((error as Error).message); }
  }
  async function action(run: () => Promise<void>) {
    setBusy(true);
    try { await run(); }
    catch (error) { onError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function open(id: string) {
    setEditor(await api<Editor>(`/worksheets/${id}`));
    setDirty(false); setResultsRound(null); setClassroomId(""); setLessonId("");
  }
  function edit(change: Partial<Editor>) {
    setEditor((current) => current && { ...current, ...change });
    setDirty(true);
  }
  function questionEdit(id: string, change: Partial<WorksheetQuestion>) {
    if (editor) edit({ questions: editor.questions.map((item) => item.id === id ? { ...item, ...change } : item) });
  }
  async function save(publish: boolean) {
    if (!editor) return;
    const values = await api<Omit<Editor, "rounds">>(`/worksheets/${editor.id}`, { method: "PUT", body: JSON.stringify({ title: editor.title, questions: editor.questions, expectedRevision: editor.revision, publish }) });
    setEditor({ ...editor, ...values }); setDirty(false);
  }
  async function refreshRounds() {
    const latest = await api<Editor>(`/worksheets/${editor!.id}`);
    setEditor((current) => current && { ...current, rounds: latest.rounds });
  }
  async function changeRound(round: Round, body: { action: "open" | "close" } | { action: "attach"; lessonId: string | null }) {
    if (body.action === "close" && !window.confirm(`ปิดรับคำตอบของ ${round.title}? คำตอบที่ยังไม่ได้ส่งจะไม่ได้คะแนน`)) return;
    await api(`/classrooms/${round.classroomId}/worksheets/${round.id}`, { method: "PATCH", body: JSON.stringify(body) });
    await refreshRounds();
  }

  if (!editor) return <section>
    <header className="page-heading"><h1>ใบงานกิจกรรม</h1></header>
    <form className="panel learning-panel" onSubmit={(event) => { event.preventDefault(); void action(async () => {
      const created = await api<{ id: string }>("/worksheets", { method: "POST", body: JSON.stringify({ title: createTitle }) });
      setCreateTitle(""); await open(created.id);
    }); }}><label>ชื่อใบงาน<input required maxLength={120} value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} /></label><button className="button button-primary" disabled={busy || !createTitle.trim()}>สร้างใบงาน</button></form>
    <AiImportPanel kind="worksheet" onImported={(id) => void action(() => open(id))} />
    <div className="lesson-list">{library ? library.length ? library.map((item) => <button key={item.id} className="lesson-list-item" disabled={busy} onClick={() => void action(() => open(item.id))}><span><strong>{item.title}</strong><small>{item.publishedTitle ? "เผยแพร่แล้ว" : "ฉบับร่าง"}</small></span></button>) : <p className="muted">ยังไม่มีใบงาน</p> : <button className="text-button" onClick={() => void reloadLibrary()}>โหลดรายการใบงาน</button>}</div>
  </section>;

  return <section>
    <header className="page-heading"><div><button className="text-button" disabled={busy} onClick={() => {
      if (dirty && !window.confirm("ออกจากใบงานโดยไม่บันทึกการแก้ไขหรือไม่?")) return;
      setEditor(null); setDirty(false); void reloadLibrary();
    }}>← ใบงานทั้งหมด</button><h1>แก้ไขใบงาน</h1></div><div className="lesson-actions">
      <button className="button button-quiet" disabled={busy || !dirty} onClick={() => void action(() => save(false))}>บันทึกฉบับร่าง</button>
      <button className="button button-primary" disabled={busy} onClick={() => void action(() => save(true))}>บันทึกและเผยแพร่</button>
    </div></header>
    <fieldset className="panel learning-panel learning-editor" disabled={busy}>
      <label>ชื่อใบงาน<input maxLength={120} value={editor.title} onChange={(event) => edit({ title: event.target.value })} /></label>
      <div className="worksheet-questions">{editor.questions.map((question, index) => <fieldset key={question.id}>
        <legend>ข้อ {index + 1}</legend>
        <div className="lesson-actions"><label>ชนิดคำถาม<select value={question.type} onChange={(event) => {
          const next = newQuestion(event.target.value as WorksheetQuestionType);
          questionEdit(question.id, { ...next, id: question.id, prompt: question.prompt, points: question.points });
        }}><option value="choice">เลือกตอบ</option><option value="boolean">ถูก / ผิด</option><option value="blank">เติมคำ</option></select></label>
        <label>คะแนน<input type="number" min={1} max={1000} value={question.points || ""} onChange={(event) => questionEdit(question.id, { points: Number(event.target.value) })} /></label>
        <button className="text-button danger" onClick={() => edit({ questions: editor.questions.filter((item) => item.id !== question.id) })}>ลบข้อ</button></div>
        <label>คำถาม<textarea rows={2} maxLength={4000} value={question.prompt} onChange={(event) => questionEdit(question.id, { prompt: event.target.value })} /></label>
        {question.type === "blank" ? <label>คำตอบที่ยอมรับได้ (หนึ่งคำตอบต่อบรรทัด)<textarea rows={3} value={question.acceptedAnswers.join("\n")} onChange={(event) => questionEdit(question.id, { acceptedAnswers: event.target.value.split("\n") })} /></label> : <>
          {question.choices.map((choice, option) => <div className="worksheet-option" key={option}>
            <input type="radio" aria-label={`คำตอบถูกข้อ ${index + 1} ตัวเลือก ${option + 1}`} checked={question.correctChoice === option} name={question.id} onChange={() => questionEdit(question.id, { correctChoice: option })} />
            {question.type === "boolean" ? <span>{choice}</span> : <><input aria-label={`ตัวเลือก ${option + 1}`} placeholder={`ตัวเลือก ${option + 1}`} maxLength={500} value={choice} onChange={(event) => questionEdit(question.id, { choices: question.choices.map((value, i) => i === option ? event.target.value : value) })} />
              {question.choices.length > 2 && <button className="text-button danger" onClick={() => questionEdit(question.id, { choices: question.choices.filter((_, i) => i !== option), correctChoice: question.correctChoice === null || question.correctChoice === option ? null : question.correctChoice - Number(question.correctChoice > option) })}>ลบตัวเลือก</button>}</>}
          </div>)}
          {question.type === "choice" && question.choices.length < 8 && <button className="text-button" onClick={() => questionEdit(question.id, { choices: [...question.choices, ""] })}>＋ เพิ่มตัวเลือก</button>}
        </>}
      </fieldset>)}</div>
      <button className="button button-quiet" disabled={editor.questions.length >= 100} onClick={() => edit({ questions: [...editor.questions, newQuestion("choice")] })}>＋ เพิ่มคำถาม</button>
    </fieldset>
    <section className="panel learning-panel">
      <h2>มอบหมายกิจกรรมให้ห้องเรียน</h2>
      {!editor.publishedTitle ? <p className="muted">เผยแพร่ใบงานก่อนมอบหมาย</p> : <div className="lesson-actions">
        <label>ห้องเรียน<select disabled={busy} value={classroomId} onChange={(event) => { setClassroomId(event.target.value); setLessonId(""); }}><option value="">เลือกห้องเรียน</option>{classrooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}</select></label>
        {classroomId && <LessonSelect classroomId={classroomId} value={lessonId} disabled={busy} onChange={setLessonId} />}
        <button className="button button-primary" disabled={busy || !classroomId} onClick={() => void action(async () => {
          await api(`/classrooms/${classroomId}/worksheets`, { method: "POST", body: JSON.stringify({ worksheetId: editor.id, lessonId: lessonId || null }) });
          setClassroomId(""); setLessonId(""); await refreshRounds();
        })}>สร้างรอบกิจกรรม</button>
      </div>}
      {editor.rounds.map((round) => <article className="worksheet-round" key={round.id}>
        <strong>{round.title} · {round.classroomName}</strong><span className="muted">{worksheetStatus[round.status]} · เต็ม {round.maxScore} คะแนน</span>
        <div className="lesson-actions">
          {round.status !== "closed" && <button className="button button-quiet" disabled={busy} onClick={() => void action(() => changeRound(round, { action: round.status === "open" ? "close" : "open" }))}>{round.status === "open" ? "ปิดรับคำตอบ" : "เปิดกิจกรรม"}</button>}
          <button className="button button-quiet" onClick={() => setResultsRound((current) => current?.id === round.id ? null : round)}>{resultsRound?.id === round.id ? "ซ่อนผล" : "ดูผล"}</button>
          <LessonSelect classroomId={round.classroomId} value={round.lessonId ?? ""} currentTitle={round.lessonTitle} disabled={busy} onChange={(value) => void action(() => changeRound(round, { action: "attach", lessonId: value || null }))} />
        </div>
        {resultsRound?.id === round.id && <WorksheetResults round={round} />}
      </article>)}
    </section>
  </section>;
}

function LessonSelect({ classroomId, value, currentTitle, disabled, onChange }: { classroomId: string; value: string; currentTitle?: string | null; disabled: boolean; onChange: (id: string) => void }) {
  const [lessons, setLessons] = useState<{ id: string; title: string }[]>([]);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLessons([]); setLoading(true); setError(false);
    api<typeof lessons>(`/classrooms/${classroomId}/lesson-pages`, { signal: controller.signal }).then((data) => { if (!controller.signal.aborted) setLessons(data); })
      .catch(() => { if (!controller.signal.aborted) setError(true); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [classroomId, retry]);
  return <label>แนบในบทเรียน <select value={value} disabled={disabled || loading || error} onChange={(event) => onChange(event.target.value)}><option value="">เฉพาะรายการกิจกรรม</option>
    {value && !lessons.some((lesson) => lesson.id === value) && <option value={value}>{currentTitle ?? "บทเรียนที่แนบไว้"}</option>}
    {lessons.map((lesson) => <option key={lesson.id} value={lesson.id}>{lesson.title}</option>)}
  </select>{error && <button className="text-button" onClick={() => setRetry((value) => value + 1)}>โหลดบทเรียนใหม่</button>}</label>;
}

function WorksheetResults({ round }: { round: Round }) {
  const [results, setResults] = useState<Results | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const result = await api<Results>(`/classrooms/${round.classroomId}/worksheets/${round.id}/results`, { signal: controller.signal });
        if (!controller.signal.aborted) { setResults(result); setError(""); }
      } catch (failure) { if (!controller.signal.aborted) setError((failure as Error).message); }
      finally { loading = false; }
    }
    void load();
    const interval = window.setInterval(() => { if (!document.hidden) void load(); }, 8000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [round.classroomId, round.id, round.status, retry]);
  return <div>
    {error && <p role="alert">{error} <button className="text-button" onClick={() => setRetry((value) => value + 1)}>ลองอีกครั้ง</button></p>}
    {results ? <div className="table-wrap"><table className="data-table"><thead><tr><th>เลขที่</th><th>นักเรียน</th><th>สถานะ</th><th>คะแนน</th><th>คำตอบ</th></tr></thead>
      <tbody>{results.students.map((student) => <tr key={student.id}><td>{student.studentNumber ?? "—"}</td><td>{student.displayName}</td><td>{student.submittedAt ? "ส่งแล้ว" : student.startedAt ? "เริ่มแล้ว" : "ยังไม่เริ่ม"}</td><td>{student.score === null ? "—" : `${student.score} / ${round.maxScore}`}</td><td>{student.answers && <details><summary>ดูคำตอบ</summary><ol>{results.questions.map((question) => {
        const answer = student.answers![question.id];
        return <li key={question.id}>{question.prompt} <strong>{typeof answer === "number" ? question.choices[answer] : answer || "—"}</strong></li>;
      })}</ol></details>}</td></tr>)}</tbody></table></div> : !error && <p role="status">กำลังโหลดผลใบงาน…</p>}
  </div>;
}
