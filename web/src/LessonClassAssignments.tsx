import { useCallback, useEffect, useState } from "react";
import type { WioLabSettings } from "../../src/wio-labs";
import { api } from "./api";
import { defaultWioLabSettings, WioLabSettingsFields } from "./WioLabSettingsFields";

type LabChoice = { id: string; title: string };
type Classroom = { id: string; name: string; assigned: boolean; wioLab: (LabChoice & { active: boolean }) | null; wioChoices: LabChoice[] };
type ClassAssignments = { legacyPublic: boolean; publishedWioLab: WioLabSettings | null; classrooms: Classroom[] };

export function LessonClassAssignments({ id, published, publishedRevision, onError }: {
  id: string; published: boolean; publishedRevision: number | null; onError: (message: string) => void;
}) {
  const [data, setData] = useState<ClassAssignments | null>(null);
  const [busy, setBusy] = useState(false);
  const path = `/lesson-pages/${id}/classrooms`;
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await api<ClassAssignments>(path, { signal });
      if (!signal?.aborted) setData(result);
    } catch (error) { if (!signal?.aborted) onError((error as Error).message); }
  }, [path, onError]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, published, publishedRevision]);

  async function assign(room: Classroom, existingLabId?: string) {
    if (!room.assigned && data?.legacyPublic && !window.confirm("มอบหมายบทเรียนนี้ให้ห้องเรียน? ลิงก์เดิมจะเปิดได้เฉพาะนักเรียนที่อยู่ในห้องที่เลือกและเข้าสู่ระบบแล้ว")) return;
    if (room.assigned && !window.confirm(`นำบทเรียนออกจากห้อง ${room.name}? ใบงาน ห้องปฏิบัติการ และคะแนนจะยังอยู่ในห้องเรียน`)) return;
    await mutate(path + "/" + room.id, {
      method: room.assigned ? "DELETE" : "PUT",
      body: existingLabId ? JSON.stringify({ assignmentId: existingLabId }) : undefined,
    });
  }

  async function mutate(url: string, request: RequestInit) {
    setBusy(true);
    try { await api(url, request); await load(); return true; }
    catch (error) {
      onError((error as Error).message);
      await load();
      return false;
    } finally { setBusy(false); }
  }

  return <section className="panel learning-panel">
    <h2>ห้องเรียนที่ได้รับบทเรียน</h2>
    <p className="muted">{published ? "นักเรียนในห้องที่เลือกจะเห็นบทเรียนในหน้าห้องเรียนของตน" : "เผยแพร่บทเรียนก่อนเพิ่มห้องเรียน"}</p>
    {data?.legacyPublic && published && <p className="muted">ลิงก์นี้เปิดสาธารณะอยู่ การมอบหมายครั้งแรกจะจำกัดให้เฉพาะนักเรียนในห้องที่เลือก <a href={`/lessons/${id}`} target="_blank" rel="noreferrer">ดูหน้าสาธารณะ</a></p>}
    {data ? data.classrooms.length ? data.classrooms.map((room) =>
      <ClassroomLabRow key={room.id} lessonId={id} room={room} published={published} busy={busy} template={data.publishedWioLab}
        assign={(existingLabId) => assign(room, existingLabId)}
        saveLab={(changes) => mutate(`${path}/${room.id}/wio-lab`, {
          method: "PUT", body: JSON.stringify({ expectedAssignmentId: room.wioLab?.id ?? null, ...changes }),
        })} />
    ) : <p className="muted">ยังไม่มีห้องเรียนที่เปิดอยู่</p> : <button className="text-button" onClick={() => void load()}>โหลดห้องเรียนใหม่</button>}
  </section>;
}

