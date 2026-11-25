import { useEffect, useState } from "react";
import { api } from "./api";
import type { LessonLink } from "./PublicLessonPage";
import { worksheetStatus, type WorksheetRound } from "./WorksheetActivity";

type ActivityLink = WorksheetRound & { classroomId: string; score: number | null };

export function StudentLearning({ classroomId, refreshVersion }: { classroomId: string; refreshVersion: number }) {
  const [lessons, setLessons] = useState<LessonLink[]>([]);
  const [activities, setActivities] = useState<ActivityLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    setLoading(true); setError(false);
    Promise.all([api<LessonLink[]>("/student/lesson-pages", options), api<ActivityLink[]>("/student/worksheets", options)])
      .then(([pages, rounds]) => { if (!controller.signal.aborted) { setLessons(pages); setActivities(rounds); } })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [retry, refreshVersion]);
  const visible = <T extends { classroomId: string }>(items: T[]) => items.filter((item) => !classroomId || item.classroomId === classroomId);
  return <>
    <section className="panel"><header className="panel-heading compact"><h2>บทเรียน</h2><button className="text-button" disabled={loading} onClick={() => setRetry((value) => value + 1)}>โหลดใหม่</button></header>
      {loading ? <p className="inline-loading">กำลังโหลดบทเรียน…</p> : error ? <p className="assignment-empty" role="alert">โหลดบทเรียนและใบงานไม่สำเร็จ</p> :
        <div className="assignment-list">{visible(lessons).length ? visible(lessons).map((lesson) => <a className="assignment-select student-quiz-link" href={`/lessons/${lesson.id}/classrooms/${lesson.classroomId}`} key={`${lesson.id}:${lesson.classroomId}`}><strong>{lesson.title}</strong><small>{lesson.classroomName}</small></a>) : <p className="assignment-empty muted">ยังไม่มีบทเรียนสำหรับห้องเรียนที่เลือก</p>}</div>}
    </section>
    <section className="panel"><header className="panel-heading compact"><h2>ใบงานกิจกรรม</h2></header>
      {!error && <div className="assignment-list">{loading ? <p className="inline-loading">กำลังโหลดใบงาน…</p> : visible(activities).length ? visible(activities).map((activity) => <a className="assignment-select student-quiz-link" href={`/worksheets/${activity.id}`} key={activity.id}><strong>{activity.title}</strong><small>{activity.classroomName} · {activity.score === null ? worksheetStatus[activity.status] : `คะแนน ${activity.score} / ${activity.maxScore}`}</small></a>) : <p className="assignment-empty muted">ยังไม่มีใบงานให้ทำ</p>}</div>}
    </section>
  </>;
}
