# MOD-002 — Classrooms and Student Rosters

**Status:** Implemented
**Coupling:** MEDIUM
**Risk:** HIGH

## Purpose and behavior

Let an authenticated teacher create and manage their own classrooms and student lists. Owners can manage their own classrooms too, but do not inherit access to other teachers' classroom records.

## Workflows

- Create a named classroom, rename it, or archive it.
- Add a student with a required name and optional classroom number, school ID, and email. Import XLSX/UTF-8 CSV files or copied Google Sheets/Excel cells; map a number column and optional email/prefix columns. Split first and last names are combined, including a nonblank prefix. Numeric school IDs generate `<ID>@banjan.ac.th`, preserving leading zeroes.
- Imports can use a header row or manually mapped columns without one; headerless mode includes the first student row. Preview additions, number-only updates, skipped records, and errors before sending confirmed rows to the API. Inputs are limited to 5 MiB and 1,000 students. Existing IDs keep all details; an active row without a number may receive one, while archived rows and already numbered rows are skipped.
- Edit student name/number/code/email; archive or restore a student without deleting history. Permanent removal is a separate confirmed action that deletes that student's attendance, attributed files, and roster membership from this classroom only.
- A verified student Google email automatically links matching active roster rows across classrooms on sign-in. Teachers can edit a roster email when it is missing or incorrect.

## Business rules

- Every class has one owning teacher. APIs filter class and roster access by that owner.
- Student code is optional and unique within its classroom when supplied.
- Classroom number is a nullable positive 32-bit integer, unique among active students in one classroom. Archiving preserves it and allows reuse; restoration fails with a conflict until the number is free. Gaps are allowed and no students are renumbered.
- Student email is unique within a classroom when supplied; numeric IDs receive a generated address unless an email is explicitly provided. The same Google student account may be linked in different classrooms.
- Archiving a roster row immediately removes that classroom from the student's access; restoring it restores the membership if its account is still linked.
- Permanent removal frees the classroom number, code, and email. The shared Google account and roster/history in other classrooms are unaffected.
- Classroom/student archival is soft; archived classrooms are hidden from the active list. No class restore screen is currently provided.
- Student names are updated in place; historical attendance summaries resolve the current name.

## Dependencies and consumers

**dependencies:** MOD-001, DAT-001
**used_by:** MOD-003, MOD-004

**Code Map:**

```text
UI: web/src/App.tsx (ClassList, ClassDetail, Roster, numbers, archive/restore and confirmed removal)
API and ownership: src/routes/classrooms.ts
Import preview, header/headerless mapping, and number-only reimport: web/src/StudentRosterImport.tsx, web/src/roster-import.ts
Import API: src/routes/coursework.ts
Auth and owner scope: src/auth/session.ts
Database: src/db/migrations/001_initial.sql (classrooms, students), src/db/migrations/003_student_submissions.sql (email/account links), src/db/migrations/004_google_student_auth.sql (numeric-ID email backfill), src/db/migrations/005_classroom_student_numbers.sql (class number and active uniqueness)
Tests: web/src/roster-import.test.ts, src/student-workflow.test.ts (optional PostgreSQL integration)
```

## Technical debt and warnings

- API handlers perform authorization and SQL directly; there is no separate classroom service layer.
- Google email matching can be blocked by duplicate or inconsistent roster entries; teachers must correct those records before the student can access the classroom.
- Classroom archiving is not reversible in the current UI; it hides the room while retaining its records.
- Permanent removal has no in-app undo. If file unlink fails, startup reconciliation handles the staged `.deleting` file after it is at least 24 hours old.

## Open questions

- Should archived classrooms be restorable from the UI?
- Should changing a student name preserve earlier names on past attendance reports?
