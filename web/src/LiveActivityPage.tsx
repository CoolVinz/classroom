import { useEffect, useRef, useState, type FormEvent } from "react";
import type { QuizChoice } from "../../src/quiz-core";
import type { ActivityKind, CloudTerm, PollSnapshot } from "../../src/live-activity-content";
import { ApiError, api } from "./api";
import { LiveActivityArena } from "./LiveActivityArena";
import { liveActivityPath, livePhaseLabel } from "./LiveActivityLinks";
import { StudentAttendance } from "./StudentAttendance";
import "./live-activity.css";

type Idea = { id: string; text: string; approved: boolean; mine: boolean; author: string | null };
type Activity = {
  id: string; classroomId: string; classroomName: string; title: string; teacher: boolean;
  kind: ActivityKind; phase: "lobby" | "answering" | "revealed" | "discussion" | "finished" | "cancelled";
  questionIndex: number; questionCount: number; deadline: string | null; serverNow: number; revision: number;
  joined: boolean; selected: number | null; score: number | null; maxScore: number; includeInGradebook: boolean;
  prompt: string | null; recap: string | null; ideas: Idea[];
  poll: (PollSnapshot & { counts: number[] | null; voted: number | null }) | null;
  terms: CloudTerm[];
  question: { id: string; prompt: string; imageId: string | null; points: number; choices: QuizChoice[] } | null;
  reveal: { correctChoiceId: string | null; explanation: string; counts: number[] } | null;
};
type Result = { id: string; displayName: string; studentNumber: number | null; joined: boolean; score: number | null };
const reasonText = (reason: unknown) => reason instanceof Error ? reason.message : "ทำรายการไม่สำเร็จ";
const isEnded = (activity: Activity) => activity.phase === "finished" || activity.phase === "cancelled";

function Countdown({ deadline, offset }: { deadline: string; offset: number }) {
  const timeLeft = () => Math.max(0, Math.ceil((Date.parse(deadline) - Date.now() - offset) / 1000));
  const [seconds, setSeconds] = useState(timeLeft);
  useEffect(() => {
    const update = () => setSeconds(timeLeft());
    update();
    const timer = setInterval(update, 200);
    return () => clearInterval(timer);
  }, [deadline, offset]);
  return <span className={`live-clock${seconds <= 5 ? " urgent" : ""}`} role="timer" aria-label="เวลาที่เหลือ">{seconds} วิ.</span>;
}

function PollResults({ choices, counts }: { choices: string[]; counts: number[] }) {
  const total = counts.reduce((sum, count) => sum + count, 0);
  return <section className="panel live-card" aria-label="ผลโหวต">
    <h2>ผลโหวต</h2><p>{total ? `มีผู้โหวต ${total} คน` : "ยังไม่มีผู้โหวต"}</p>
    <ul className="live-poll-results">{choices.map((choice, index) => {
      const count = counts[index];
      return <li key={index}><div><strong>{choice}</strong><span>{count} คน · {total ? Math.round(count * 100 / total) : 0}%</span></div>
        <progress aria-label={choice} value={count} max={total || 1}/></li>;
    })}</ul>
  </section>;
}

function Cloud({ terms }: { terms: CloudTerm[] }) {
  return <div className="live-cloud">
    <h3>กลุ่มคำของห้อง</h3>
    {!terms.length ? <p className="muted">คำที่ครูอนุมัติจะแสดงที่นี่</p> : <>
      <ul className="live-cloud-terms" aria-hidden="true">{terms.slice(0, 30).map((term) => <li key={term.text}
        style={{ fontSize: `${1 + (term.count - 1) / Math.max(1, terms[0].count - 1) * 1.25}rem` }}>{term.text}</li>)}</ul>
      <details><summary>รายการคำและจำนวน ({terms.length})</summary>
        <ul className="live-cloud-list">{terms.map((term) => <li key={term.text}><span>{term.text}</span><span>{term.count} ครั้ง</span></li>)}</ul>
      </details>
    </>}
  </div>;
}

