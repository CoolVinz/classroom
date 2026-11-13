import { useEffect, useState } from "react";
import { api } from "./api";
import { LessonContent, type LessonBlock } from "./LessonContent";
import { StudentAttendance } from "./StudentAttendance";

type Page = { id: string; title: string; blocks: LessonBlock[]; publishedAt: string };
type Student = { id: string; username: string; displayName: string; role: "student" };

export function PublicLessonPage({ student }: { student: Student | null }) {
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const id = window.location.pathname.split("/")[2] ?? "";
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
    {page ? <div className="lesson-reading panel"><LessonContent title={page.title} blocks={page.blocks} imageUrl={(imageId) => `/api/public/lesson-pages/${page.id}/images/${imageId}/content`} /></div>
      : error ? <section className="panel"><h1>เปิดบทเรียนไม่ได้</h1><p className="muted">{error}</p><button className="button button-quiet" onClick={() => setRetry((value) => value + 1)}>ลองอีกครั้ง</button></section>
        : <section className="panel inline-loading"><i className="spinner" />กำลังโหลดบทเรียน…</section>}
  </main>;
}
