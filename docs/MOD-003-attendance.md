# MOD-003 — Daily Attendance and Summaries

**Status:** Implemented
**Coupling:** HIGH
**Risk:** HIGH

## Purpose and behavior

Record one daily attendance status for every active student in a classroom and view per-student status counts over a selected date range.

## Workflows

- Select a classroom and date (default Asia/Bangkok today).
- Mark students present, absent, late, excused, or leave them unmarked; the UI can mark everyone present.
- Save the full active roster in a database transaction. Existing marks update; unmarked students have no record.
- Review class summaries across a date range; archived students remain visible in historical summaries.

## Business rules

- PostgreSQL stores attendance date as `DATE`; future dates are rejected by both UI and API.
- A student can have at most one attendance status on a calendar date.
- Allowed persisted statuses are `present`, `absent`, `late`, and `excused`.
- Saving requires the submitted student IDs to match the active roster. Stale or duplicate rosters fail without partial writes.
- A summary counts saved statuses only; unmarked students do not count as absent.

## Dependencies and consumers

**dependencies:** MOD-001, MOD-002, DAT-001
**used_by:** Dashboard attendance totals and classroom summary screens

**Code Map:**

```text
UI: web/src/App.tsx (Attendance, SummaryPage, RoomSummary)
API and SQL: src/routes/classrooms.ts
Bangkok dates/input helpers: src/security.ts
Database: src/db/migrations/001_initial.sql (attendance)
Tests: None found
```

## Technical debt and warnings

- No automated tests verify date boundaries, ownership, transactional saves, or summary calculations.
- Attendance rules live in the classroom route module alongside roster behavior.
- Past attendance dates remain editable; no audit history or change log exists.

## Open questions

- Should saved attendance become immutable after a daily cutoff, or should edits be audited?
- What export format, if any, do teachers need for summaries?
