import type { WioLabId } from "../../src/wio-labs";
import { StudentWioLab } from "./StudentWioLab";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "./api";
import { LessonContent, type LessonBlock } from "./LessonContent";
import { StudentAttendance } from "./StudentAttendance";
import { CodeLessonFrame } from "./CodeLesson";
import type { CodeBlock } from "./code-lesson";
import { WorksheetActivity } from "./WorksheetActivity";

type LessonLab = { assignmentId: string; preset: WioLabId; title: string; instructions: string; maxScore: number | string };
type Page = { id: string; title: string; editorMode: "blocks" | "code"; blocks: LessonBlock[]; quizLinks?: { quizId: string; label: string }[]; worksheets?: { id: string; title: string }[];
  wioLab?: LessonLab | null };
export type LessonLink = { id: string; title: string; classroomId: string; classroomName: string };

export function PublicLessonPage({ id, classroomId, studentId, login }: { id: string; classroomId?: string; studentId?: string; login: ReactNode }) {
  const student = Boolean(studentId);
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [choices, setChoices] = useState<LessonLink[]>([]);
  const [signIn, setSignIn] = useState(false);
  const base = classroomId ? `/student/classrooms/${classroomId}/lesson-pages/${id}` : `/public/lesson-pages/${id}`;
  const imageUrl = useCallback((imageId: string) => `/api${base}/images/${imageId}/content`, [base]);
  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    setPage(null); setError(""); setChoices([]); setSignIn(false);
    if (classroomId && !student) { setSignIn(true); return; }
    async function load() {
      try {
        const result = await api<Page>(base, options);
        if (!controller.signal.aborted) setPage(result);
      }
      catch (reason) {
        if (controller.signal.aborted) return;
        if (!classroomId && reason instanceof ApiError && reason.status === 404) {
          if (!student) { setSignIn(true); return; }
          try {
            const links = (await api<LessonLink[]>("/student/lesson-pages", options)).filter((link) => link.id === id);
            if (controller.signal.aborted) return;
            if (links.length === 1) {
              window.location.replace(`/lessons/${id}/classrooms/${links[0].classroomId}`);
              return;
            }
            if (links.length) { setChoices(links); return; }
          } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "โหลดบทเรียนไม่สำเร็จ"); return; }
        }
        setError(reason instanceof Error ? reason.message : "โหลดบทเรียนไม่สำเร็จ");
      }
    }
    void load();
    return () => controller.abort();
  }, [base, classroomId, id, studentId, student, retry]);
  useEffect(() => {
    document.title = page?.title ?? "บทเรียน";
    const robots = document.createElement("meta"); robots.name = "robots"; robots.content = "noindex,nofollow"; document.head.append(robots);
    return () => { robots.remove(); document.title = "Classroom"; };
  }, [page?.title]);
  if (signIn) return login;
  return <main className="public-lesson-page">
    <div className="public-lesson-brand"><a href="/">ห้องเรียน</a></div>
    {student && <StudentAttendance />}
    {page ? <>{page.editorMode === "code"
      ? <CodeLessonFrame code={page.blocks[0] as CodeBlock} imageUrl={imageUrl} autoRun />
      : <div className="lesson-reading panel"><LessonContent title={page.title} blocks={page.blocks} imageUrl={imageUrl} /></div>}
      {studentId && classroomId && page.wioLab && <LessonWioLab key={page.wioLab.assignmentId} studentId={studentId} classroomId={classroomId} lab={page.wioLab} />}
      {page.quizLinks?.length ? <section className="panel public-lesson-quizzes"><h2>แบบทดสอบ</h2><div>{page.quizLinks.map((link) => <a className="button button-primary" key={link.quizId} href={`/quizzes/${link.quizId}?role=student`}>{link.label}</a>)}</div></section> : null}
      {page.worksheets?.map((round) => <WorksheetActivity key={round.id} roundId={round.id} title={round.title} />)}</>
      : choices.length ? <section className="panel public-lesson-quizzes"><h1>เลือกห้องเรียนสำหรับบทเรียนนี้</h1><div>{choices.map((link) => <a className="button button-primary" key={link.classroomId} href={`/lessons/${id}/classrooms/${link.classroomId}`}>{link.classroomName}</a>)}</div></section>
      : error ? <section className="panel public-lesson-quizzes"><h1>เปิดบทเรียนไม่ได้</h1><p className="muted">{error}</p><button className="button button-quiet" onClick={() => setRetry((value) => value + 1)}>ลองอีกครั้ง</button></section>
        : <section className="panel inline-loading"><i className="spinner" />กำลังโหลดบทเรียน…</section>}
  </main>;
}

function LessonWioLab({ studentId, classroomId, lab }: { studentId: string; classroomId: string; lab: LessonLab }) {
  const [uploads, setUploads] = useState<{ id: string; originalName: string; createdAt: string }[]>([]);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const path = `/student/classrooms/${classroomId}/assignments/${lab.assignmentId}/files`;
    setError("");
    void api<{ id: string; kind: string; originalName: string; createdAt: string }[]>(path, { signal: controller.signal })
      .then((files) => {
        if (!controller.signal.aborted) setUploads(files.filter((file) => file.kind === "submission" && file.originalName.toLowerCase().endsWith(".ino")));
      })
      .catch(() => { if (!controller.signal.aborted) setError("โหลดไฟล์ .ino ที่ส่งแล้วไม่สำเร็จ"); });
    return () => controller.abort();
  }, [classroomId, lab.assignmentId, revision]);

  return <section className="panel">
    <header className="panel-heading compact"><div><p className="eyebrow">ห้องปฏิบัติการ Wio Terminal</p><h2>{lab.title}</h2>
      <p className="muted">คะแนนเต็ม {Number(lab.maxScore)} คะแนน</p>
      {lab.instructions && <p className="assignment-instructions">{lab.instructions}</p>}</div></header>
    <StudentWioLab studentId={studentId} classroomId={classroomId} assignmentId={lab.assignmentId} lab={lab.preset}
      onSubmitted={() => setRevision((value) => value + 1)} />
    <section className="student-submission-groups">
      <h3>ไฟล์ .ino ที่ส่งแล้ว</h3>
      {error && <p className="form-error" role="alert">{error} <button className="text-button" onClick={() => setRevision((value) => value + 1)}>ลองอีกครั้ง</button></p>}
      {uploads.length > 0 && <ul>{uploads.map((file) => <li key={file.id}>
        <a href={`/api/student/files/${file.id}/content`} download>{file.originalName}</a>
        {" · "}<time dateTime={file.createdAt}>{new Date(file.createdAt).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" })}</time>
      </li>)}</ul>}
    </section>
  </section>;
}
