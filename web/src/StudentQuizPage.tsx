import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { StudentAttendance } from "./StudentAttendance";

type Round = { roundId: string; quizId: string; classroomId: string; classroomName: string; title: string; status: "awaiting_open" | "open" | "closed"; durationMinutes: number | null; attemptId: string | null; finishedAt: string | null; score: string | null };
type Choice = { id: string; text: string; imageId: string | null };
type Question = { id: string; prompt: string; imageId: string | null; points: number; choices: Choice[]; selectedChoiceId: string | null; correctChoiceId?: string | null; isCorrect?: boolean; awardedPoints?: number; explanation?: string };
type Attempt = { id: string; roundId: string; title: string; description: string; status: string; revision: number; answers: Record<string, string | null>; startedAt: string; expiresAt: string | null; finishedAt: string | null; score: string | null; maxScore: number; solutionsReleased: boolean; questions: Question[] };

export function StudentQuizPage({ student }: { student: { displayName: string } }) {
  const quizId = window.location.pathname.split("/")[2] ?? "";
  const [rounds, setRounds] = useState<Round[]>([]); const [roundId, setRoundId] = useState("");
  const [attempt, setAttempt] = useState<Attempt | null>(null); const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false); const [saveState, setSaveState] = useState("ยังไม่มีคำตอบที่ต้องบันทึก");
  const [error, setError] = useState(""); const [now, setNow] = useState(Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSave = useRef<Promise<void> | null>(null);
  const submitting = useRef(false);
  const saveStateRef = useRef({ id: "", revision: 0, answers: {} as Record<string, string | null> });
  const selectedRound = rounds.find((round) => round.roundId === roundId) ?? rounds[0] ?? null;

  const loadRounds = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const next = await api<Round[]>(`/student/quizzes/${quizId}`);
      setRounds(next);
      const selected = next.find((round) => round.roundId === roundId) ?? next[0] ?? null;
      setRoundId(selected?.roundId ?? "");
      if (selected?.attemptId) await loadAttempt(selected.attemptId);
      else { setAttempt(null); setSaveState("ยังไม่มีคำตอบที่ต้องบันทึก"); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "โหลดแบบทดสอบไม่สำเร็จ"); }
    finally { setLoading(false); }
  }, [quizId]);
  useEffect(() => { void loadRounds(); }, [loadRounds]);

  const loadAttempt = useCallback(async (id: string) => {
    const next = await api<Attempt>(`/student/quiz-attempts/${id}`);
    setAttempt(next);
    saveStateRef.current = { id: next.id, revision: next.revision, answers: next.answers ?? {} };
    if (next.finishedAt) setSaveState("ส่งแล้ว");
  }, []);

  async function chooseRound(id: string) {
    setRoundId(id); setAttempt(null); setError("");
    const selected = rounds.find((round) => round.roundId === id);
    if (selected?.attemptId) {
      try { await loadAttempt(selected.attemptId); }
      catch (reason) { setError(reason instanceof Error ? reason.message : "โหลดคำตอบไม่สำเร็จ"); }
    }
  }

  async function start() {
    if (!selectedRound) return;
    setBusy(true); setError("");
    try { await loadAttempt((await api<Attempt>(`/student/quiz-rounds/${selectedRound.roundId}/start`, { method: "POST", body: JSON.stringify({}) })).id); await loadRoundsAfterStart(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "เริ่มแบบทดสอบไม่สำเร็จ"); }
    finally { setBusy(false); }
  }
  async function loadRoundsAfterStart() {
    const next = await api<Round[]>(`/student/quizzes/${quizId}`); setRounds(next);
  }

  const save = useCallback(async (answers: Record<string, string | null>) => {
    if (!attempt || attempt.finishedAt || !saveStateRef.current.id || pendingSave.current) return;
    const id = saveStateRef.current.id; const revision = saveStateRef.current.revision;
    setSaveState("กำลังบันทึก…");
    const operation = api<{ revision: number }>(`/student/quiz-attempts/${id}/answers`, { method: "PUT", body: JSON.stringify({ expectedRevision: revision, answers }) })
      .then((result) => {
        const latestAnswers = saveStateRef.current.answers;
        const changed = latestAnswers !== answers;
        saveStateRef.current = { id, revision: result.revision, answers: changed ? latestAnswers : answers };
        setAttempt((current) => current?.id === id ? { ...current, revision: result.revision, answers: changed ? latestAnswers : answers } : current);
        setSaveState(changed ? "รอบันทึก" : "บันทึกแล้ว");
        if (changed && !submitting.current) timer.current = setTimeout(() => { void save(latestAnswers); }, 0);
      })
      .catch((reason) => { setSaveState("รอบันทึกอีกครั้ง"); setError(reason instanceof Error ? reason.message : "บันทึกคำตอบไม่สำเร็จ"); })
      .finally(() => { if (pendingSave.current === operation) pendingSave.current = null; });
    pendingSave.current = operation;
    await operation;
  }, [attempt]);

  function answer(questionId: string, choiceId: string) {
    if (!attempt || attempt.finishedAt) return;
    const answers = { ...saveStateRef.current.answers, [questionId]: choiceId };
    saveStateRef.current.answers = answers;
    setAttempt((current) => current ? { ...current, answers, questions: current.questions.map((question) => question.id === questionId ? { ...question, selectedChoiceId: choiceId } : question) } : current);
    setSaveState("รอบันทึก"); setError("");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void save(answers); }, 600);
  }

  async function submit(expired = false) {
    if (!attempt || attempt.finishedAt) return;
    if (!expired) {
      const blank = attempt.questions.filter((question) => !saveStateRef.current.answers[question.id]).length;
      if (!window.confirm(`ยืนยันส่งแบบทดสอบหรือไม่? ยังไม่ได้ตอบ ${blank} ข้อ`)) return;
    }
    if (timer.current) clearTimeout(timer.current);
    setBusy(true); setError(""); submitting.current = true;
    try {
      if (pendingSave.current) await pendingSave.current;
      const done = await api<Attempt>(`/student/quiz-attempts/${attempt.id}/submit`, { method: "POST", body: JSON.stringify({ expectedRevision: saveStateRef.current.revision, answers: saveStateRef.current.answers }) });
      setAttempt(done); saveStateRef.current = { id: done.id, revision: done.revision, answers: done.answers }; setSaveState("ส่งแล้ว");
      await loadRoundsAfterStart();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "ส่งแบบทดสอบไม่สำเร็จ"); }
    finally { submitting.current = false; setBusy(false); }
  }

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);
  const secondsLeft = attempt?.expiresAt ? Math.max(0, Math.ceil((Date.parse(attempt.expiresAt) - now) / 1000)) : null;
  useEffect(() => {
    if (secondsLeft !== 0 || !attempt || attempt.finishedAt) return;
    void submit(true);
  }, [secondsLeft, attempt?.id, attempt?.finishedAt]);

  const imageUrl = (imageId: string) => `/api/student/quiz-attempts/${attempt?.id}/images/${imageId}`;
  const started = Boolean(attempt);
  const finished = Boolean(attempt?.finishedAt);
  return <main className="public-lesson-page student-quiz-page"><div className="public-lesson-brand"><a href="/">ห้องเรียน</a><span>นักเรียน · {student.displayName}</span></div><StudentAttendance />
    <section className="panel quiz-student-card"><header><div><p className="eyebrow">แบบทดสอบ</p><h1>{attempt?.title ?? selectedRound?.title ?? "แบบทดสอบ"}</h1></div><button className="text-button" onClick={() => window.location.assign("/")}>กลับหน้าหลัก</button></header>
      {loading ? <p className="inline-loading"><i className="spinner"/>กำลังโหลดแบบทดสอบ…</p> : error && !attempt ? <p className="form-error" role="alert">{error} <button className="text-button" onClick={() => void loadRounds()}>ลองอีกครั้ง</button></p> : !rounds.length ? <div className="empty"><span>▤</span><h2>ยังไม่มีรอบที่เข้าร่วมได้</h2><p>ตรวจสอบว่าครูเปิดรอบและเชื่อมบัญชี Google ของคุณกับรายชื่อห้องเรียนแล้ว</p></div> : <>
        {rounds.length > 1 && <label className="room-select">เลือกห้อง / รอบ<select value={selectedRound?.roundId ?? ""} onChange={(event) => void chooseRound(event.target.value)}>{rounds.map((round) => <option key={round.roundId} value={round.roundId}>{round.classroomName} · {round.title} · {round.status === "open" ? "เปิด" : round.status === "closed" ? "ปิด" : "รอเปิด"}</option>)}</select></label>}
        {!started && selectedRound && <div className="quiz-round-start"><p>{selectedRound.classroomName} · {selectedRound.durationMinutes ? `เวลา ${selectedRound.durationMinutes} นาที` : "ไม่จำกัดเวลา"}</p><p>{selectedRound.status === "awaiting_open" ? "ครูยังไม่เปิดแบบทดสอบ" : selectedRound.status === "closed" ? "รอบนี้ปิดแล้ว" : "เมื่อเริ่มแล้ว ระบบจะบันทึกความพยายามไว้ให้กลับมาทำต่อได้"}</p><button className="button button-primary" disabled={busy || selectedRound.status !== "open"} onClick={() => void start()}>{busy ? "กำลังเริ่ม…" : "เริ่มทำแบบทดสอบ"}</button></div>}
        {started && attempt && <><div className="quiz-attempt-summary"><div><strong>{attempt.questions.length} ข้อ · {attempt.maxScore} คะแนน</strong><small>{finished ? "ส่งคำตอบแล้ว" : "ความคืบหน้าบันทึกอัตโนมัติ"}</small></div>{secondsLeft !== null && !finished && <strong className="quiz-timer" aria-live="polite">เหลือ {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}</strong>}{finished && <strong className="quiz-score">คะแนน {attempt.score} / {attempt.maxScore}</strong>}</div>
          {attempt.description && <p className="quiz-description">{attempt.description}</p>}
          {error && <p className="form-error" role="alert">{error}{error.includes("อีกหน้าต่าง") && <button className="text-button" onClick={() => void loadAttempt(attempt.id)}>โหลดคำตอบล่าสุด</button>}</p>}
          <p className="muted" aria-live="polite">{saveState}</p>
          <div className="quiz-student-questions">{attempt.questions.map((question, index) => <article className="quiz-student-question" key={question.id}><h2>ข้อ {index + 1} <small>{question.points} คะแนน</small></h2><p>{question.prompt}</p>{question.imageId && <img src={imageUrl(question.imageId)} alt="ภาพคำถาม"/>}<fieldset disabled={finished || attempt.status === "closed"}><legend className="sr-only">คำตอบข้อ {index + 1}</legend>{question.choices.map((choice) => <label className="quiz-student-choice" key={choice.id}><input type="radio" name={question.id} checked={attempt.answers?.[question.id] === choice.id} onChange={() => answer(question.id, choice.id)}/><span>{choice.text}</span>{choice.imageId && <img src={imageUrl(choice.imageId)} alt="ภาพตัวเลือก"/>}{attempt.solutionsReleased && <span>{choice.id === question.correctChoiceId ? "✓ คำตอบถูก" : choice.id === question.selectedChoiceId && !question.isCorrect ? "คำตอบที่เลือก" : ""}</span>}</label>)}</fieldset>{attempt.solutionsReleased && <p className="quiz-explanation">{question.isCorrect ? `ถูกต้อง · ${question.awardedPoints} คะแนน` : "ยังไม่ถูกต้อง · 0 คะแนน"}{question.explanation ? ` — ${question.explanation}` : ""}</p>}</article>)}</div>
          {!finished && attempt.status !== "closed" && <button className="button button-primary" disabled={busy} onClick={() => void submit()}>{busy ? "กำลังส่ง…" : "ตรวจคำตอบและส่ง"}</button>}
          {finished && !attempt.solutionsReleased && <p className="notice">ส่งคำตอบแล้ว คะแนนรวมแสดงด้านบน ครูจะเปิดเฉลยหลังปิดรอบ</p>}
        </>}
      </>}
    </section>
  </main>;
}
