# MOD-002 — Classrooms and Student Rosters

**Status:** Implemented
**Coupling:** MEDIUM
**Risk:** HIGH

## Purpose and behavior

Let an authenticated teacher create and manage their own classrooms and student lists. Owners can manage their own classrooms too, but do not inherit access to other teachers' classroom records.

## Workflows

- Create a named classroom, rename it, or archive it.
- Add a student with a required name and optional classroom-specific code/email, or import a roster from XLSX/CSV or cells copied from Google Sheets/Excel with optional email and title-prefix columns. Split first and last names are combined, including a nonblank prefix; a missing email is generated as `<numeric student ID>@banjan.ac.th`, preserving leading zeroes.
- For paste import, copy cells including the header row, open the paste option, paste the table, and request a preview before confirming. Tab-separated clipboard text preserves leading-zero IDs and quoted cells; input is limited to 5 MiB and 1,000 students. Editing the pasted text clears its previous preview. Parsing stays in the browser; only confirmed roster records are sent to the existing import API.
- Edit student name/code/email; archive or restore a student without deleting attendance history.
- Preview roster imports by student ID; existing IDs, including archived students, are skipped without changing their details or attendance.
- A verified student Google email automatically links matching active roster rows across classrooms on sign-in. Teachers can edit a roster email when it is missing or incorrect.

## Business rules

- Every class has one owning teacher. APIs filter class and roster access by that owner.
- Student code is optional and unique within its classroom when supplied.
- Student email is unique within a classroom when supplied; numeric IDs receive a generated address unless an email is explicitly provided. The same Google student account may be linked in different classrooms.
- Archiving a roster row immediately removes that classroom from the student's access; restoring it restores the membership if its account is still linked.
- Classroom/student archival is soft; archived classrooms are hidden from the active list. No class restore screen is currently provided.
- Student names are updated in place; historical attendance summaries resolve the current name.

## Dependencies and consumers

**dependencies:** MOD-001, DAT-001
**used_by:** MOD-003, MOD-004

**Code Map:**

```text
UI: web/src/App.tsx (ClassList, ClassDetail, Roster and Google linkage status)
API and ownership: src/routes/classrooms.ts
Import preview and email mapping: web/src/StudentRosterImport.tsx, web/src/roster-import.ts
Import API: src/routes/coursework.ts
Auth and owner scope: src/auth/session.ts
Database: src/db/migrations/001_initial.sql (classrooms, students), src/db/migrations/003_student_submissions.sql (email/account links), src/db/migrations/004_google_student_auth.sql (numeric-ID email backfill)
Tests: web/src/roster-import.test.ts
```

## Technical debt and warnings

- API handlers perform authorization and SQL directly; there is no separate classroom service layer.
- Google email matching can be blocked by duplicate or inconsistent roster entries; teachers must correct those records before the student can access the classroom.
- Classroom archiving is not reversible in the current UI; it hides the room while retaining its records.

## Open questions

- Should archived classrooms be restorable from the UI?
- Should changing a student name preserve earlier names on past attendance reports?
