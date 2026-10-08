# MOD-002 — Classrooms and Student Rosters

**Status:** Implemented
**Coupling:** MEDIUM
**Risk:** HIGH

## Purpose and behavior

Let an authenticated teacher create and manage their own classrooms and student lists. Owners can manage their own classrooms too, but do not inherit access to other teachers' classroom records.

## Workflows

- Create a named classroom, rename it, or archive it.
- Add a student with a required name and optional classroom-specific code/email, or import a roster from XLSX/CSV with an optional email column.
- Edit student name/code/email; archive or restore a student without deleting attendance history.
- Preview roster imports by student ID; existing IDs, including archived students, are skipped without changing their details or attendance.
- Teachers can invite or resend an invitation to an active student with an email address. One email-based account can link roster rows in multiple classrooms.

## Business rules

- Every class has one owning teacher. APIs filter class and roster access by that owner.
- Student code is optional and unique within its classroom when supplied.
- Student email is optional and unique within a classroom when supplied. The same student account may be linked in different classrooms.
- Archiving a roster row immediately removes that classroom from the student's access; restoring it restores the membership if its account is still linked.
- Classroom/student archival is soft; archived classrooms are hidden from the active list. No class restore screen is currently provided.
- Student names are updated in place; historical attendance summaries resolve the current name.

## Dependencies and consumers

**dependencies:** MOD-001, DAT-001
**used_by:** MOD-003, MOD-004

**Code Map:**

```text
UI: web/src/App.tsx (ClassList, ClassDetail, Roster)
API and ownership: src/routes/classrooms.ts
Import preview and email mapping: web/src/StudentRosterImport.tsx, web/src/roster-import.ts
Import API: src/routes/coursework.ts
Auth and owner scope: src/auth/session.ts
Database: src/db/migrations/001_initial.sql (classrooms, students), src/db/migrations/003_student_submissions.sql (email/account links)
Tests: web/src/roster-import.test.ts
```

## Technical debt and warnings

- API handlers perform authorization and SQL directly; there is no separate classroom service layer.
- No PostgreSQL ownership or attendance-preservation integration tests are present.
- Classroom archiving is not reversible in the current UI; it hides the room while retaining its records.

## Open questions

- Should archived classrooms be restorable from the UI?
- Should changing a student name preserve earlier names on past attendance reports?
