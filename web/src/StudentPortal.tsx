import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import { StudentAttendance } from "./StudentAttendance";
import { FileThumbnail } from "./FileThumbnail";
import { generateThumbnail } from "./thumbnail-jobs";
import { StudentGroups } from "./StudentGroups";

const ModelPreview = lazy(() => import("./ModelPreview"));
export type StudentUser = { id: string; username: string; displayName: string; role: "student" };
type ClassroomMembership = { classroomId: string; classroomName: string };
type Assignment = { assignmentId: string; classroomId: string; classroomName: string; title: string; instructions: string; submissionCount: number; publishedScore: number | string | null; publishedMaxScore: number | string | null; publishedFeedback: string | null; publishedAt: string | null; newWork: boolean };
type StudentFile = { id: string; kind: "worksheet" | "model" | "submission" | "working"; originalName: string; mediaType: string; sizeBytes: number | string; createdAt: string; studentSubmission: boolean; thumbnailAvailable: boolean; materialAvailable: boolean };
type StudentQuiz = { quizId: string; title: string; classroomName: string; status: string; finishedAt: string | null; score: string | null };
type GalleryClass = { classroomId: string; classroomName: string; entryMode: "submission" | "approval"; requiredAssignmentId: string | null; requiredAssignmentTitle: string | null; hasSubmission: boolean; approved: boolean; entryAllowed: boolean };
const uploadTypes = ".pdf,.png,.jpg,.jpeg,.doc,.docx,.stl,.obj,.glb,.gltf";

