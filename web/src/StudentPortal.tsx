import { lazy, Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "./api";

const ModelPreview = lazy(() => import("./ModelPreview"));
export type StudentUser = { id: string; username: string; displayName: string; role: "student" };
type Assignment = { assignmentId: string; classroomId: string; classroomName: string; title: string; instructions: string; submissionCount: number };
type StudentFile = { id: string; kind: "worksheet" | "model" | "submission"; originalName: string; mediaType: string; sizeBytes: number | string; createdAt: string; studentSubmission: boolean };
const uploadTypes = ".pdf,.png,.jpg,.jpeg,.doc,.docx,.stl,.obj";

export function StudentPortal({ user, logout }: { user: StudentUser; logout: () => void }) {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [files, setFiles] = useState<StudentFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<StudentFile | null>(null);
  const selected = assignments.find((item) => item.assignmentId === selectedId) ?? null;

  const loadAssignments = useCallback(async () => {
    try {
      const next = await api<Assignment[]>("/student/assignments");
      setAssignments(next);
      if (!selectedId || !next.some((item) => item.assignmentId === selectedId)) setSelectedId(next[0]?.assignmentId ?? "");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "โหลดงานไม่สำเร็จ"); }
    finally { setLoading(false); }
  }, [selectedId]);
  useEffect(() => { void loadAssignments(); }, [loadAssignments]);

  const loadFiles = useCallback(async () => {
    if (!selected) { setFiles([]); return; }
    try {
      setFiles(await api<StudentFile[]>(`/student/classrooms/${selected.classroomId}/assignments/${selected.assignmentId}/files`));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "โหลดไฟล์ไม่สำเร็จ"); }
  }, [selected?.classroomId, selected?.assignmentId]);
  useEffect(() => { void loadFiles(); }, [loadFiles]);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    const input = form.elements.namedItem("studentFiles") as HTMLInputElement;
    const picked = Array.from(input.files ?? []);
    if (!picked.length) return;
    setBusy(true); setError("");
    let uploaded = 0;
    try {
      for (const file of picked) {
        const body = new FormData(); body.set("file", file);
        await api(`/student/classrooms/${selected.classroomId}/assignments/${selected.assignmentId}/files`, { method: "POST", body });
        uploaded++;
      }
      input.value = "";
    } catch (reason) {
      input.value = "";
      setError((reason instanceof Error ? reason.message : "ส่งงานไม่สำเร็จ") + (uploaded ? ` (ส่งแล้ว ${uploaded} จาก ${picked.length} ไฟล์)` : ""));
    } finally { setBusy(false); await loadFiles(); await loadAssignments(); }
  }

  return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark">ค</div><div><strong>ห้องเรียน</strong><span>พื้นที่นักเรียน</span></div></div><div className="sidebar-bottom"><div className="profile"><div className="avatar">{user.displayName.slice(0, 1)}</div><div className="profile-copy"><strong>{user.displayName}</strong><span>นักเรียน</span></div><button className="icon-button" onClick={logout} aria-label="ออกจากระบบ" title="ออกจากระบบ">↗</button></div></div></aside>
    <main className="main-area"><header className="topbar"><div className="breadcrumb">ห้องเรียน <span>/</span> งานของฉัน</div></header><div className="page-content">
      {error && <div className="notice" role="alert">{error}<button onClick={() => setError("")} aria-label="ปิด">×</button></div>}
      <div className="page-heading"><div><p className="eyebrow">พื้นที่นักเรียน</p><h1>งานของฉัน</h1><p className="muted page-description">ดูคำชี้แจงและไฟล์ใบงาน แล้วส่งงานของคุณ</p></div></div>
      <section className="panel"><header className="panel-heading compact"><div><h2>งานที่ได้รับ <small>{assignments.length} งาน</small></h2></div><button className="text-button" onClick={() => void loadAssignments()}>โหลดใหม่</button></header>
        {loading ? <p className="inline-loading"><i className="spinner"/>กำลังโหลดงาน…</p> : assignments.length ? <div className="assignment-list">{assignments.map((assignment) => <div className="assignment-row" key={assignment.assignmentId}><button className={"assignment-select " + (assignment.assignmentId === selectedId ? "selected" : "")} onClick={() => setSelectedId(assignment.assignmentId)}><strong>{assignment.title}</strong><small>{assignment.classroomName} · ส่งแล้ว {assignment.submissionCount} ไฟล์</small></button>{assignment.assignmentId === selectedId && <span className="assignment-marker">●</span>}</div>)}</div> : <p className="assignment-empty muted">ยังไม่มีงานที่เปิดอยู่</p>}
      </section>
      {selected && <section className="panel"><header className="panel-heading"><div><p className="eyebrow">{selected.classroomName}</p><h2>{selected.title}</h2>{selected.instructions && <p className="muted assignment-instructions">{selected.instructions}</p>}</div></header>
        <form className="work-upload" onSubmit={(event) => void upload(event)}><label className="work-file-input">เลือกไฟล์งาน<input name="studentFiles" type="file" accept={uploadTypes} multiple required/></label><button className="button button-primary" disabled={busy}>{busy ? "กำลังส่งงาน…" : "ส่งไฟล์"}</button><small>PDF, รูปภาพ, Word, STL หรือ OBJ · ไม่เกิน 50 MB ต่อไฟล์</small></form>
        <div className="student-submission-groups"><h3>ใบงานและคำชี้แจง</h3>{files.filter((file) => file.kind === "worksheet").length ? files.filter((file) => file.kind === "worksheet").map((file) => <FileRow key={file.id} file={file} onPreview={setPreview}/>) : <p className="muted">ครูยังไม่ได้แนบใบงาน</p>}<h3>งานที่ส่งแล้ว</h3>{files.filter((file) => file.kind !== "worksheet").length ? files.filter((file) => file.kind !== "worksheet").map((file) => <FileRow key={file.id} file={file} onPreview={setPreview}/>) : <p className="muted">ยังไม่ได้ส่งงานนี้</p>}</div>
      </section>}
    </div></main>
    {preview && <Suspense fallback={<div className="loading"><span className="spinner"/>กำลังเปิดตัวแสดงโมเดล…</div>}><ModelPreview file={preview} contentPath={"/api/student/files/" + preview.id + "/content"} close={() => setPreview(null)}/></Suspense>}
  </div>;
}

