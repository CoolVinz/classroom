import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "./api";

type TimetableDay = { weekday: number; startsAt: string; endsAt: string };
type Lesson = { date: string; startsAt: string; endsAt: string; cancelledAt: string | null; finalizedAt: string | null };
type TimetableData = { timetable: { termStartsOn: string; termEndsOn: string; graceMinutes: number } | null; weekdays: TimetableDay[]; lessons: Lesson[] };
const dayNames = ["จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์", "อาทิตย์"];

function bangkokToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
}

function displayDate(value: string) {
  return new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(value));
}

export function AttendanceTimetable({ classroomId, onError }: { classroomId: string; onError: (message: string) => void }) {
  const [data, setData] = useState<TimetableData | null>(null);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [grace, setGrace] = useState("10");
  const [days, setDays] = useState<Record<number, { startsAt: string; endsAt: string }>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await api<TimetableData>(`/classrooms/${classroomId}/timetable`);
      setData(result);
      if (result.timetable) {
        setStartDate(result.timetable.termStartsOn); setEndDate(result.timetable.termEndsOn); setGrace(String(result.timetable.graceMinutes));
        setDays(Object.fromEntries(result.weekdays.map((day) => [day.weekday, { startsAt: day.startsAt, endsAt: day.endsAt }])));
      } else {
        const start = bangkokToday();
        const end = new Date(Date.parse(start + "T12:00:00Z") + 365 * 86400000).toISOString().slice(0, 10);
        setStartDate(start); setEndDate(end); setDays({});
      }
    } catch (reason) { onError(reason instanceof Error ? reason.message : "โหลดตารางเรียนไม่สำเร็จ"); }
  }, [classroomId, onError]);
  useEffect(() => { void load(); }, [load]);

  function changeDay(weekday: number, field: "startsAt" | "endsAt", value: string) {
    setDays((current) => ({ ...current, [weekday]: { startsAt: current[weekday]?.startsAt ?? "09:00", endsAt: current[weekday]?.endsAt ?? "10:00", [field]: value } }));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setMessage("");
    try {
      await api(`/classrooms/${classroomId}/timetable`, { method: "PUT", body: JSON.stringify({
        termStartsOn: startDate, termEndsOn: endDate, graceMinutes: Number(grace),
        weekdays: Object.entries(days).map(([weekday, times]) => ({ weekday: Number(weekday), ...times })),
      }) });
      setMessage("บันทึกตารางเรียนแล้ว"); await load();
    } catch (reason) { onError(reason instanceof Error ? reason.message : "บันทึกตารางเรียนไม่สำเร็จ"); }
    finally { setSaving(false); }
  }

  async function cancel(lesson: Lesson) {
    if (!window.confirm(`ยกเลิกคาบเรียนวันที่ ${lesson.date} หรือไม่?`)) return;
    try { await api(`/classrooms/${classroomId}/lessons/${lesson.date}`, { method: "PATCH" }); await load(); }
    catch (reason) { onError(reason instanceof Error ? reason.message : "ยกเลิกคาบเรียนไม่สำเร็จ"); }
  }

  return <section className="panel attendance-timetable">
    <header className="panel-heading compact"><div><p className="eyebrow">ตั้งเวลาเช็กชื่ออัตโนมัติ</p><h2>ตารางเรียนประจำสัปดาห์</h2><p className="muted">นักเรียนที่เปิดห้องเรียนระหว่างเวลาเรียนจะถูกบันทึกโดยอัตโนมัติ</p></div></header>
    <details className="timetable-settings" open={!data?.timetable}>
      <summary>{data?.timetable ? "แก้ไขตารางและช่วงภาคเรียน" : "ตั้งค่าตารางเรียน"}</summary>
      <form onSubmit={(event) => void save(event)}>
        <div className="timetable-dates"><label>วันเริ่มภาคเรียน<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} required/></label><label>วันสิ้นสุด<input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} required/></label><label>มาสายหลังเริ่มเรียน (นาที)<input type="number" min="0" max="120" value={grace} onChange={(event) => setGrace(event.target.value)} required/></label></div>
        <div className="timetable-days">{dayNames.map((name, index) => { const weekday = index + 1; const selected = days[weekday]; return <div className="timetable-day" key={weekday}><label className="timetable-day-check"><input type="checkbox" checked={Boolean(selected)} onChange={(event) => setDays((current) => { const next = { ...current }; if (event.target.checked) next[weekday] = { startsAt: "09:00", endsAt: "10:00" }; else delete next[weekday]; return next; })}/>{name}</label>{selected && <><input aria-label={`${name} เวลาเริ่ม`} type="time" value={selected.startsAt} onChange={(event) => changeDay(weekday, "startsAt", event.target.value)} required/><span>ถึง</span><input aria-label={`${name} เวลาเลิก`} type="time" value={selected.endsAt} onChange={(event) => changeDay(weekday, "endsAt", event.target.value)} required/></>}</div>; })}</div>
        <div className="timetable-save"><small>เวลาใช้เขตเวลาไทย · บันทึกได้ไม่เกิน 1 ปีต่อครั้ง · เวลาเรียนที่เริ่มแล้วจะคงเดิม</small><button className="button button-primary" disabled={saving || !Object.keys(days).length}>{saving ? "กำลังบันทึก…" : "บันทึกตาราง"}</button></div>
      </form>
    </details>
    {message && <p className="success-message">{message}</p>}
    {data?.lessons.length ? <div className="upcoming-lessons"><h3>คาบเรียนที่กำหนดไว้</h3>{data.lessons.map((lesson) => <div className="upcoming-lesson" key={lesson.date}><span>{displayDate(lesson.startsAt)}–{new Intl.DateTimeFormat("th-TH", { timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(lesson.endsAt))}</span>{lesson.cancelledAt ? <small>ยกเลิกแล้ว</small> : lesson.finalizedAt ? <small>เช็กชื่อเสร็จแล้ว</small> : new Date(lesson.startsAt) > new Date() ? <button className="text-button danger" onClick={() => void cancel(lesson)}>ยกเลิกคาบ</button> : <small>เริ่มแล้ว</small>}</div>)}</div> : data?.timetable && <p className="muted timetable-empty">ไม่มีคาบเรียนที่กำหนดไว้</p>}
  </section>;
}