export function StudentPortal({ user, logout, openWorld }: { user: StudentUser; logout: () => void; openWorld: (classroomId: string) => void }) {
  const [classrooms, setClassrooms] = useState<ClassroomMembership[]>([]);
  const [classroomFilter, setClassroomFilter] = useState("");
  const [refreshingClassrooms, setRefreshingClassrooms] = useState(true);
  const [classroomError, setClassroomError] = useState("");
  const [activityRevision, setActivityRevision] = useState(0);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [quizzes, setQuizzes] = useState<StudentQuiz[]>([]);
  const [worlds, setWorlds] = useState<GalleryClass[]>([]);
  const [worldsError, setWorldsError] = useState(false);
  const worldsRequest = useRef(0);
  const assignmentsRequest = useRef(0);
  const [selectedId, setSelectedId] = useState("");
  const [fileList, setFileList] = useState<{ assignmentId: string; files: StudentFile[] } | null>(null);
  const [fileRevision, setFileRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<StudentFile | null>(null);
  const visibleAssignments = classroomFilter ? assignments.filter((item) => item.classroomId === classroomFilter) : assignments;
  const selected = visibleAssignments.find((item) => item.assignmentId === selectedId) ?? visibleAssignments[0];
  const assignmentId = selected?.assignmentId;
  const classroomId = selected?.classroomId;
  const filesAreCurrent = !!fileList && fileList.assignmentId === assignmentId;
  const files = filesAreCurrent ? fileList.files : [];
  const workingFile = files.find((file) => file.kind === "working");
  const worksheets = files.filter((file): file is StudentFile & { kind: "worksheet" } => file.kind === "worksheet");
  const submissions = files.filter((file): file is StudentFile & { kind: "model" | "submission" } => file.kind === "model" || file.kind === "submission");

  useEffect(() => { if (assignmentId) setSelectedId(assignmentId); }, [assignmentId]);

  const refreshClassrooms = useCallback(async (signal?: AbortSignal) => {
    setRefreshingClassrooms(true);
    setClassroomError("");
    try {
      const next = await api<ClassroomMembership[]>("/student/classrooms/refresh", { method: "POST", signal });
      if (signal?.aborted) return;
      setClassrooms(next);
      setClassroomFilter((current) => next.some((room) => room.classroomId === current) ? current : "");
      setActivityRevision((current) => current + 1);
    } catch {
      if (signal?.aborted) return;
      setClassroomError("รีเฟรชห้องเรียนไม่สำเร็จ กรุณาลองใหม่");
      setActivityRevision((current) => current || 1);
    } finally {
      if (!signal?.aborted) setRefreshingClassrooms(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refreshClassrooms(controller.signal);
    return () => controller.abort();
  }, [refreshClassrooms]);

  const loadAssignments = useCallback(async () => {
    const request = ++assignmentsRequest.current;
    try {
      const next = await api<Assignment[]>("/student/assignments");
      if (request === assignmentsRequest.current) setAssignments(next);
    } catch (reason) {
      if (request === assignmentsRequest.current) setError(reason instanceof Error ? reason.message : "โหลดงานไม่สำเร็จ");
    } finally {
      if (request === assignmentsRequest.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (activityRevision) void loadAssignments();
    return () => { assignmentsRequest.current++; };
  }, [activityRevision, loadAssignments]);
  useEffect(() => {
    if (!activityRevision) return;
    const controller = new AbortController();
    void api<StudentQuiz[]>("/student/quizzes", { signal: controller.signal }).then((next) => {
      if (!controller.signal.aborted) setQuizzes(next);
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "โหลดแบบทดสอบไม่สำเร็จ");
    });
    return () => controller.abort();
  }, [activityRevision]);
  const loadWorlds = useCallback(async () => {
    const request = ++worldsRequest.current;
    try {
      const next = await api<GalleryClass[]>("/student/worlds");
      if (request !== worldsRequest.current) return;
      setWorlds(next);
      setWorldsError(false);
    } catch {
      if (request === worldsRequest.current) setWorldsError(true);
    }
  }, []);
  const activityReady = activityRevision > 0;
  useEffect(() => { if (activityRevision) void loadWorlds(); }, [activityRevision, loadWorlds]);
  useEffect(() => {
    if (!activityReady) return;
    const refresh = () => { if (document.visibilityState === "visible") void loadWorlds(); };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { worldsRequest.current++; window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [activityReady, loadWorlds]);

  useEffect(() => {
    if (!classroomId || !assignmentId) return;
    const controller = new AbortController();
    void api<StudentFile[]>(`/student/classrooms/${classroomId}/assignments/${assignmentId}/files`, { signal: controller.signal }).then((next) => {
      if (!controller.signal.aborted) setFileList({ assignmentId, files: next });
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "โหลดไฟล์ไม่สำเร็จ");
    });
    return () => controller.abort();
  }, [classroomId, assignmentId, fileRevision, activityRevision]);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    const input = form.elements.namedItem("studentFiles") as HTMLInputElement;
    const materialInput = form.elements.namedItem("materialFile") as HTMLInputElement;
    const picked = Array.from(input.files ?? []);
    const objFiles = picked.filter((file) => file.name.toLowerCase().endsWith(".obj"));
    const materialFile = materialInput.files?.[0];
    if (!picked.length) return;
    if (materialFile && objFiles.length !== 1) { setError("เลือกไฟล์ MTL ได้เมื่อส่ง OBJ เพียงไฟล์เดียว"); return; }
    setBusy(true); setError("");
    let uploaded = 0;
    try {
      for (const file of picked) {
        const body = new FormData(); body.set("file", file);
        if (materialFile && file === objFiles[0]) body.set("materialFile", materialFile);
        const uploadedFile = await api<{ id: string; mediaType: string; materialAvailable: boolean }>(`/student/classrooms/${selected.classroomId}/assignments/${selected.assignmentId}/files`, { method: "POST", body });
        void generateThumbnail({ id: uploadedFile.id, originalName: file.name, mediaType: uploadedFile.mediaType },
          "/api/student/files/" + uploadedFile.id + "/content", "/student/files/" + uploadedFile.id + "/thumbnail", new AbortController().signal, file,
          uploadedFile.materialAvailable ? "/api/student/files/" + uploadedFile.id + "/material" : undefined, materialFile).catch(() => {});
        uploaded++;
      }
      input.value = "";
      materialInput.value = "";
    } catch (reason) {
      input.value = "";
      materialInput.value = "";
      setError((reason instanceof Error ? reason.message : "ส่งงานไม่สำเร็จ") + (uploaded ? ` (ส่งแล้ว ${uploaded} จาก ${picked.length} ไฟล์)` : ""));
    } finally { setFileRevision((current) => current + 1); setBusy(false); await loadAssignments(); await loadWorlds(); }
  }

  async function saveWorkingFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !filesAreCurrent) return;
    const form = event.currentTarget;
    const input = form.elements.namedItem("workingFile") as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (workingFile && !window.confirm(`แทนที่ไฟล์ทำงาน “${workingFile.originalName}” หรือไม่? ไฟล์เดิมจะถูกลบถาวร`)) return;
    setBusy(true); setError("");
    try {
      const body = new FormData(); body.set("file", file);
      if (workingFile) body.set("replaceFileId", workingFile.id);
      const result = await api<{ cleanupPending: boolean }>(`/student/classrooms/${selected.classroomId}/assignments/${selected.assignmentId}/working-file`, { method: "PUT", body });
      input.value = "";
      if (result.cleanupPending) setError("บันทึกไฟล์ใหม่แล้ว แต่ยังลบไฟล์เดิมจากพื้นที่จัดเก็บไม่สำเร็จ");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "บันทึกไฟล์ทำงานไม่สำเร็จ"); }
    finally { setFileRevision((current) => current + 1); setBusy(false); }
  }

  async function removeWorkingFile() {
    if (!workingFile || !window.confirm(`ลบไฟล์ทำงาน “${workingFile.originalName}” ถาวรหรือไม่? ไฟล์นี้จะไม่สามารถกู้คืนได้`)) return;
    setBusy(true); setError("");
    try {
      const result = await api<{ cleanupPending: boolean }>(`/student/files/${workingFile.id}`, { method: "DELETE" });
      if (result.cleanupPending) setError("ลบข้อมูลไฟล์แล้ว แต่ยังลบไฟล์ออกจากพื้นที่จัดเก็บไม่สำเร็จ");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "ลบไฟล์ทำงานไม่สำเร็จ"); }
    finally { setFileRevision((current) => current + 1); setBusy(false); }
  }

  return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark">ค</div><div><strong>ห้องเรียน</strong><span>พื้นที่นักเรียน</span></div></div><div className="sidebar-bottom"><div className="profile"><div className="avatar">{user.displayName.slice(0, 1)}</div><div className="profile-copy"><strong>{user.displayName}</strong><span>นักเรียน</span></div><button className="icon-button" onClick={logout} aria-label="ออกจากระบบ" title="ออกจากระบบ">↗</button></div></div></aside>
    <main className="main-area"><header className="topbar"><div className="breadcrumb">ห้องเรียน <span>/</span> งานของฉัน</div></header><div className="page-content">
      {error && <div className="notice" role="alert">{error}<button onClick={() => setError("")} aria-label="ปิด">×</button></div>}
      <div className="page-heading"><div><p className="eyebrow">พื้นที่นักเรียน</p><h1>งานของฉัน</h1><p className="muted page-description">ดูคำชี้แจงและไฟล์ใบงาน แล้วส่งงานของคุณ</p></div></div>
      <section className="panel">
        <header className="panel-heading compact">
          <div><h2>ห้องเรียนของฉัน</h2><p className="muted">เลือกห้องเรียนเพื่อกรองงานที่ได้รับ</p></div>
          <button className="text-button" disabled={refreshingClassrooms || busy} onClick={() => void refreshClassrooms()}>
            {refreshingClassrooms ? "กำลังรีเฟรช…" : "รีเฟรชห้องเรียน"}
          </button>
        </header>
        {classroomError && <p className="assignment-empty form-error" role="alert">{classroomError}</p>}
        {classrooms.length > 0 && <div className="student-classroom-filters" role="group" aria-label="กรองงานตามห้องเรียน">
          {[{ classroomId: "", classroomName: "ทุกห้องเรียน" }, ...classrooms].map((room) => {
            const active = room.classroomId === classroomFilter;
            return <button key={room.classroomId} className={`button ${active ? "button-primary" : "button-quiet"}`} aria-pressed={active} disabled={busy}
              onClick={() => { setPreview(null); setClassroomFilter(room.classroomId); }}>{room.classroomName}</button>;
          })}
        </div>}
        {!refreshingClassrooms && !classroomError && classrooms.length === 0 && <p className="assignment-empty muted">ยังไม่มีห้องเรียนที่เชื่อมกับบัญชีของคุณ</p>}
      </section>
      <StudentAttendance refreshVersion={activityRevision}/>
      <StudentGroups refreshVersion={activityRevision} onError={setError}/>
      {(worlds.length > 0 || worldsError) && <section className="panel">
        <header className="panel-heading compact">
          <h2>โลกเสมือน</h2>
          <button className="text-button" onClick={() => void loadWorlds()}>{worldsError ? "ลองใหม่" : "ตรวจสอบสิทธิ์"}</button>
        </header>
        {worldsError ? <p className="assignment-empty muted" role="alert">ตรวจสอบสิทธิ์เข้าโลกเสมือนไม่สำเร็จ</p> : <div className="gallery-world-links">{worlds.map((world) => <article className="gallery-entry-card" key={world.classroomId}><div><strong>{world.classroomName}</strong>{world.entryAllowed ? <p className="muted">คุณมีสิทธิ์เข้าโลกเสมือน</p> : <p className="muted">{!world.requiredAssignmentTitle ? "ยังไม่มีงานที่เปิดอยู่ จึงยังเข้าโลกไม่ได้" : !world.hasSubmission ? `ส่งงานล่าสุดก่อนเข้าโลก: ${world.requiredAssignmentTitle}` : world.entryMode === "approval" && !world.approved ? `ส่งแล้ว · รอครูอนุมัติสำหรับงาน ${world.requiredAssignmentTitle}` : "สถานะสิทธิ์เข้าโลกกำลังปรับปรุง"}</p>}</div><div className="gallery-world-links">{world.entryAllowed ? <button className="button button-primary" onClick={() => openWorld(world.classroomId)}>เข้าโลก ↗</button> : world.requiredAssignmentId && <button className="button button-quiet" disabled={busy} onClick={() => { setPreview(null); setClassroomFilter((current) => current ? world.classroomId : ""); setSelectedId(world.requiredAssignmentId!); document.getElementById("student-assignments")?.scrollIntoView({ behavior: "smooth" }); }}>ไปยังงานล่าสุด</button>}</div></article>)}</div>}
      </section>}
      {quizzes.length > 0 && <section className="panel student-quiz-list"><header className="panel-heading compact"><div><h2>แบบทดสอบ</h2><p className="muted">แบบทดสอบที่ครูเปิดหรือรอบที่คุณเริ่มแล้ว</p></div></header><div className="assignment-list">{[...new Map(quizzes.map((item) => [item.quizId, item])).values()].map((quiz) => { const related = quizzes.filter((item) => item.quizId === quiz.quizId); return <a className="assignment-select student-quiz-link" href={`/quizzes/${quiz.quizId}?role=student`} key={quiz.quizId}><strong>{quiz.title}</strong><small>{related.map((item) => item.classroomName).join(" · ")} · {related.some((item) => item.finishedAt) ? "มีผลคะแนน" : "มีรอบแบบทดสอบ"}</small></a>; })}</div></section>}
      <section id="student-assignments" className="panel"><header className="panel-heading compact"><div><h2>งานที่ได้รับ <small>{visibleAssignments.length} งาน</small></h2>{classroomFilter && <p className="muted">{classrooms.find((room) => room.classroomId === classroomFilter)?.classroomName}</p>}</div><button className="text-button" disabled={loading || refreshingClassrooms} onClick={() => void loadAssignments()}>โหลดใหม่</button></header>
        {loading ? <p className="inline-loading"><i className="spinner"/>กำลังโหลดงาน…</p> : visibleAssignments.length ? <div className="assignment-list">{visibleAssignments.map((assignment) => {
          const active = assignment.assignmentId === assignmentId;
          return <div className="assignment-row" key={assignment.assignmentId}><button className={"assignment-select " + (active ? "selected" : "")} aria-pressed={active} disabled={busy} onClick={() => { setPreview(null); setSelectedId(assignment.assignmentId); }}><strong>{assignment.title}</strong><small>{assignment.classroomName} · ส่งแล้ว {assignment.submissionCount} ไฟล์</small></button>{active && <span className="assignment-marker">●</span>}</div>;
        })}</div> : <p className="assignment-empty muted">{classroomFilter ? "ยังไม่มีงานในห้องเรียนนี้" : "ยังไม่มีงานที่เปิดอยู่"}</p>}
      </section>
      {selected && <section className="panel" key={assignmentId}><header className="panel-heading"><div><p className="eyebrow">{selected.classroomName}</p><h2>{selected.title}</h2>{selected.instructions && <p className="muted assignment-instructions">{selected.instructions}</p>}</div></header>
        {selected.publishedScore !== null && selected.publishedScore !== undefined && <div className="student-assessment"><strong>คะแนน: {Number(selected.publishedScore)} / {Number(selected.publishedMaxScore)}</strong>{selected.publishedFeedback && <p>{selected.publishedFeedback}</p>}{selected.newWork && <small>มีไฟล์งานใหม่รอครูตรวจ</small>}</div>}
        <form className="work-upload" onSubmit={(event) => void upload(event)}><label className="work-file-input">เลือกไฟล์งาน<input name="studentFiles" type="file" accept={uploadTypes} multiple required/></label><label className="work-file-input">ไฟล์สี MTL (ไม่บังคับ)<input name="materialFile" type="file" accept=".mtl"/><small>เลือกคู่กับ OBJ ไฟล์เดียว · สีพื้นผิวเท่านั้น ไม่รองรับรูป texture</small></label><button className="button button-primary" disabled={busy}>{busy ? "กำลังส่งงาน…" : "ส่งไฟล์"}</button><small>PDF, รูปภาพ, Word, STL, OBJ, GLB หรือ glTF · ไม่เกิน 50 MB รวม OBJ และ MTL · รองรับ GLB/glTF แบบฝังข้อมูล แนะนำ Blender → glTF Binary (.glb)</small></form>
        <section className="student-submission-groups"><h3>ไฟล์ทำงาน Blender — ยังไม่ใช่การส่งงาน</h3><p className="muted">ดาวน์โหลดมาแก้ไขใน Blender แล้วอัปโหลดไฟล์ใหม่เพื่อแทนที่ไฟล์เดิม · ก่อนย้ายไปใช้คอมพิวเตอร์เครื่องอื่น ให้เลือก File → External Data → Pack Resources เพื่อรวม texture ไว้ในไฟล์</p>{workingFile ? <article className="work-file"><span className="file-kind">BLEND</span><div className="work-file-copy"><strong>{workingFile.originalName}</strong><small>บันทึก {formatDate(workingFile.createdAt)} · {formatBytes(Number(workingFile.sizeBytes))}</small></div><div className="work-file-actions"><a className="text-button" href={`/api/student/files/${workingFile.id}/content`} download>ดาวน์โหลด</a><button className="text-button subdued" type="button" disabled={busy} onClick={() => void removeWorkingFile()}>ลบ</button></div></article> : <p className="muted">ยังไม่มีไฟล์ทำงานที่บันทึกไว้</p>}<form className="work-upload" onSubmit={(event) => void saveWorkingFile(event)}><label className="work-file-input">{workingFile ? "เลือกไฟล์ Blender ใหม่เพื่อแทนที่" : "เลือกไฟล์ Blender"}<input name="workingFile" type="file" accept=".blend" required/></label><button className="button button-quiet" disabled={busy || !filesAreCurrent}>{workingFile ? "แทนที่ไฟล์ทำงาน" : "บันทึกไฟล์ทำงาน"}</button><small>ไฟล์ .blend · ไม่เกิน 50 MB · ไม่รวมในจำนวนงานที่ส่ง</small></form></section>
        <div className="student-submission-groups"><h3>ใบงานและคำชี้แจง</h3>{worksheets.length ? worksheets.map((file) => <FileRow key={file.id} file={file} onPreview={setPreview}/>) : <p className="muted">ครูยังไม่ได้แนบใบงาน</p>}<h3>งานที่ส่งแล้ว</h3>{submissions.length ? submissions.map((file) => <FileRow key={file.id} file={file} onPreview={setPreview}/>) : <p className="muted">ยังไม่ได้ส่งงานนี้</p>}</div>
      </section>}
    </div></main>
    {preview && files.some((file) => file.id === preview.id) && <Suspense fallback={<div className="loading"><span className="spinner"/>กำลังเปิดตัวแสดงโมเดล…</div>}><ModelPreview file={preview} contentPath={"/api/student/files/" + preview.id + "/content"} materialPath={preview.materialAvailable ? "/api/student/files/" + preview.id + "/material" : undefined} close={() => setPreview(null)}/></Suspense>}
  </div>;
}

