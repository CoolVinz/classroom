import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { LessonContent, type LessonBlock } from "./LessonContent";
import { StudentAttendance } from "./StudentAttendance";
import { CodeLessonFrame } from "./CodeLesson";
import type { CodeBlock } from "./code-lesson";

type Page = { id: string; title: string; editorMode: "blocks" | "code"; blocks: LessonBlock[]; publishedAt: string };
type Student = { id: string; username: string; displayName: string; role: "student" };

export function PublicLessonPage({ student }: { student: Student | null }) {
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const id = window.location.pathname.split("/")[2] ?? "";
  const imageUrl = useCallback((imageId: string) => `/api/public/lesson-pages/${id}/images/${imageId}/content`, [id]);
  useEffect(() => {
    let current = true;
    setError("");
    api<Page>(`/public/lesson-pages/${id}`).then((result) => { if (current) setPage(result); })
      .catch((reason) => { if (current) setError(reason instanceof Error ? reason.message : "โหลดบทเรียนไม่สำเร็จ"); });
    return () => { current = false; };
  }, [id, retry]);
  useEffect(() => {
    document.title = page?.title ?? "บทเรียน";
    const robots = document.createElement("meta"); robots.name = "robots"; robots.content = "noindex,nofollow"; document.head.append(robots);
    return () => { robots.remove(); document.title = "Classroom"; };
  }, [page?.title]);
  return <main className="public-lesson-page">
    <div className="public-lesson-brand"><a href="/">ห้องเรียน</a></div>
    {student && <StudentAttendance />}
    {page ? page.editorMode === "code" ? <CodeLessonFrame code={page.blocks[0] as CodeBlock} imageUrl={imageUrl} autoRun />
      : <div className="lesson-reading panel"><LessonContent title={page.title} blocks={page.blocks} imageUrl={imageUrl} /></div>
      : error ? <section className="panel"><h1>เปิดบทเรียนไม่ได้</h1><p className="muted">{error}</p><button className="button button-quiet" onClick={() => setRetry((value) => value + 1)}>ลองอีกครั้ง</button></section>
        : <section className="panel inline-loading"><i className="spinner" />กำลังโหลดบทเรียน…</section>}
  </main>;
}
