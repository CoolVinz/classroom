# MOD-002 — Classrooms and Student Rosters

**Status:** Implemented
**Coupling:** MEDIUM
**Risk:** HIGH

## Purpose and behavior

Let an authenticated teacher create and manage their own classrooms and student lists. Owners can manage their own classrooms too, but do not inherit access to other teachers' classroom records.

## Workflows

- Create a named classroom, rename it, or archive it.
- Add a student with a required name and optional classroom-specific code.
- Edit student name/code; archive or restore a student without deleting attendance history.

## Business rules

- Every class has one owning teacher. APIs filter class and roster access by that owner.
- Student code is optional and unique within its classroom when supplied.
- Classroom/student archival is soft; archived classrooms are hidden from the active list. No class restore screen is currently provided.
- Student names are updated in place; historical attendance summaries resolve the current name.

## Dependencies and consumers

**dependencies:** MOD-001, DAT-001
**used_by:** MOD-003

**Code Map:**

```text
UI: web/src/App.tsx (ClassList, ClassDetail, Roster)
API and ownership: src/routes/classrooms.ts
Auth and owner scope: src/auth/session.ts
Database: src/db/migrations/001_initial.sql (classrooms, students)
Tests: None found
```

## Technical debt and warnings

- API handlers perform authorization and SQL directly; there is no separate classroom service layer.
- No automated ownership, uniqueness, roster-editing, or archive tests are present.
- Classroom archiving is not reversible in the current UI; it hides the room while retaining its records.

## Open questions

- Should archived classrooms be restorable from the UI?
- Should changing a student name preserve earlier names on past attendance reports?
