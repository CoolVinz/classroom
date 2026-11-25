import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "./api";
import { LessonContent, type LessonBlock } from "./LessonContent";
import { StudentAttendance } from "./StudentAttendance";
import { CodeLessonFrame } from "./CodeLesson";
import type { CodeBlock } from "./code-lesson";
import { WorksheetActivity } from "./WorksheetActivity";

type Page = { id: string; title: string; editorMode: "blocks" | "code"; blocks: LessonBlock[]; quizLinks?: { quizId: string; label: string }[]; worksheets?: { id: string; title: string }[] };
export type LessonLink = { id: string; title: string; classroomId: string; classroomName: string };

export function PublicLessonPage({ id, classroomId, student, login }: { id: string; classroomId?: string; student: boolean; login: ReactNode }) {
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
  }, [base, classroomId, id, student, retry]);
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
      {page.quizLinks?.length ? <section className="panel public-lesson-quizzes"><h2>แบบทดสอบ</h2><div>{page.quizLinks.map((link) => <a className="button button-primary" key={link.quizId} href={`/quizzes/${link.quizId}?role=student`}>{link.label}</a>)}</div></section> : null}
      {page.worksheets?.map((round) => <WorksheetActivity key={round.id} roundId={round.id} title={round.title} />)}</>
      : choices.length ? <section className="panel public-lesson-quizzes"><h1>เลือกห้องเรียนสำหรับบทเรียนนี้</h1><div>{choices.map((link) => <a className="button button-primary" key={link.classroomId} href={`/lessons/${id}/classrooms/${link.classroomId}`}>{link.classroomName}</a>)}</div></section>
      : error ? <section className="panel public-lesson-quizzes"><h1>เปิดบทเรียนไม่ได้</h1><p className="muted">{error}</p><button className="button button-quiet" onClick={() => setRetry((value) => value + 1)}>ลองอีกครั้ง</button></section>
        : <section className="panel inline-loading"><i className="spinner" />กำลังโหลดบทเรียน…</section>}
  </main>;
}
