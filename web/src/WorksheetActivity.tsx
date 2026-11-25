import { useEffect, useRef, useState } from "react";
import type { WorksheetAnswers, WorksheetPrompt } from "../../src/worksheet-core";
import { api, ApiError } from "./api";

export type WorksheetStatus = "awaiting_open" | "open" | "closed";
export type WorksheetRound = { id: string; title: string; classroomName: string; status: WorksheetStatus; maxScore: number };
type Attempt = { answers: WorksheetAnswers; revision: number; submittedAt: string | null; score: number | null };
type Activity = WorksheetRound & { questions: WorksheetPrompt[]; attempt: Attempt | null };

export const worksheetStatus: Record<WorksheetStatus, string> = { awaiting_open: "ยังไม่เปิด", open: "เปิดรับคำตอบ", closed: "ปิดรับคำตอบ" };

export function WorksheetActivity({ roundId, title }: { roundId: string; title?: string }) {
  const [activity, setActivity] = useState<Activity | null>(null);
  const [answers, setAnswers] = useState<WorksheetAnswers>({});
  const [savedAnswers, setSavedAnswers] = useState(answers);
  const [pending, setPending] = useState<"load" | "start" | "save" | "submit" | null>("load");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [reload, setReload] = useState(0);
  const inFlight = useRef(false);
  const path = `/student/worksheet-rounds/${roundId}`;
  const attempt = activity?.attempt;
  const dirty = answers !== savedAnswers;
  const editable = Boolean(attempt && !attempt.submittedAt && activity?.status === "open");

  useEffect(() => {
    const controller = new AbortController();
    setPending("load");
    api<Activity>(path, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      const loaded = result.attempt?.answers ?? {};
      setActivity(result); setAnswers(loaded); setSavedAnswers(loaded); setConflict(false); setError("");
    }).catch((failure) => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setPending(null); });
    return () => controller.abort();
  }, [path, reload]);

  async function update(action: "start" | "save" | "submit") {
    if (inFlight.current || (action !== "start" && !attempt)) return;
    inFlight.current = true;
    setPending(action); setError("");
    const sent = answers;
    try {
      const result = await api<Activity>(`${path}/${action === "save" ? "answers" : action}`, {
        method: action === "save" ? "PUT" : "POST",
        body: action === "start" ? undefined : JSON.stringify({ answers: sent, expectedRevision: attempt!.revision }),
      });
      setActivity(result);
      if (action === "save") setSavedAnswers(sent);
      else {
        const loaded = result.attempt?.answers ?? {};
        setAnswers(loaded); setSavedAnswers(loaded);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "ทำรายการไม่สำเร็จ");
      setConflict(failure instanceof ApiError && failure.status === 409);
    } finally { inFlight.current = false; setPending(null); }
  }

  useEffect(() => {
    if (!editable || !dirty || pending || error) return;
    const timeout = window.setTimeout(() => void update("save"), 700);
    return () => window.clearTimeout(timeout);
  }, [activity, answers, dirty, editable, error, pending, path]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const missing = activity?.questions.filter((question) => !(question.id in answers) || String(answers[question.id]).trim() === "").length ?? 0;
  return <section className="panel learning-panel">
    <h2>{activity?.title ?? title ?? "ใบงานกิจกรรม"}</h2>
    {activity && <p className="muted">{activity.classroomName} · {worksheetStatus[activity.status]} · เต็ม {activity.maxScore} คะแนน</p>}
    {pending === "load" && <p role="status">กำลังโหลดใบงาน…</p>}
    {error && <div className="notice" role="alert">{error} {(!activity || conflict) && <button className="text-button" disabled={Boolean(pending)} onClick={() => { if (!dirty || window.confirm("โหลดคำตอบที่บันทึกไว้? การแก้ไขล่าสุดในหน้านี้จะหายไป")) setReload((value) => value + 1); }}>โหลดใหม่</button>}</div>}
    {activity?.status === "open" && !attempt && <button className="button button-primary" disabled={Boolean(pending) || conflict} onClick={() => void update("start")}>เริ่มทำใบงาน</button>}
    {attempt?.submittedAt && <p className="worksheet-score">คะแนน {attempt.score} / {activity?.maxScore}</p>}
    {activity?.status === "closed" && !attempt?.submittedAt && <p className="muted">กิจกรรมปิดแล้ว · ยังไม่มีคะแนน</p>}
    {activity && attempt && <div className="worksheet-questions">{activity.questions.map((question, index) => <fieldset key={question.id} disabled={!editable || Boolean(pending && pending !== "save") || conflict}>
      <legend>{index + 1}. {question.prompt} <small>({question.points} คะแนน)</small></legend>
      {question.type === "blank" ? <input aria-label={`คำตอบข้อ ${index + 1}`} value={String(answers[question.id] ?? "")} maxLength={500} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} /> :
        question.choices.map((choice, option) => <label className="worksheet-option" key={option}><input type="radio" checked={answers[question.id] === option} name={`${roundId}-${question.id}`} onChange={() => setAnswers((current) => ({ ...current, [question.id]: option }))}/>{choice}</label>)}
    </fieldset>)}</div>}
    {editable && <div className="lesson-actions">
      <span role="status" className="muted">{pending === "save" ? "กำลังบันทึก…" : dirty ? "มีคำตอบที่ยังไม่บันทึก" : "บันทึกคำตอบแล้ว"}</span>
      {error && !conflict && <button className="button button-quiet" disabled={Boolean(pending)} onClick={() => void update("save")}>ลองบันทึกอีกครั้ง</button>}
      <button className="button button-primary" disabled={Boolean(pending) || conflict} onClick={() => { if (window.confirm(`ส่งใบงานและตรวจคะแนน? ยังไม่ได้ตอบ ${missing} ข้อ`)) void update("submit"); }}>ส่งใบงาน</button>
    </div>}
  </section>;
}
