import { lazy, Suspense } from "react";
import type { WioLabId } from "../../src/wio-labs";
import { api } from "./api";

const WioLab = lazy(() => import("./WioLab"));

export function StudentWioLab({ studentId, classroomId, assignmentId, lab, disabled = false, onSubmitting, onSubmitted }: {
  studentId: string; classroomId: string; assignmentId: string; lab: WioLabId; disabled?: boolean;
  onSubmitting?: (submitting: boolean) => void; onSubmitted?: () => void | Promise<void>;
}) {
  async function submit(source: string) {
    onSubmitting?.(true);
    try {
      const body = new FormData();
      body.set("file", new File([source], `wio-${lab}.ino`, { type: "text/plain" }));
      await api(`/student/classrooms/${classroomId}/assignments/${assignmentId}/files`, { method: "POST", body });
      await onSubmitted?.();
    } finally { onSubmitting?.(false); }
  }

  const draftKey = `classroom:wio:${studentId}:${assignmentId}:${lab}`;
  return <Suspense fallback={<p className="inline-loading">กำลังเปิด Wio Terminal…</p>}>
    <WioLab key={draftKey} lab={lab} draftKey={draftKey} disabled={disabled} submit={submit} />
  </Suspense>;
}
