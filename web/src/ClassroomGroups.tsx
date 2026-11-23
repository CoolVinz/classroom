import { useEffect, useState } from "react";
import { api } from "./api";

type Member = { studentId: string; displayName: string; studentNumber: number | null };
type Group = { id: string; name: string; creatorStudentId: string | null; members: Member[] };
type GroupSet = { id: string; title: string; studentLimit: number | null; groupLimit: number | null; status: "draft" | "open" | "locked" | "archived"; revision: number; groups: Group[] };
type Student = Member;
type Preview = { revision: number; rosterFingerprint: string; groups: { name: string; studentIds: string[] }[]; unassigned: string[] };

const stateLabel = { draft: "ฉบับร่าง · นักเรียนยังไม่เห็น", open: "เปิดให้นักเรียนจัดกลุ่ม", locked: "ล็อกแล้ว · ดูได้อย่างเดียว", archived: "เก็บแล้ว" };

export function ClassroomGroups({ classroomId, onError }: { classroomId: string; onError: (message: string) => void }) {
  const [sets, setSets] = useState<GroupSet[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [title, setTitle] = useState("");
  const [studentLimit, setStudentLimit] = useState("3");
  const [groupLimit, setGroupLimit] = useState("12");
  const [groupNames, setGroupNames] = useState<Record<string, string>>({});
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [busy, setBusy] = useState(false);

  async function load() {
    try { const result = await api<{ sets: GroupSet[]; students: Student[] }>(`/classrooms/${classroomId}/group-sets`); setSets(result.sets); setStudents(result.students); }
    catch (reason) { onError(reason instanceof Error ? reason.message : "โหลดกลุ่มไม่สำเร็จ"); }
  }
  useEffect(() => { void load(); }, [classroomId]);

  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    try { await work(); setPreviews({}); await load(); }
    catch (reason) { onError(reason instanceof Error ? reason.message : "บันทึกกลุ่มไม่สำเร็จ"); }
    finally { setBusy(false); }
  }

  function createSet(event: React.FormEvent) {
    event.preventDefault();
    void act(async () => {
      await api(`/classrooms/${classroomId}/group-sets`, { method: "POST", body: JSON.stringify({ title, studentLimit: studentLimit ? Number(studentLimit) : null, groupLimit: groupLimit ? Number(groupLimit) : null }) });
      setTitle("");
    });
  }

  async function randomPreview(set: GroupSet) {
    try { const preview = await api<Preview>(`/classrooms/${classroomId}/group-sets/${set.id}/random-preview`, { method: "POST" }); setPreviews((current) => ({ ...current, [set.id]: preview })); }
    catch (reason) { onError(reason instanceof Error ? reason.message : "สร้างตัวอย่างสุ่มไม่สำเร็จ"); }
  }

  return <div className="classroom-groups">
    <section className="panel"><header className="panel-heading compact"><div><h2>สร้างชุดการจัดกลุ่ม</h2><p className="muted">สร้างหลายชุดแยกกันได้ เช่น งาน Blender หรือรอบใช้อุปกรณ์</p></div></header>
      <form className="group-set-create" onSubmit={createSet}>
        <label>ชื่อชุด<input maxLength={120} required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="เช่น กลุ่มทำงาน Blender" /></label>
        <label>นักเรียนสูงสุดต่อกลุ่ม<input type="number" min="1" max="400" value={studentLimit} onChange={(e) => setStudentLimit(e.target.value)} /></label>
        <label>จำนวนกลุ่มสูงสุด<input type="number" min="1" max="400" value={groupLimit} onChange={(e) => setGroupLimit(e.target.value)} /></label>
        <button className="button button-primary" disabled={busy || (!studentLimit && !groupLimit)}>สร้างฉบับร่าง</button>
        <small>หากกำหนดทั้งสองค่า จำนวนที่นั่งรวมจะเป็นผลคูณของจำนวนกลุ่มและขนาดกลุ่ม นักเรียนที่เกินจะยังไม่ถูกจัดกลุ่ม</small>
      </form>
    </section>
    {sets.map((set) => {
      const members = new Set(set.groups.flatMap((group) => group.members.map((member) => member.studentId)));
      const preview = previews[set.id];
      return <section className="panel group-set-card" key={set.id}>
        <header className="panel-heading compact"><div><p className="eyebrow">{stateLabel[set.status]}</p><h2>{set.title}</h2><p className="muted">{set.studentLimit ? `${set.studentLimit} คน/กลุ่ม` : "ไม่จำกัดคนต่อกลุ่ม"} · {set.groupLimit ? `ไม่เกิน ${set.groupLimit} กลุ่ม` : "ไม่จำกัดจำนวนกลุ่ม"} · จัดแล้ว {members.size}/{students.length} คน</p></div>
          {set.status !== "archived" && <div className="group-set-actions">
            {set.status === "draft" && <button className="button button-primary" disabled={busy} onClick={() => void act(() => api(`/classrooms/${classroomId}/group-sets/${set.id}/open`, { method: "POST" }))}>เปิดให้นักเรียน</button>}
            {set.status === "open" && <button className="button button-quiet" disabled={busy} onClick={() => void act(() => api(`/classrooms/${classroomId}/group-sets/${set.id}/lock`, { method: "POST" }))}>ล็อกการจัดกลุ่ม</button>}
            {set.status === "locked" && <button className="button button-quiet" disabled={busy} onClick={() => void act(() => api(`/classrooms/${classroomId}/group-sets/${set.id}/open`, { method: "POST" }))}>เปิดแก้ไขอีกครั้ง</button>}
            <button className="text-button" disabled={busy} onClick={() => { if (window.confirm(`เก็บ “${set.title}” หรือไม่? นักเรียนจะมองไม่เห็นชุดนี้`)) void act(() => api(`/classrooms/${classroomId}/group-sets/${set.id}/archive`, { method: "POST" })); }}>เก็บชุด</button>
          </div>}
        </header>
        {set.status !== "archived" && <>
          <form className="group-set-edit" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); void act(() => api(`/classrooms/${classroomId}/group-sets/${set.id}`, { method: "PATCH", body: JSON.stringify({ title: data.get("title"), studentLimit: data.get("studentLimit") ? Number(data.get("studentLimit")) : null, groupLimit: data.get("groupLimit") ? Number(data.get("groupLimit")) : null, revision: set.revision }) })); }}>
            <label>ชื่อ<input name="title" defaultValue={set.title} maxLength={120} required /></label><label>คน/กลุ่ม<input name="studentLimit" type="number" min="1" max="400" defaultValue={set.studentLimit ?? ""} /></label><label>จำนวนกลุ่ม<input name="groupLimit" type="number" min="1" max="400" defaultValue={set.groupLimit ?? ""} /></label><button className="button button-quiet" disabled={busy}>บันทึกข้อจำกัด</button>
          </form>
          <div className="group-set-toolbar"><form onSubmit={(event) => { event.preventDefault(); const name = groupNames[set.id]?.trim(); if (!name) return; void act(async () => { await api(`/classrooms/${classroomId}/group-sets/${set.id}/groups`, { method: "POST", body: JSON.stringify({ name }) }); setGroupNames((all) => ({ ...all, [set.id]: "" })); }); }}><input aria-label="ชื่อกลุ่มใหม่" maxLength={80} placeholder="ชื่อกลุ่มใหม่" value={groupNames[set.id] ?? ""} onChange={(e) => setGroupNames((all) => ({ ...all, [set.id]: e.target.value }))} /><button className="button button-quiet" disabled={busy || (set.groupLimit !== null && set.groups.length >= set.groupLimit)}>＋ เพิ่มกลุ่ม</button></form><button className="button button-quiet" disabled={busy} onClick={() => void randomPreview(set)}>สุ่มแบ่งกลุ่ม</button></div>
          {preview && <div className="group-random-preview"><strong>ตัวอย่างการสุ่ม</strong>{preview.groups.map((group, index) => <p key={index}><b>{group.name} ({group.studentIds.length})</b> · {group.studentIds.map((id) => students.find((s) => s.studentId === id)?.displayName ?? "นักเรียน").join(", ") || "ยังไม่มีสมาชิก"}</p>)}{preview.unassigned.length > 0 && <p>ยังไม่จัดกลุ่ม {preview.unassigned.length} คน เพราะที่นั่งไม่พอ</p>}<button className="button button-primary" disabled={busy} onClick={() => { if (window.confirm("ยืนยันสุ่มกลุ่มหรือไม่? กลุ่มและสมาชิกชุดปัจจุบันจะถูกแทนที่")) { setPreviews((all) => { const next = { ...all }; delete next[set.id]; return next; }); void act(() => api(`/classrooms/${classroomId}/group-sets/${set.id}/random-apply`, { method: "POST", body: JSON.stringify(preview) })); } }}>ยืนยันใช้ตัวอย่าง</button><button className="text-button" onClick={() => setPreviews((all) => { const next = { ...all }; delete next[set.id]; return next; })}>ยกเลิก</button></div>}
          <div className="group-columns">{set.groups.map((group) => <article className="group-box" key={group.id}><header><strong>{group.name}</strong><small>{group.members.length}{set.studentLimit ? `/${set.studentLimit}` : ""} คน</small><button className="text-button" disabled={busy || group.members.length > 0} onClick={() => void act(() => api(`/classrooms/${classroomId}/group-sets/${set.id}/groups/${group.id}`, { method: "DELETE" }))}>ลบกลุ่มว่าง</button></header><ul>{group.members.map((member) => <li key={member.studentId}><span>{member.studentNumber ?? "—"}. {member.displayName}</span><select aria-label={`จัดกลุ่ม ${member.displayName}`} value={group.id} disabled={busy} onChange={(e) => void act(() => api(`/classrooms/${classroomId}/group-sets/${set.id}/memberships/${member.studentId}`, { method: "PUT", body: JSON.stringify({ groupId: e.target.value || null }) }))}><option value={group.id}>คงกลุ่มเดิม</option>{set.groups.filter((option) => option.id !== group.id).map((option) => <option key={option.id} value={option.id} disabled={set.studentLimit !== null && option.members.length >= set.studentLimit}>ย้ายไป {option.name}{set.studentLimit !== null && option.members.length >= set.studentLimit ? " · เต็ม" : ""}</option>)}<option value="">นำออกจากกลุ่ม</option></select></li>)}</ul></article>)}</div>
          <section className="group-unassigned"><strong>ยังไม่อยู่ในกลุ่ม ({students.length - members.size})</strong>{students.filter((student) => !members.has(student.studentId)).map((student) => <div key={student.studentId}><span>{student.studentNumber ?? "—"}. {student.displayName}</span><select aria-label={`จัดกลุ่ม ${student.displayName}`} defaultValue="" disabled={busy} onChange={(e) => { if (e.target.value) void act(() => api(`/classrooms/${classroomId}/group-sets/${set.id}/memberships/${student.studentId}`, { method: "PUT", body: JSON.stringify({ groupId: e.target.value }) })); }}><option value="">เลือกกลุ่ม</option>{set.groups.map((group) => <option key={group.id} value={group.id} disabled={set.studentLimit !== null && group.members.length >= set.studentLimit}>{group.name}{set.studentLimit !== null && group.members.length >= set.studentLimit ? " · เต็ม" : ""}</option>)}</select></div>)}</section>
        </>}
      </section>;
    })}
    {!sets.length && <p className="muted">ยังไม่มีชุดการจัดกลุ่ม</p>}
  </div>;
}
