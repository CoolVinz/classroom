# MOD-003 — Scheduled Daily Attendance and Summaries

**Status:** Implemented
**Coupling:** HIGH
**Risk:** HIGH

## Purpose and behavior

Record one daily attendance result per roster student, collect automatic arrivals and estimated visible-app time during scheduled lessons, and review per-student status and time totals.

## Workflows

- Teachers configure a term, weekdays, continuous start/end times, and late-arrival grace in Asia/Bangkok; they can cancel an individual upcoming lesson. Dated lessons snapshot their schedule, so started/history records survive later timetable edits.
- A signed-in student opening the portal while one eligible lesson is in progress is automatically recorded as present through the grace cutoff, otherwise late. A single linked classroom starts automatically; overlapping classrooms require selection.
- Focused, visible portal time is estimated with 30-second heartbeats and a 45-second server lease. Hidden or unfocused pages pause; long gaps and stale/duplicate tabs do not accrue disconnected time. Minutes are informational and do not affect status.
- Teachers can manually mark present, absent, late, excused, or unmarked; manual status overrides automatic status. “Restore automatic” re-applies the recorded arrival result without erasing timing evidence.
- After a lesson ends, teachers can finalize it once. Students eligible at lesson end with neither attendance nor an arrival are marked absent; existing marks remain unchanged.
- Without a scheduled lesson, the existing manual workflow remains available. Date-range summaries count saved statuses and show estimated visible time separately; archived students remain visible in historical summaries.

## Business rules

- PostgreSQL stores attendance date as `DATE`; the single daily key remains `(student_id, attendance_date)` because each roster ID belongs to one classroom. Future dates are rejected by both UI and API.
- Dated lessons use Bangkok calendar dates and `TIMESTAMPTZ` start/end instants. A timetable permits one continuous lesson per weekday and at most 365 days between its start and end dates; only unstarted, unfinalized future lessons follow edits. The API error handler is registered on the root app before its route modules so timetable validation messages reach the UI as JSON.
- Timetable term dates and teacher/student lesson dates use `YYYY-MM-DD` in API responses and requests. Start/end instants remain ISO timestamps; calendar dates must not be serialized as timestamps into date inputs, cancellation URLs, or student presence requests.
- Arrival is based on the first server timestamp during `[lesson start, lesson end)`. Arrival at or before `start + grace` is present; arrival after the grace cutoff is late. No early arrival or automatic absence is recorded.
- Presence timing is separate from status. Server time is authoritative; each student/class/day has one active-view lease, and at most 45 seconds are credited per heartbeat interval. A stale gap resets the baseline.
- A student may track at most one classroom at a time. Every heartbeat revalidates the authenticated account and active roster membership. Archiving membership/classroom clears its active tracking lease.
- Teacher status saves and automatic status updates coordinate on a per-student/day transaction lock. Manual marks remain authoritative until reset; reset restores the automatic arrival result when one exists.
- Finalization is idempotent, runs after lesson end, preserves existing results, and excludes students created or archived after lesson end. Later teacher corrections remain available.
- Permanent roster removal deletes that student's attendance and presence rows in the selected classroom.
- Allowed persisted statuses are `present`, `absent`, `late`, and `excused`.
- Saving requires the submitted student IDs to match the active roster. Stale or duplicate rosters fail without partial writes.
- A summary counts saved statuses only; unmarked students do not count as absent.

## Dependencies and consumers

**dependencies:** MOD-001, MOD-002, DAT-001
**used_by:** Dashboard attendance totals and classroom summary screens

**Code Map:**

```text
Teacher UI: web/src/App.tsx (Attendance, SummaryPage, RoomSummary)
Timetable UI: web/src/AttendanceTimetable.tsx
Student tracking UI: web/src/StudentAttendance.tsx, web/src/StudentPortal.tsx
Daily attendance API: src/routes/classrooms.ts
Timetable, cancellation, reset, finalization API: src/routes/attendance-schedule.ts
Student lesson and heartbeat API: src/routes/student-attendance.ts
Migration: src/db/migrations/006_scheduled_attendance.sql
Bangkok dates/input helpers: src/security.ts
Database: src/db/migrations/001_initial.sql (daily attendance), 006_scheduled_attendance.sql (timetable, lessons, provenance, presence)
Tests: src/student-workflow.test.ts (set CLASSROOM_TEST_DATABASE_URL to an isolated PostgreSQL 18 database)
```

## Technical debt and warnings

- Visible time is an estimate of focused browser-page use, not proof of physical presence, attention, or time spent in Blender/other apps.
- Automated tests do not simulate real browser focus/visibility timing or many concurrent devices under load.
- Attendance and roster rules share `src/routes/classrooms.ts`; scheduling and student heartbeats are separate route modules.
- Past attendance dates remain editable; no audit history or change log exists.

## Open questions

- Should teacher corrections be audited beyond the current manual/automatic provenance flag?
- What export format, if any, do teachers need for summaries?