function FileRow({ file, onPreview }: { file: StudentFile & { kind: "worksheet" | "model" | "submission" }; onPreview: (file: StudentFile) => void }) {
  const model = file.mediaType.startsWith("model/");
  const icon = model ? "3D" : file.mediaType.startsWith("image/") ? "IMG" : file.mediaType.includes("word") ? "DOC" : "PDF";
  const content = "/api/student/files/" + file.id + "/content";
  return <article className="work-file"><FileThumbnail file={file} student onPreview={() => onPreview(file)}/><div className="work-file-copy"><strong>{file.originalName}</strong><small>{file.studentSubmission ? "ส่งโดยคุณ · " : file.kind === "worksheet" ? "ไฟล์จากครู · " : "ครูอัปโหลดให้คุณ · "}{formatDate(file.createdAt)} · {formatBytes(Number(file.sizeBytes))}</small></div><div className="work-file-actions">{model && <button className="text-button" onClick={() => onPreview(file)}>แสดงตัวอย่าง</button>}<a className="text-button" href={content} target={file.mediaType.startsWith("image/") || file.mediaType === "application/pdf" ? "_blank" : undefined} rel="noreferrer" download={file.mediaType.startsWith("image/") || file.mediaType === "application/pdf" ? undefined : true}>{model ? "ดาวน์โหลด" : "เปิดไฟล์"}</a></div></article>;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(value));
}

function formatBytes(bytes: number) {
  return bytes < 1024 * 1024 ? Math.max(1, Math.round(bytes / 1024)) + " KB" : (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
