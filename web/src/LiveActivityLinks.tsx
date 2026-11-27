import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";
import "./live-activity.css";

export const liveActivityPath = (id: string) => "/activities/live/" + id;
const labels: Record<string, string> = {
  lobby: "รอเริ่ม", answering: "กำลังตอบ", revealed: "เฉลยแล้ว", discussion: "กำลังระดมความคิด", finished: "เสร็จแล้ว", cancelled: "ยกเลิก",
};
export const livePhaseLabel = (phase: string) => labels[phase] ?? phase;
type ActivityLink = { id: string; title: string; kind: "quiz" | "discussion"; phase: string; classroomName?: string; includeInGradebook?: boolean };
type Named = { id: string; title: string };
type ActivityList = { activities: ActivityLink[]; quizzes: Named[]; lessons: Named[] };
const message = (reason: unknown) => reason instanceof Error ? reason.message : "โหลดกิจกรรมสดไม่สำเร็จ";

export function LiveActivityLinks({ classroomId, lessonId }: { classroomId?: string; lessonId?: string }) {
  const [items, setItems] = useState<ActivityLink[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams();
    if (classroomId) query.set("classroomId", classroomId);
    if (lessonId) query.set("lessonId", lessonId);
    setItems([]); setError("");
    let loading = false;
    const load = async () => {
      if (loading || document.hidden) return;
      loading = true;
      try {
        const result = await api<ActivityLink[]>(`/student/live-activities?${query}`, { signal: controller.signal });
        if (!controller.signal.aborted) { setItems(result); setError(""); }
      } catch (reason) {
        if (!controller.signal.aborted) setError(message(reason));
      } finally { loading = false; }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 6000);
    window.addEventListener("focus", load);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener("focus", load); };
  }, [classroomId, lessonId]);

  if (!items.length && !error) return null;
  return <section className="panel live-links"><h2>กิจกรรมสด</h2>
    {error && <p className="notice" role="alert">{error}</p>}
    <div>{items.map((activity) => <a key={activity.id} className="live-link" href={liveActivityPath(activity.id)}>
      <strong>{activity.title}</strong><small>{activity.classroomName} · {livePhaseLabel(activity.phase)}</small>
      <span>{activity.phase === "finished" ? activity.kind === "discussion" ? "อ่านสรุป" : "ดูคะแนน" : "เข้าร่วม"} ↗</span>
    </a>)}</div>
  </section>;
}

export function TeacherLiveActivities({ classroomId }: { classroomId: string }) {
  const path = "/classrooms/" + classroomId + "/live-activities";
  const [data, setData] = useState<ActivityList | null>(null);
  const [kind, setKind] = useState<"quiz" | "discussion">("quiz");
  const [quizId, setQuizId] = useState("");
  const [lessonId, setLessonId] = useState("");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [seconds, setSeconds] = useState("30");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(""); setData(null);
    void api<ActivityList>(path, { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) setData(value);
    }).catch((reason) => { if (!controller.signal.aborted) setError(message(reason)); });
    return () => controller.abort();
  }, [path, retry]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setError(""); setBusy(true);
    try {
      const { id } = await api<{ id: string }>(path, { method: "POST", body: JSON.stringify({
        kind, title, quizId: kind === "quiz" ? quizId : undefined, prompt: kind === "discussion" ? prompt : undefined,
        lessonId: lessonId || undefined, questionSeconds: kind === "quiz" ? Number(seconds) : undefined,
      }) });
      window.location.assign(liveActivityPath(id));
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }

  const active = data?.activities.find((activity) => activity.phase !== "finished" && activity.phase !== "cancelled");
  return <section className="panel live-links">
    <header className="panel-heading"><div><h2>กิจกรรมสด</h2><p className="muted">เปิดห้องให้ผู้เรียนใช้ตัวละครเดินตอบคำถามหรือร่วมกันระดมความคิด</p></div></header>
    {error && <p className="notice" role="alert">{error} <button className="text-button" onClick={() => setRetry((value) => value + 1)}>โหลดรายการอีกครั้ง</button></p>}
    {!data ? !error && <p>กำลังโหลดกิจกรรม…</p> : active
      ? <a className="button button-primary" href={liveActivityPath(active.id)}>กลับเข้ากิจกรรม {active.title} ↗</a>
      : <form className="form-stack live-create" onSubmit={create}>
        <label>ประเภทกิจกรรม<select value={kind} onChange={(event) => setKind(event.target.value === "discussion" ? "discussion" : "quiz")}>
          <option value="quiz">เดินตอบแบบทดสอบ</option><option value="discussion">ระดมความคิดและสรุปบทเรียน</option>
        </select></label>
        {kind === "quiz" && <label>แบบทดสอบที่เผยแพร่แล้ว<select required value={quizId} onChange={(event) => setQuizId(event.target.value)}>
          <option value="">{data.quizzes.length ? "เลือกแบบทดสอบ" : "ยังไม่มีแบบทดสอบที่เผยแพร่แล้ว"}</option>
          {data.quizzes.map((quiz) => <option key={quiz.id} value={quiz.id}>{quiz.title}</option>)}
        </select></label>}
        <label>{kind === "quiz" ? "ชื่อกิจกรรม (ไม่บังคับ)" : "ชื่อกิจกรรม"}
          <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required={kind === "discussion"}/></label>
        {kind === "quiz" ? <label>เวลาต่อข้อ (วินาที)<input value={seconds} type="number" min={10} max={120} required onChange={(event) => setSeconds(event.target.value)}/></label>
          : <label>คำถามชวนคิด<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={1000} required/></label>}
        <label>เชื่อมกับบทเรียน<select value={lessonId} onChange={(event) => setLessonId(event.target.value)}>
          <option value="">ไม่เชื่อมบทเรียน</option>{data.lessons.map((lesson) => <option key={lesson.id} value={lesson.id}>{lesson.title}</option>)}
        </select></label>
        <button className="button button-primary" disabled={busy || (kind === "quiz" && !quizId)}>{busy ? "กำลังสร้างห้อง…" : "เปิดห้องรอ"}</button>
      </form>}
    {!!data?.activities.length && <div className="live-history"><h3>ประวัติกิจกรรม</h3>
      {data.activities.map((activity) => <a className="live-link" key={activity.id} href={liveActivityPath(activity.id)}>
        <strong>{activity.title}</strong><small>{livePhaseLabel(activity.phase)}{activity.includeInGradebook ? " · อยู่ในสมุดคะแนน" : ""}</small><span>เปิด ↗</span></a>)}
    </div>}
  </section>;
}
