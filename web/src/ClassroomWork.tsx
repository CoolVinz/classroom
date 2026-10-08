import { lazy, Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "./api";

const ModelPreview = lazy(() => import("./ModelPreview"));
type Classroom = { id: string };
type Student = { id: string; displayName: string; studentCode: string | null; archived: boolean };
type Assignment = { id: string; title: string; instructions: string; archived: boolean; fileCount: number };
type ClassFile = { id: string; studentId: string | null; studentName: string | null; kind: "worksheet" | "model" | "submission"; originalName: string; mediaType: string; sizeBytes: number | string; createdAt: string; studentSubmission: boolean };

export function ClassroomWork({ room, onError }: { room: Classroom; onError: (message: string) => void }) {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [files, setFiles] = useState<ClassFile[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [kind, setKind] = useState<"worksheet" | "model">("worksheet");
  const [studentId, setStudentId] = useState("");
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<ClassFile | null>(null);
  const selected = assignments.find((assignment) => assignment.id === selectedId) ?? null;
  const activeStudents = students.filter((student) => !student.archived);
  const submittedStudentIds = new Set(files.filter((file) => file.studentSubmission && file.studentId).map((file) => file.studentId!));

  const loadAssignments = useCallback(async () => {
    try {
      const next = await api<Assignment[]>("/classrooms/" + room.id + "/assignments");
      setAssignments(next);
      if (!selectedId || !next.some((assignment) => assignment.id === selectedId)) {
        setSelectedId(next.find((assignment) => !assignment.archived)?.id ?? next[0]?.id ?? "");
      }
    } catch (reason) { onError(reason instanceof Error ? reason.message : "โหลดงานไม่สำเร็จ"); }
  }, [room.id, selectedId, onError]);

  useEffect(() => { void loadAssignments(); }, [loadAssignments]);
  useEffect(() => {
    api<Student[]>("/classrooms/" + room.id + "/students").then(setStudents)
      .catch((reason) => onError(reason instanceof Error ? reason.message : "โหลดรายชื่อไม่สำเร็จ"));
  }, [room.id, onError]);
  const loadFiles = useCallback(async () => {
    if (!selectedId) { setFiles([]); return; }
    try { setFiles(await api<ClassFile[]>("/classrooms/" + room.id + "/assignments/" + selectedId + "/files")); }
    catch (reason) { onError(reason instanceof Error ? reason.message : "โหลดไฟล์ไม่สำเร็จ"); }
  }, [room.id, selectedId, onError]);
  useEffect(() => { void loadFiles(); }, [loadFiles]);

  async function saveAssignment(event: FormEvent) {
    event.preventDefault();
    try {
      if (creating) {
        const next = await api<Assignment>("/classrooms/" + room.id + "/assignments", { method: "POST", body: JSON.stringify({ title, instructions }) });
        await loadAssignments(); setSelectedId(next.id); setCreating(false);
      } else if (selected) {
        await api("/classrooms/" + room.id + "/assignments/" + selected.id, { method: "PATCH", body: JSON.stringify({ title, instructions }) });
        await loadAssignments(); setEditing(false);
      }
    } catch (reason) { onError(reason instanceof Error ? reason.message : "บันทึกงานไม่สำเร็จ"); }
  }

  async function archiveAssignment(archived: boolean) {
    if (!selected) return;
    if (archived && !window.confirm("เก็บงานนี้เข้าคลังหรือไม่? ไฟล์และประวัติจะยังอยู่")) return;
    try {
      await api("/classrooms/" + room.id + "/assignments/" + selected.id, { method: "PATCH", body: JSON.stringify({ archived }) });
      await loadAssignments(); setEditing(false);
    } catch (reason) { onError(reason instanceof Error ? reason.message : "เปลี่ยนสถานะงานไม่สำเร็จ"); }
  }

  async function uploadFiles(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || (kind === "model" && !studentId)) return;
    const form = event.currentTarget;
    const input = form.elements.namedItem("uploadFiles") as HTMLInputElement;
    const selectedFiles = Array.from(input.files ?? []);
    if (!selectedFiles.length) return;
    setUploading(true);
    let uploaded = 0;
    try {
      for (const file of selectedFiles) {
        const body = new FormData(); body.set("file", file); body.set("assignmentId", selected.id); body.set("kind", kind);
        if (kind === "model") body.set("studentId", studentId);
        await api("/classrooms/" + room.id + "/files", { method: "POST", body });
        uploaded++;
      }
      input.value = "";
    } catch (reason) {
      onError((reason instanceof Error ? reason.message : "อัปโหลดไม่สำเร็จ") + (uploaded ? ` (อัปโหลดแล้ว ${uploaded} จาก ${selectedFiles.length} ไฟล์)` : ""));
    } finally { setUploading(false); await loadFiles(); await loadAssignments(); }
  }

  async function removeFile(file: ClassFile) {
    if (!window.confirm("ลบไฟล์ “" + file.originalName + "” หรือไม่?")) return;
    try { await api("/files/" + file.id, { method: "DELETE" }); await loadFiles(); await loadAssignments(); }
    catch (reason) { onError(reason instanceof Error ? reason.message : "ลบไฟล์ไม่สำเร็จ"); }
  }

  const visibleAssignments = assignments.filter((assignment) => showArchived || !assignment.archived);
  const accept = kind === "model" ? ".stl,.obj" : ".pdf,.png,.jpg,.jpeg,.doc,.docx";

  return <>
    <section className="panel"><header className="panel-heading"><div><p className="eyebrow">งานประจำห้องเรียน</p><h2>งานและไฟล์</h2><p className="muted">เพิ่มใบงาน แล้วแนบโมเดลของนักเรียนแต่ละคน</p></div><Button onClick={() => { setCreating(true); setEditing(false); setTitle(""); setInstructions(""); }}>＋ สร้างงาน</Button></header>
      <div className="assignment-list">{visibleAssignments.map((assignment) => <div className="assignment-row" key={assignment.id}><button className={"assignment-select " + (assignment.id === selectedId ? "selected" : "")} onClick={() => { setSelectedId(assignment.id); setCreating(false); setEditing(false); }}><strong>{assignment.title}</strong><small>{assignment.fileCount} ไฟล์{assignment.archived ? " · เก็บแล้ว" : ""}</small></button>{assignment.id === selectedId && <span className="assignment-marker">●</span>}</div>)}{!visibleAssignments.length && <p className="muted assignment-empty">ยังไม่มีงานในห้องเรียนนี้</p>}</div>
      <label className="archive-filter"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)}/> แสดงงานที่เก็บแล้ว</label>
    </section>

    {creating && <section className="panel"><header className="panel-heading compact"><div><h2>สร้างงาน</h2></div><button className="text-button" onClick={() => setCreating(false)}>ยกเลิก</button></header><form className="assignment-form" onSubmit={(event) => void saveAssignment(event)}><label>ชื่องาน<input maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} required/></label><label>คำชี้แจง <small>(ไม่บังคับ)</small><textarea maxLength={5000} rows={3} value={instructions} onChange={(event) => setInstructions(event.target.value)}/></label><Button disabled={!title.trim()}>บันทึกงาน</Button></form></section>}

    {selected && <section className="panel"><header className="panel-heading"><div><p className="eyebrow">{room.id && "งานในห้องเรียน"}{selected.archived ? " · เก็บแล้ว" : ""}</p>{editing ? <form className="assignment-form" onSubmit={(event) => void saveAssignment(event)}><label>ชื่องาน<input maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} required/></label><label>คำชี้แจง<textarea maxLength={5000} rows={3} value={instructions} onChange={(event) => setInstructions(event.target.value)}/></label><div className="assignment-actions"><Button disabled={!title.trim()}>บันทึก</Button><Button type="button" tone="quiet" onClick={() => setEditing(false)}>ยกเลิก</Button></div></form> : <><h2>{selected.title}</h2>{selected.instructions && <p className="muted assignment-instructions">{selected.instructions}</p>}</>}</div><div className="assignment-actions">{!editing && !selected.archived && <button className="text-button" onClick={() => { setTitle(selected.title); setInstructions(selected.instructions); setEditing(true); }}>แก้ไข</button>}{!editing && <Button tone="quiet" onClick={() => void archiveAssignment(!selected.archived)}>{selected.archived ? "นำกลับมา" : "เก็บงาน"}</Button>}</div></header>
      {!selected.archived && !editing && <form className="work-upload" onSubmit={(event) => void uploadFiles(event)}><label>ประเภทไฟล์<select value={kind} onChange={(event) => setKind(event.target.value as "worksheet" | "model")}><option value="worksheet">ใบงาน / เอกสาร</option><option value="model">โมเดลของนักเรียน</option></select></label>{kind === "model" && <label>นักเรียน<select value={studentId} onChange={(event) => setStudentId(event.target.value)} required><option value="">เลือกนักเรียน</option>{students.filter((student) => !student.archived).map((student) => <option value={student.id} key={student.id}>{student.displayName}{student.studentCode ? " · " + student.studentCode : ""}</option>)}</select></label>}<label className="work-file-input">เลือกไฟล์<input name="uploadFiles" type="file" accept={accept} multiple required/></label><Button disabled={uploading || (kind === "model" && !studentId)}>{uploading ? "กำลังอัปโหลด…" : "อัปโหลดไฟล์"}</Button><small>ไม่เกิน 50 MB ต่อไฟล์</small></form>}
      {selected && !selected.archived && activeStudents.length > 0 && <div className="submission-roster"><h3>สถานะการส่งงาน</h3><p className="muted">ส่งแล้ว {activeStudents.filter((student) => submittedStudentIds.has(student.id)).length} จาก {activeStudents.length} คน</p><div>{activeStudents.map((student) => <span key={student.id} className={submittedStudentIds.has(student.id) ? "submitted" : "not-submitted"}>{student.displayName}: {submittedStudentIds.has(student.id) ? "ส่งแล้ว" : "ยังไม่ส่ง"}</span>)}</div></div>}
      {files.length ? <div className="work-file-list">{files.map((file) => <article className="work-file" key={file.id}><span className={"file-kind " + (file.kind === "model" ? "model" : "")}>{file.kind === "model" ? "3D" : file.kind === "worksheet" ? "PDF" : file.mediaType.includes("word") ? "DOC" : file.mediaType.startsWith("image/") ? "IMG" : "PDF"}</span><div className="work-file-copy"><strong>{file.originalName}</strong><small>{file.kind === "worksheet" ? "ใบงาน" : file.studentName ?? "ไม่พบชื่อนักเรียน"}{file.studentSubmission ? " · ส่งโดยนักเรียน" : ""} · {formatDate(file.createdAt)} · {formatBytes(Number(file.sizeBytes))}</small></div><div className="work-file-actions">{file.kind === "model" && <button className="text-button" onClick={() => setPreview(file)}>แสดงตัวอย่าง</button>}<a className="text-button" href={"/api/files/" + file.id + "/content"} target={file.kind !== "model" && (file.mediaType === "application/pdf" || file.mediaType.startsWith("image/")) ? "_blank" : undefined} rel="noreferrer" download={file.kind === "model" || (file.kind !== "worksheet" && !file.mediaType.startsWith("image/") && file.mediaType !== "application/pdf") ? true : undefined}>{file.kind === "model" ? "ดาวน์โหลด" : "เปิดไฟล์"}</a><button className="text-button subdued" onClick={() => void removeFile(file)}>ลบ</button></div></article>)}</div> : <p className="muted assignment-empty">ยังไม่มีไฟล์แนบในงานนี้</p>}
    </section>}
    {preview && <Suspense fallback={<div className="loading"><span className="spinner"/>กำลังเปิดตัวแสดงโมเดล…</div>}><ModelPreview file={preview} close={() => setPreview(null)}/></Suspense>}
  </>;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(value));
}

function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "quiet" }) {
  const { tone = "primary", className = "", ...rest } = props;
  return <button className={"button button-" + tone + " " + className} {...rest} />;
}
