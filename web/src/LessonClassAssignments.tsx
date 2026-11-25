import { useEffect, useState } from "react";
import { api } from "./api";

type ClassAssignments = { legacyPublic: boolean; classrooms: { id: string; name: string; assigned: boolean }[] };

export function LessonClassAssignments({ id, published, onError }: { id: string; published: boolean; onError: (message: string) => void }) {
  const [data, setData] = useState<ClassAssignments | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const path = `/lesson-pages/${id}/classrooms`;
  useEffect(() => {
    const controller = new AbortController();
    api<ClassAssignments>(path, { signal: controller.signal }).then((result) => { if (!controller.signal.aborted) setData(result); })
      .catch((error) => { if (!controller.signal.aborted) onError(error.message); });
    return () => controller.abort();
  }, [path, retry, onError]);
  async function toggle(room: ClassAssignments["classrooms"][number]) {
    if (!room.assigned && data?.legacyPublic && !window.confirm("มอบหมายบทเรียนนี้ให้ห้องเรียน? ลิงก์เดิมจะเปิดได้เฉพาะนักเรียนที่อยู่ในห้องที่เลือกและเข้าสู่ระบบแล้ว")) return;
    if (room.assigned && !window.confirm(`นำบทเรียนออกจากห้อง ${room.name}? ใบงานที่แนบจะยังอยู่ในรายการกิจกรรมของห้อง`)) return;
    setBusy(true);
    try {
      await api(`${path}/${room.id}`, { method: room.assigned ? "DELETE" : "PUT" });
      setData((current) => current && { legacyPublic: false, classrooms: current.classrooms.map((item) => item.id === room.id ? { ...item, assigned: !room.assigned } : item) });
    } catch (error) { onError((error as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="panel learning-panel">
    <h2>ห้องเรียนที่ได้รับบทเรียน</h2>
    {!published ? <p className="muted">เผยแพร่บทเรียนก่อนเพิ่มห้องเรียน</p> : <p className="muted">นักเรียนในห้องที่เลือกจะเห็นบทเรียนในหน้าห้องเรียนของตน</p>}
    {data?.legacyPublic && published && <p className="muted">ลิงก์นี้เปิดสาธารณะอยู่ การมอบหมายครั้งแรกจะจำกัดให้เฉพาะนักเรียนในห้องที่เลือก <a href={`/lessons/${id}`} target="_blank" rel="noreferrer">ดูหน้าสาธารณะ</a></p>}
    {data ? data.classrooms.length ? <div className="lesson-actions">{data.classrooms.map((room) => <label className="worksheet-option" key={room.id}>
      <input type="checkbox" checked={room.assigned} disabled={busy || (!published && !room.assigned)} onChange={() => void toggle(room)} />{room.name}
    </label>)}</div> : <p className="muted">ยังไม่มีห้องเรียนที่เปิดอยู่</p> : <button className="text-button" onClick={() => setRetry((value) => value + 1)}>โหลดห้องเรียนใหม่</button>}
  </section>;
}