function ClassroomLabRow({ lessonId, room, published, busy, template, assign, saveLab }: {
  lessonId: string; room: Classroom; published: boolean; busy: boolean; template: WioLabSettings | null;
  assign: (existingLabId?: string) => Promise<void>;
  saveLab: (changes: { assignmentId: string | null } | { create: WioLabSettings }) => Promise<boolean>;
}) {
  const [copy, setCopy] = useState<"copied" | "manual">();
  const [choice, setChoice] = useState("");
  const [creating, setCreating] = useState<WioLabSettings | null>(null);
  const selectedId = room.wioChoices.some((lab) => lab.id === choice) ? choice : "";
  const canChoose = room.assigned ? !room.wioLab : !!template;
  const selectLab = canChoose && room.wioChoices.length > 0 && <label>
    เลือกงาน Wio Terminal ที่มีอยู่
    <select value={selectedId} disabled={busy || !published} onChange={(event) => setChoice(event.target.value)}>
      <option value="">{room.assigned ? "เลือกงานในห้องนี้" : "สร้างงานจากแบบฝึกที่เผยแพร่"}</option>
      {room.wioChoices.map((lab) => <option value={lab.id} key={lab.id}>{lab.title}</option>)}
    </select>
  </label>;

  const studentUrl = published && room.assigned && room.wioLab?.active
    ? `${location.origin}/lessons/${lessonId}/classrooms/${room.id}` : null;
  const status = !published ? "เผยแพร่บทเรียนก่อน"
    : !room.assigned ? "ยังไม่ได้มอบหมายให้ห้องนี้"
    : !room.wioLab ? "แนบงาน Wio Terminal เพื่อให้นักเรียนเปิดตัวจำลอง"
    : !room.wioLab.active ? "เปิดใช้งานหรือเปลี่ยนงาน Wio Terminal ที่แนบ"
    : "นักเรียนในห้องนี้เปิดตัวจำลองได้";

  async function copyStudentLink() {
    if (!studentUrl) return;
    try { await navigator.clipboard.writeText(studentUrl); setCopy("copied"); }
    catch { setCopy("manual"); }
  }

  return <section className="lesson-class-room" aria-label={room.name}>
    <div className="lesson-actions">
      <strong>{room.name}</strong>
      {!room.assigned && selectLab}
      <button className="button button-quiet" disabled={busy || (!published && !room.assigned)}
        onClick={() => void assign(selectedId || undefined)}>
        {room.assigned ? "นำบทเรียนออกจากห้อง" : template && !selectedId ? "มอบหมายและสร้างงาน Wio" : "มอบหมายบทเรียน"}
      </button>
    </div>
    <p className="muted">{status}</p>
    {studentUrl && <div className="lesson-actions">
      <button className="button button-quiet" type="button" onClick={() => void copyStudentLink()}>คัดลอกลิงก์สำหรับนักเรียน</button>
      {copy === "copied" && <span role="status">คัดลอกลิงก์แล้ว</span>}
      {copy === "manual" && <label>ลิงก์สำหรับนักเรียน<input readOnly value={studentUrl} onFocus={(event) => event.currentTarget.select()} /></label>}
    </div>}
    {room.assigned && <div>
      <h3>ห้องปฏิบัติการ Wio Terminal</h3>
      {room.wioLab ? <div className="lesson-actions">
        <span>{room.wioLab.title}{!room.wioLab.active && " · นักเรียนยังเปิดไม่ได้"}</span>
        <button className="text-button danger" disabled={busy} onClick={() => {
          if (window.confirm("นำห้องปฏิบัติการออกจากบทเรียน? งาน ไฟล์ และคะแนนจะยังอยู่ในห้องเรียน")) void saveLab({ assignmentId: null });
        }}>นำห้องปฏิบัติการออก</button>
      </div> : published && (creating ? <form className="assignment-form" onSubmit={async (event) => {
        event.preventDefault();
        if (await saveLab({ create: creating })) setCreating(null);
      }}>
        <WioLabSettingsFields lab={creating} change={setCreating} />
        <div className="lesson-actions"><button className="button button-primary" disabled={busy || !creating.title.trim()}>สร้างและแนบงาน Wio</button>
          <button type="button" className="button button-quiet" disabled={busy} onClick={() => setCreating(null)}>ยกเลิก</button></div>
      </form> : <div className="lesson-actions">
        {selectLab}
        {room.wioChoices.length > 0 && <button className="button button-quiet" disabled={busy || !selectedId}
          onClick={async () => { if (await saveLab({ assignmentId: selectedId })) setChoice(""); }}>แนบงานที่เลือก</button>}
        <button className="button button-quiet" disabled={busy} onClick={() => setCreating(template ?? defaultWioLabSettings("blink"))}>สร้างงาน Wio ใหม่</button>
      </div>)}
    </div>}
  </section>;
}
