import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

type Lesson = {
  classroomId: string; classroomName: string; date: string; startsAt: string; endsAt: string;
  graceMinutes: number; firstArrivalAt: string | null; lastSeenAt: string | null;
  visibleSeconds: number | null; attendanceStatus: "present" | "late" | "absent" | "excused" | null;
};

function showTime(value: string) {
  return new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(value));
}

export function StudentAttendance() {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState("");
  const [tracking, setTracking] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setLessons(await api<Lesson[]>("/student/lessons")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "โหลดเวลาเรียนไม่สำเร็จ"); }
  }, []);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 60000); return () => clearInterval(timer); }, [load]);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(tick); document.removeEventListener("visibilitychange", refresh); };
  }, [load]);

  const active = lessons.filter((lesson) => now >= Date.parse(lesson.startsAt) && now < Date.parse(lesson.endsAt));
  useEffect(() => {
    if (active.length === 1) setSelected(active[0].classroomId);
    else if (!active.some((lesson) => lesson.classroomId === selected)) setSelected("");
  }, [active.map((lesson) => lesson.classroomId).join(","), selected]);

  const selectedLesson = active.length === 1 ? active[0] : active.find((lesson) => lesson.classroomId === selected);
  useEffect(() => {
    let viewId = crypto.randomUUID();
    let sequence = 0;
    let wasActive = false;
    let lastSent = 0;
    const lesson = selectedLesson;
    const path = lesson ? `/api/student/classrooms/${lesson.classroomId}/attendance/presence` : "";

    function send(activeNow: boolean, beacon = false) {
      if (!lesson || (!activeNow && !wasActive)) return;
      const body = JSON.stringify({ lessonDate: lesson.date, viewId, sequence: ++sequence, active: activeNow });
      wasActive = activeNow; lastSent = Date.now(); setTracking(activeNow);
      if (beacon && navigator.sendBeacon) {
        navigator.sendBeacon(path, new Blob([body], { type: "application/json" }));
      } else if (activeNow) {
        void api<{ accepted: boolean; reason?: string }>(path.replace("/api", ""), { method: "POST", body })
          .then((result) => { setTracking(result.accepted); if (result.accepted) void load(); else if (result.reason === "another-window" || result.reason === "another-classroom") setError("กำลังเช็กชื่อจากอีกหน้าต่างหรืออีกห้องเรียน"); })
          .catch(() => { setTracking(false); });
      } else {
        void api(path.replace("/api", ""), { method: "POST", body }).catch(() => {});
      }
    }

    function update() {
      const activeNow = Boolean(lesson && document.visibilityState === "visible" && document.hasFocus()
        && Date.now() >= Date.parse(lesson.startsAt) && Date.now() < Date.parse(lesson.endsAt));
      if (activeNow && (!wasActive || Date.now() - lastSent >= 30000)) send(true);
      else if (!activeNow && wasActive) send(false);
    }
    const timer = setInterval(update, 1000);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    update();
    return () => {
      clearInterval(timer); document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update); window.removeEventListener("blur", update);
      if (wasActive && lesson && navigator.sendBeacon) {
        navigator.sendBeacon(path, new Blob([JSON.stringify({ lessonDate: lesson.date, viewId, sequence: ++sequence, active: false })], { type: "application/json" }));
      }
      setTracking(false);
    };
  }, [selectedLesson?.classroomId, selectedLesson?.date, selectedLesson?.startsAt, selectedLesson?.endsAt, load]);

  if (!lessons.length) return null;
  return <section className="panel student-attendance"><header className="panel-heading compact"><div><p className="eyebrow">เช็กชื่ออัตโนมัติ</p><h2>เวลาเรียนวันนี้</h2><p className="muted">เปิดหน้านี้ในช่วงเวลาเรียน ระบบจะบันทึกเวลาเข้าและเวลาที่เปิดหน้านี้</p></div></header>
    {error && <p className="form-error attendance-error" role="alert">{error}</p>}
    {active.length > 1 && <label className="overlap-select">มีคาบเรียนพร้อมกัน กรุณาเลือกห้อง<select value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">เลือกห้องเรียน</option>{active.map((lesson) => <option key={lesson.classroomId} value={lesson.classroomId}>{lesson.classroomName}</option>)}</select></label>}
    <div className="student-lessons">{lessons.map((lesson) => {
      const isActive = now >= Date.parse(lesson.startsAt) && now < Date.parse(lesson.endsAt);
      return <article className="student-lesson" key={lesson.classroomId}>
        <div><strong>{lesson.classroomName}</strong><small>{showTime(lesson.startsAt)}–{new Intl.DateTimeFormat("th-TH", { timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(lesson.endsAt))}</small></div>
        <div className="student-lesson-result">{lesson.firstArrivalAt ? <><b>{lesson.attendanceStatus === "late" ? "มาสาย" : lesson.attendanceStatus === "absent" ? "ครูบันทึกว่าขาด" : lesson.attendanceStatus === "excused" ? "ครูบันทึกว่าลา" : "บันทึกเวลาเข้าแล้ว"}</b><small>{showTime(lesson.firstArrivalAt)} · เปิดหน้าเรียน {Math.floor(Number(lesson.visibleSeconds ?? 0) / 60)} นาที{selectedLesson?.classroomId === lesson.classroomId && tracking ? " · กำลังนับเวลา" : ""}</small></> : isActive ? <b>{selectedLesson?.classroomId === lesson.classroomId ? tracking ? "กำลังนับเวลาเรียน…" : "กำลังเชื่อมต่อเวลาเรียน…" : "เลือกห้องเพื่อเริ่มเช็กชื่อ"}</b> : now < Date.parse(lesson.startsAt) ? <small>ยังไม่ถึงเวลาเรียน</small> : <small>ยังไม่มีการบันทึก</small>}</div>
      </article>;
    })}</div>
  </section>;
}