export default function LiveActivityPage({ id, student }: { id: string; student: boolean }) {
  const path = "/live-activities/" + id;
  const [activity, setActivity] = useState<Activity | null>(null);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [idea, setIdea] = useState("");
  const [recap, setRecap] = useState("");
  const [copy, setCopy] = useState<"copied" | "fallback">();
  const [results, setResults] = useState<Result[] | null>(null);
  const offset = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      try {
        const start = Date.now();
        const value = await api<Activity>(path, { signal: controller.signal });
        if (controller.signal.aborted) return;
        offset.current = value.serverNow - (Date.now() + start) / 2;
        setActivity(value); setLoadError("");
        if (!isEnded(value)) timer = setTimeout(() => { void read(); }, 850);
      } catch (reason) {
        if (controller.signal.aborted) return;
        setLoadError(reasonText(reason));
        if (reason instanceof ApiError && (reason.status === 401 || reason.status === 404)) setActivity(null);
        else timer = setTimeout(() => { void read(); }, 2200);
      }
    }
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [path, refresh]);

  const finishedQuiz = activity?.phase === "finished" && activity.kind === "quiz" && activity.teacher;
  useEffect(() => {
    if (!finishedQuiz) return;
    const controller = new AbortController();
    void api<Result[]>(path + "/results", { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) setResults(value);
    }).catch((reason) => { if (!controller.signal.aborted) setActionError(reasonText(reason)); });
    return () => controller.abort();
  }, [finishedQuiz, path, refresh]);

  async function mutate(suffix: string, method: string, body: object) {
    if (busy) return false;
    setBusy(true); setActionError("");
    try {
      await api(path + suffix, { method, body: JSON.stringify(body) });
      return true;
    } catch (reason) {
      setActionError(reasonText(reason));
      return false;
    } finally {
      setRefresh((value) => value + 1);
      setBusy(false);
    }
  }

  function command(action: string) {
    if (!activity || (action === "cancel" && !window.confirm(activity.kind === "quiz"
      ? "ยกเลิกกิจกรรมสดนี้หรือไม่? คะแนนจะไม่เข้าสมุดคะแนน" : "ยกเลิกกิจกรรมสดนี้หรือไม่?"))) return;
    void mutate("/command", "POST", { action, revision: activity.revision, recap: action === "finish" ? recap : undefined });
  }

  async function submitIdea(event: FormEvent) {
    event.preventDefault();
    if (await mutate("/ideas", "POST", { text: idea })) setIdea("");
  }

  async function includeGrade(include: boolean) {
    if (!activity || busy) return;
    setActivity({ ...activity, includeInGradebook: include });
    if (!await mutate("/gradebook", "PUT", { include })) {
      setActivity((current) => current ? { ...current, includeInGradebook: activity.includeInGradebook } : current);
    }
  }

  const link = window.location.origin + liveActivityPath(id);
  async function copyLink() {
    try { await navigator.clipboard.writeText(link); setCopy("copied"); }
    catch { setCopy("fallback"); }
  }
  const question = activity && (activity.joined || activity.teacher) ? activity.question : null;
  const poll = activity?.poll;
  const cloud = activity?.kind === "word-cloud";
  const walkPoll = poll?.mode === "walk";
  const choices = question?.choices ?? (walkPoll ? poll.choices.map((text, index) => ({ id: String(index), text, imageId: null })) : []);
  const myIdeaCount = activity?.ideas.filter((item) => item.mine).length ?? 0;
  return <main className="live-page">
    <header className="live-header"><div><a href="/">← ห้องเรียน</a><small>{activity?.classroomName ?? "กิจกรรมสด"}</small>
      <h1>{activity?.title ?? "ห้องกิจกรรม"}</h1></div>
      {activity && <span className="live-phase">{livePhaseLabel(activity.phase)}</span>}</header>
    {student && <div className="live-attendance"><StudentAttendance/></div>}
    {loadError && <p className="notice" role="alert">{loadError} <button className="text-button" onClick={() => setRefresh((value) => value + 1)}>ลองโหลดใหม่</button></p>}
    {actionError && <p className="notice" role="alert">{actionError}</p>}
    {!activity ? !loadError && <p role="status">กำลังโหลดกิจกรรม…</p> : <>
      {activity.teacher && !isEnded(activity) && <section className="panel live-host" aria-label="ควบคุมกิจกรรม">
        <div className="live-host-actions">
          <button className="button button-quiet" onClick={() => void copyLink()}>คัดลอกลิงก์เข้าห้อง</button>
          {activity.phase === "lobby" && <button className="button button-primary" disabled={busy} onClick={() => command(activity.kind === "quiz" ? "next" : "open")}>เริ่มกิจกรรม</button>}
          {activity.phase === "answering" && <button className="button button-primary" disabled={busy} onClick={() => command("lock")}>{poll ? "ปิดโหวต" : "ล็อกและเฉลย"}</button>}
          {activity.phase === "revealed" && <button className="button button-primary" disabled={busy} onClick={() => command(activity.questionIndex + 1 < activity.questionCount ? "next" : "finish")}>
            {activity.questionIndex + 1 < activity.questionCount ? "ข้อถัดไป" : "จบแบบทดสอบ"}</button>}
          <button className="button button-quiet" disabled={busy} onClick={() => command("cancel")}>ยกเลิกกิจกรรม</button>
        </div>
        {copy === "copied" && <small role="status">คัดลอกลิงก์แล้ว</small>}
        {copy === "fallback" && <input aria-label="ลิงก์เข้าห้อง" readOnly value={link} onFocus={(event) => event.target.select()}/>}
      </section>}
      {activity.phase === "lobby" && <section className="panel live-card">
        <h2>ห้องรอ</h2><p>{activity.teacher ? "เปิดลิงก์ให้นักเรียน แล้วเริ่มกิจกรรมเมื่อทุกคนพร้อม" : "เดินเล่นกับเพื่อนระหว่างรอครูเริ่มกิจกรรม"}</p>
      </section>}
      {question && <section className="panel live-card live-question">
        <div><small>ข้อ {activity.questionIndex + 1} / {activity.questionCount} · {question.points} คะแนน</small>
          <h2>{question.prompt || "ดูภาพคำถาม"}</h2></div>
        {activity.deadline && <Countdown deadline={activity.deadline} offset={offset.current}/>}
        {question.imageId && <img src={`/api${path}/images/${question.imageId}`} alt="ภาพคำถาม"/>}
      </section>}
      {poll && <section className="panel live-card live-question">
        <div><small>{poll.mode === "private" ? "กดปุ่มส่วนตัว" : "เดินเข้าพื้นที่โหวต"}</small><h2>{activity.prompt}</h2>
          {poll.voted !== null && <p>โหวตแล้ว {poll.voted} คน</p>}</div>
        {activity.deadline && <Countdown deadline={activity.deadline} offset={offset.current}/>}
      </section>}
      {!isEnded(activity) && <LiveActivityArena id={id} path={path} questionIndex={activity.questionIndex} teacher={activity.teacher}
        answering={activity.phase === "answering" && choices.length > 0} choices={choices} correctChoiceId={activity.reveal?.correctChoiceId}
        selected={activity.selected} walkPoll={walkPoll}/>}
      {poll?.mode === "private" && activity.phase === "answering" && <section className="panel live-card" aria-label="ตัวเลือกโหวต">
        <div className="live-options live-private-options">{poll.choices.map((choice, index) => <button type="button" key={index}
          disabled={activity.teacher || !activity.joined || busy} aria-pressed={activity.selected === index}
          onClick={() => void mutate("/vote", "PUT", { choiceIndex: index })}>{choice}</button>)}</div>
        {!activity.teacher && <p role="status">{activity.selected === null ? "เลือกคำตอบเพื่อโหวต" : `บันทึกโหวตแล้ว · ${poll.choices[activity.selected]}`}</p>}
        {!activity.teacher && activity.selected !== null && <button className="text-button" disabled={busy}
          onClick={() => void mutate("/vote", "PUT", { choiceIndex: null })}>ล้างโหวต</button>}
      </section>}
      {poll?.counts && <PollResults choices={poll.choices} counts={poll.counts}/>}
      {activity.reveal && question && <section className="panel live-card">
        <h2>ผลคำตอบ</h2><div className="live-counts">{activity.reveal.counts.map((count, index) => <span key={choices[index].id}>
          <b>{String.fromCharCode(65 + index)}</b> {count} คน</span>)}</div>
        {activity.reveal.explanation && <p>{activity.reveal.explanation}</p>}
        {activity.score !== null && <p><strong>คะแนนของคุณ {activity.score} / {activity.maxScore}</strong></p>}
      </section>}
      {(activity.kind === "discussion" || cloud) && ["discussion", "finished"].includes(activity.phase) && <section className="panel live-card live-discussion">
        <h2>{cloud ? "กลุ่มคำสด" : "ระดมความคิด"}</h2><p>{activity.prompt}</p>
        {cloud && <Cloud terms={activity.terms}/>}
        {!activity.teacher && activity.phase === "discussion" && activity.joined && (myIdeaCount < 3
          ? <form className="form-stack" onSubmit={submitIdea}><label>{cloud ? "คำหรือวลีของคุณ" : "ความคิดของคุณ"} ({myIdeaCount}/3)
            {cloud ? <input required maxLength={40} value={idea} onChange={(event) => setIdea(event.target.value)}/>
              : <textarea required maxLength={500} value={idea} onChange={(event) => setIdea(event.target.value)}/>}</label>
            <button className="button button-primary" disabled={busy || !idea.trim()}>ส่งให้ครูตรวจ</button></form>
          : <p className="muted">ส่งครบสามรายการแล้ว</p>)}
        {!!activity.ideas.length && <ul className="live-ideas">{activity.ideas.filter((entry) => !cloud || activity.teacher || entry.mine).map((entry) => <li key={entry.id}>
          <p>{entry.text}</p><small>{entry.author && `${entry.author} · `}{entry.approved ? "เผยแพร่แล้ว" : "รอครูเผยแพร่"}</small>
          {activity.teacher && <button className="text-button" disabled={busy} onClick={() => void mutate("/ideas/" + entry.id, "PUT", { approved: !entry.approved })}>
            {entry.approved ? "ซ่อนความคิด" : "เผยแพร่ความคิด"}</button>}</li>)}</ul>}
        {activity.teacher && activity.phase === "discussion" && <form className="form-stack" onSubmit={(event) => { event.preventDefault(); command("finish"); }}>
          <label>{cloud ? "สรุปบทเรียน (ไม่บังคับ)" : "สรุปบทเรียน"}<textarea value={recap} onChange={(event) => setRecap(event.target.value)} maxLength={4000} rows={5} required={!cloud}/></label>
          <button className="button button-primary" disabled={busy || (!cloud && !recap.trim())}>{cloud ? "บันทึกกลุ่มคำและจบกิจกรรม" : "เผยแพร่สรุปและจบกิจกรรม"}</button></form>}
        {activity.recap && <div className="live-recap"><h3>สรุปบทเรียน</h3><p>{activity.recap}</p></div>}
      </section>}
      {activity.kind === "quiz" && activity.phase === "finished" && <section className="panel live-card">
        <h2>จบแบบทดสอบ</h2>
        {!activity.teacher && <p>{activity.score === null ? "คุณไม่ได้เข้าร่วมในรอบนี้" : `คะแนนของคุณ ${activity.score} / ${activity.maxScore}`}</p>}
        {activity.teacher && <><p>คะแนนเต็ม {activity.maxScore}</p>
          <label className="live-gradebook-switch"><input type="checkbox" checked={activity.includeInGradebook} disabled={busy}
            onChange={(event) => void includeGrade(event.target.checked)}/> รวมคะแนนนี้ในสมุดคะแนน</label>
          {results ? <div className="table-wrap"><table className="data-table"><thead><tr><th>เลขที่</th><th>นักเรียน</th><th>คะแนน</th></tr></thead>
            <tbody>{results.map((row) => <tr key={row.id}><td>{row.studentNumber ?? "—"}</td><td>{row.displayName}</td><td>{row.joined ? row.score ?? "—" : "ไม่ได้เข้าร่วม"}</td></tr>)}</tbody></table></div>
            : <p className="muted">กำลังโหลดผล…</p>}</>}
      </section>}
      {activity.phase === "cancelled" && <section className="panel live-card"><h2>กิจกรรมถูกยกเลิก</h2><a href="/">กลับห้องเรียน</a></section>}
    </>}
  </main>;
}
