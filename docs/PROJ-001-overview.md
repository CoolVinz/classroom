# PROJ-001 — Classroom Overview

## Purpose and users

A Thai-language classroom management app for teachers. Teachers manage their own classroom records. A single owner account provisions and manages teacher logins.

## Capabilities

- Sign-in for teachers and the owner.
- Teacher-owned classrooms and student rosters.
- Daily student attendance with present, absent, late, excused, or unmarked status.
- Per-class, per-student attendance counts over a selected date range.
- Owner-managed teacher creation, account disable/enable, and password reset.

The app has no student, parent, gradebook, assignment, or announcement interface in the current implementation.

## Main workflows

1. An administrator prepares the PostgreSQL schema and provisions the initial owner.
2. The owner creates a teacher account and gives its login details to the teacher.
3. A teacher creates a classroom, adds students, and maintains the roster.
4. A teacher records attendance for a classroom date and saves the full roster atomically.
5. A teacher views classroom/student attendance counts for a date range.

## Major boundaries

- **Authentication and accounts:** [MOD-001](MOD-001-authentication.md)
- **Classrooms and rosters:** [MOD-002](MOD-002-classrooms-rosters.md)
- **Attendance and summaries:** [MOD-003](MOD-003-attendance.md)
- **Persistence and ownership:** [DAT-001](DAT-001-data-model.md)
- **Runtime and deployment:** [TEC-001](TEC-001-architecture.md), [OPS-001](OPS-001-deployment.md)

## Open questions

- Should a teacher be allowed to change a previously saved attendance date? The UI currently allows editing any date up to today.
- Should the initial owner be able to change their own password from the interface? Current password reset is owner-to-teacher.
- What student-data retention or archival period is required?