function FileRow({ file, onPreview }: { file: StudentFile; onPreview: (file: StudentFile) => void }) {
  const model = file.kind === "model";
  const icon = model ? "3D" : file.mediaType.startsWith("image/") ? "IMG" : file.mediaType.includes("word") ? "DOC" : "PDF";
  const content = "/api/student/files/" + file.id + "/content";
  return <article className="work-file"><span className={"file-kind " + (model ? "model" : "")}>{icon}</span><div className="work-file-copy"><strong>{file.originalName}</strong><small>{file.studentSubmission ? "ส่งโดยคุณ · " : file.kind === "worksheet" ? "ไฟล์จากครู · " : "ครูอัปโหลดให้คุณ · "}{formatDate(file.createdAt)} · {formatBytes(Number(file.sizeBytes))}</small></div><div className="work-file-actions">{model && <button className="text-button" onClick={() => onPreview(file)}>แสดงตัวอย่าง</button>}<a className="text-button" href={content} target={file.mediaType.startsWith("image/") || file.mediaType === "application/pdf" ? "_blank" : undefined} rel="noreferrer" download={file.mediaType.startsWith("image/") || file.mediaType === "application/pdf" ? undefined : true}>{model ? "ดาวน์โหลด" : "เปิดไฟล์"}</a></div></article>;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(value));
}

function formatBytes(bytes: number) {
  return bytes < 1024 * 1024 ? Math.max(1, Math.round(bytes / 1024)) + " KB" : (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
