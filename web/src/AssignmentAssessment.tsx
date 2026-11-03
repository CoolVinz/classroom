import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";
import { FileThumbnail } from "./FileThumbnail";

type WorkFile = {
  id: string; studentId: string; studentName: string; kind: "model" | "submission";
  originalName: string; mediaType: string; sizeBytes: number | string; createdAt: string;
  studentSubmission: boolean; thumbnailAvailable: boolean;
};
type AssessmentStudent = {
  studentId: string; studentName: string; studentCode: string | null; studentNumber: number | null; archived: boolean;
  submissionCount: number; latestFile: WorkFile | null;
  draftScore: number | string | null; draftFeedback: string; draftRevision: number; draftUpdatedAt: string | null;
  draftHasNewWork: boolean; publishedScore: number | string | null; publishedMaxScore: number | string | null;
  publishedFeedback: string | null; publishedRevision: number | null; publishedAt: string | null; publishedHasNewWork: boolean;
};
type Props = {
  classroomId: string; assignmentId: string; maxScore: number | string;
  onPreview: (file: WorkFile) => void; onFilesChanged: () => void; refresh: number;
};

export function AssignmentAssessment({ classroomId, assignmentId, maxScore, onPreview, onFilesChanged, refresh }: Props) {
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<AssessmentStudent[]>([]);
  const [total, setTotal] = useState(0);
  const [reload, setReload] = useState(0);
  const [expanded, setExpanded] = useState("");
  const [files, setFiles] = useState<WorkFile[]>([]);
  const [filesRefresh, setFilesRefresh] = useState(0);
  const [filesLoading, setFilesLoading] = useState(false);
  const [score, setScore] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = items.find((item) => item.studentId === expanded);
  const pageCount = Math.ceil(total / 20);

  useEffect(() => {
    const controller = new AbortController();
    setItems([]); setError("");
    void api<{ students: AssessmentStudent[]; total: number }>(`/classrooms/${classroomId}/assignments/${assignmentId}/assessments?page=${page}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) { setItems(result.students); setTotal(result.total); } })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "โหลดรายการตรวจงานไม่สำเร็จ"); });
    return () => controller.abort();
  }, [classroomId, assignmentId, page, reload, refresh]);

  useEffect(() => {
    if (!expanded) { setFiles([]); return; }
    const controller = new AbortController();
    setFiles([]); setFilesLoading(true); setError("");
    void api<WorkFile[]>(`/classrooms/${classroomId}/assignments/${assignmentId}/files?studentId=${expanded}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setFiles(result); })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "โหลดไฟล์นักเรียนไม่สำเร็จ"); })
      .finally(() => { if (!controller.signal.aborted) setFilesLoading(false); });
    return () => controller.abort();
  }, [classroomId, assignmentId, expanded, filesRefresh]);

  useEffect(() => {
    if (!selected) return;
    setScore(selected.draftScore === null ? (selected.publishedScore === null ? "" : String(selected.publishedScore)) : String(selected.draftScore));
    setFeedback(selected.draftUpdatedAt ? selected.draftFeedback : selected.publishedFeedback ?? "");
  }, [selected?.studentId, selected?.draftRevision, selected?.publishedAt, reload]);

  async function saveDraft(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true); setError("");
    try {
      await api(`/classrooms/${classroomId}/assignments/${assignmentId}/students/${selected.studentId}/assessment`, {
        method: "PUT", body: JSON.stringify({ score: Number(score), feedback, revision: selected.draftRevision, reviewedFileIds: files.map((file) => file.id) }),
      });
      setReload((value) => value + 1); onFilesChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "บันทึกคะแนนไม่สำเร็จ"); }
    finally { setBusy(false); }
  }

  async function publish(student: AssessmentStudent) {
    setBusy(true); setError("");
    try {
      await api(`/classrooms/${classroomId}/assignments/${assignmentId}/students/${student.studentId}/assessment/publish`, {
        method: "POST", body: JSON.stringify({ revision: student.draftRevision }),
      });
      setReload((value) => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "เผยแพร่คะแนนไม่สำเร็จ"); }
    finally { setBusy(false); }
  }

  async function unpublish(student: AssessmentStudent) {
    if (student.publishedRevision === null || !window.confirm("ซ่อนคะแนนและความคิดเห็นนี้จากนักเรียนหรือไม่?")) return;
    setBusy(true); setError("");
    try {
      await api(`/classrooms/${classroomId}/assignments/${assignmentId}/students/${student.studentId}/assessment/unpublish`, {
        method: "POST", body: JSON.stringify({ revision: student.publishedRevision }),
      });
      setReload((value) => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "ซ่อนคะแนนไม่สำเร็จ"); }
    finally { setBusy(false); }
  }

  async function remove(file: WorkFile) {
    if (!window.confirm("ลบไฟล์ “" + file.originalName + "” หรือไม่?")) return;
    try {
      await api("/files/" + file.id, { method: "DELETE" });
      setFilesRefresh((value) => value + 1); setReload((value) => value + 1); onFilesChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "ลบไฟล์ไม่สำเร็จ"); }
  }

  const max = Number(maxScore);
  const validScore = score !== "" && Number.isFinite(Number(score)) && Number(score) >= 0 && Number(score) <= max && Math.round(Number(score) * 100) === Number(score) * 100;
  return <section className="submission-review"><header><div><h3>ตรวจงานและให้คะแนน</h3><p className="muted">คะแนนเต็ม {max} · เผยแพร่ให้นักเรียนแยกคน</p></div></header>
    {error && <p className="form-error" role="alert">{error} <button className="text-button" onClick={() => setReload((value) => value + 1)}>โหลดใหม่</button></p>}
    {items.length ? <div className="assessment-list">{items.map((student) => {
      const status = student.draftHasNewWork || student.publishedHasNewWork ? "มีงานใหม่รอตรวจ" : student.draftUpdatedAt ? "ฉบับร่าง" : student.publishedAt ? "เผยแพร่แล้ว" : student.submissionCount ? "รอตรวจ" : "ยังไม่ส่ง";
      const isExpanded = expanded === student.studentId;
      return <article className="assessment-student" key={student.studentId}>
        <div className="assessment-summary">
          <button className="assessment-toggle" type="button" aria-expanded={isExpanded} onClick={() => {
            setExpanded(isExpanded ? "" : student.studentId); setFiles([]); setError("");
          }}><span className="assessment-number">{student.studentNumber ?? "—"}</span><span className="assessment-name"><strong>{student.studentName}</strong><small>{student.studentCode ?? ""}{student.archived ? " · เก็บรายชื่อแล้ว" : ""}</small></span><span aria-hidden="true">{isExpanded ? "⌃" : "⌄"}</span></button>
          {student.latestFile && <FileThumbnail file={student.latestFile} onPreview={() => onPreview(student.latestFile!)}/>}
          <span className="assessment-work-count">{student.submissionCount} ไฟล์</span>
          <span className="assessment-score">{student.publishedScore === null ? "—" : `${Number(student.publishedScore)} / ${Number(student.publishedMaxScore)}`}</span>
          <span className={"assessment-state " + (student.draftHasNewWork || student.publishedHasNewWork ? "needs-review" : "")}>{status}</span>
        </div>
        {isExpanded && <div className="assessment-detail">
          {filesLoading ? <p className="inline-loading"><i className="spinner"/>กำลังโหลดไฟล์…</p> : files.length ? <div className="work-file-list">{files.map((file) => <article className="work-file" key={file.id}>
            <FileThumbnail file={file} onPreview={() => onPreview(file)}/><div className="work-file-copy"><strong>{file.originalName}</strong><small>{file.studentSubmission ? "ส่งโดยนักเรียน" : "ครูอัปโหลดให้"} · {formatBytes(Number(file.sizeBytes))}</small></div>
            <div className="work-file-actions">{file.mediaType.startsWith("model/") && <button className="text-button" onClick={() => onPreview(file)}>แสดงตัวอย่าง</button>}<a className="text-button" href={`/api/files/${file.id}/content`} download>ดาวน์โหลด</a><button className="text-button subdued" onClick={() => void remove(file)}>ลบ</button></div>
          </article>)}</div> : <p className="muted">ยังไม่มีไฟล์งาน</p>}
          <form className="assessment-form" onSubmit={(event) => void saveDraft(event)}>
            <label>คะแนน<input type="number" min="0" max={max} step="0.01" value={score} onChange={(event) => setScore(event.target.value)} required/><small>จาก {max} คะแนน</small></label>
            <label>ความคิดเห็น<textarea maxLength={5000} rows={3} value={feedback} onChange={(event) => setFeedback(event.target.value)}/></label>
            <div className="assessment-actions"><button className="button button-primary" disabled={busy || filesLoading || !validScore}>{busy ? "กำลังบันทึก…" : "บันทึกฉบับร่าง"}</button><button className="button button-quiet" type="button" disabled={busy || filesLoading || !student.draftUpdatedAt || student.draftHasNewWork || score === ""} onClick={() => void publish(student)}>เผยแพร่คะแนน</button>{student.publishedAt && <button className="text-button" type="button" disabled={busy} onClick={() => void unpublish(student)}>ซ่อนคะแนน</button>}</div>
          </form>
          {student.publishedScore !== null && <p className="assessment-published">คะแนนที่นักเรียนเห็น: {Number(student.publishedScore)} / {Number(student.publishedMaxScore)}{student.publishedFeedback ? " · " + student.publishedFeedback : ""}</p>}
        </div>}
      </article>;
    })}</div> : <p className="muted">ไม่พบนักเรียนในห้องเรียนนี้</p>}
    {pageCount > 1 && <footer className="assessment-pagination"><button className="button button-quiet" disabled={page <= 1} onClick={() => { setExpanded(""); setPage((value) => value - 1); }}>ก่อนหน้า</button><span>หน้า {page} / {pageCount} · นักเรียน {total} คน</span><button className="button button-quiet" disabled={page >= pageCount} onClick={() => { setExpanded(""); setPage((value) => value + 1); }}>ถัดไป</button></footer>}
  </section>;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
