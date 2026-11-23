import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

type Member = { studentId: string; displayName: string; studentNumber: number | null };
type StudentGroup = { id: string; name: string; members: Member[] };
type GroupSet = { setId: string; classroomId: string; classroomName: string; title: string; studentLimit: number | null; groupLimit: number | null; status: "open" | "locked"; myGroupId: string | null; groups: StudentGroup[]; unassigned: Member[] };

export function StudentGroups({ onError, refreshVersion }: { onError: (message: string) => void; refreshVersion: number }) {
  const [sets, setSets] = useState<GroupSet[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await api<GroupSet[]>("/student/group-sets", { signal });
      if (!signal?.aborted) setSets(next);
    } catch (reason) {
      if (!signal?.aborted) onError(reason instanceof Error ? reason.message : "โหลดกลุ่มไม่สำเร็จ");
    }
  }, [onError]);
  useEffect(() => {
    if (!refreshVersion) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refreshVersion]);
  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    try { await work(); await load(); }
    catch (reason) { onError(reason instanceof Error ? reason.message : "บันทึกกลุ่มไม่สำเร็จ"); }
    finally { setBusy(false); }
  }
  if (!sets.length) return null;
  return <section className="panel student-groups"><header className="panel-heading compact"><div><h2>กลุ่มของฉัน</h2><p className="muted">เข้ากลุ่มที่ครูเปิดไว้ หรือสร้างกลุ่มเอง</p></div><button className="text-button" onClick={() => void load()}>โหลดใหม่</button></header>
    <div className="student-group-list">{sets.map((set) => {
      const mine = set.groups.find((group) => group.id === set.myGroupId);
      return <article className="student-group-set" key={set.setId}><header><div><strong>{set.classroomName} · {set.title}</strong><small>{set.status === "open" ? "เปิดให้นักเรียนจัดกลุ่ม" : "ล็อกแล้ว · ดูรายชื่อได้"} · {set.studentLimit ? `${set.studentLimit} คน/กลุ่ม` : "ไม่จำกัดคน/กลุ่ม"}</small></div>{mine && set.status === "open" && <button className="text-button" disabled={busy} onClick={() => void act(() => api(`/student/classrooms/${set.classroomId}/group-sets/${set.setId}/membership`, { method: "DELETE" }))}>ออกจากกลุ่ม</button>}</header>
        <div className="group-columns">{set.groups.map((group) => { const full = set.studentLimit !== null && group.members.length >= set.studentLimit; return <div className={group.id === set.myGroupId ? "group-box mine" : "group-box"} key={group.id}><strong>{group.name}</strong><small>{group.members.length}{set.studentLimit ? `/${set.studentLimit}` : ""} คน</small><ul>{group.members.map((member) => <li key={member.studentId}>{member.studentNumber ?? "—"}. {member.displayName}</li>)}</ul>{set.status === "open" && group.id !== set.myGroupId && <button className="button button-quiet" disabled={busy || full} onClick={() => void act(() => api(`/student/classrooms/${set.classroomId}/group-sets/${set.setId}/groups/${group.id}/join`, { method: "POST" }))}>{full ? "เต็มแล้ว" : mine ? "ย้ายเข้ากลุ่มนี้" : "เข้ากลุ่มนี้"}</button>}</div>; })}</div>
        {set.status === "open" && !mine && <form className="student-create-group" onSubmit={(event) => { event.preventDefault(); const name = names[set.setId]?.trim(); if (!name) return; void act(async () => { await api(`/student/classrooms/${set.classroomId}/group-sets/${set.setId}/groups`, { method: "POST", body: JSON.stringify({ name }) }); setNames((all) => ({ ...all, [set.setId]: "" })); }); }}><label>สร้างกลุ่มของคุณ<input maxLength={80} required value={names[set.setId] ?? ""} onChange={(e) => setNames((all) => ({ ...all, [set.setId]: e.target.value }))} placeholder="ชื่อกลุ่ม" /></label><button className="button button-primary" disabled={busy || (set.groupLimit !== null && set.groups.length >= set.groupLimit)}>สร้างกลุ่ม</button>{set.groupLimit !== null && set.groups.length >= set.groupLimit && <small>ครบจำนวนกลุ่มแล้ว</small>}</form>}
      </article>;
    })}</div>
  </section>;
}
