# MOD-004 — Assignments and Classroom Files

**Status:** Implemented
**Coupling:** HIGH
**Risk:** HIGH

## Purpose and behavior

Let teachers create classroom assignments and attach worksheets, and let students with linked accounts submit work directly. Files keep a stable UUID, classroom/student/assignment links, and a separate student submitter identity. Teachers can still upload an STL/OBJ model on a student's behalf.

Students see active assignments and attached worksheets for their classrooms, plus their own work; classmates' submissions stay private. They can submit PDF, PNG/JPEG, DOC/DOCX, STL, or OBJ files. Each upload appends a separate record and students cannot replace or delete earlier uploads. Teachers see per-student submitted/not-submitted status and can preview or download files. Models have a browser preview with orbit controls, fit-to-model framing, and wireframe mode. Assignments can be archived and restored; teacher file deletion requires confirmation.

## Workflows and rules

- Teachers create or edit an assignment and attach one or more worksheet files.
- Teachers upload one or more model files for an active student in that classroom.
- Teacher file routes check classroom ownership. Student routes require a student session and an active linked roster row; students can see worksheets and their own attributed files only.
- An assignment, student, and file must belong to the same classroom. Models require a student; worksheets do not.
- Allowed formats: PDF, PNG, JPEG, DOC/DOCX, STL, OBJ. Teacher and student uploads default to 50 MiB each and 5 GiB total; configured limits are enforced by the server.
- Production storage defaults to `/app/uploads`; development defaults to `./uploads`. Container storage must be mounted persistently and backed up separately.
- The preview uses neutral geometry and accepts up to 500,000 triangles, with a 10-second parse limit. Complex models remain downloadable.
- Assignment archival hides work from students while preserving associated files. Earlier models and submissions are never replaced by later uploads.
- Student uploads use the same private storage and UUIDs as teacher files. STL/OBJ remain distinguishable for future gallery use; the gallery itself is not implemented here.

## Dependencies and consumers

**dependencies:** MOD-001, MOD-002, DAT-001, TEC-001

**used_by:** future REQ-001

**Code Map:**

```text
UI: web/src/ClassroomWork.tsx
Model preview: web/src/ModelPreview.tsx, web/src/model-preview.worker.ts
API and teacher ownership: src/routes/coursework.ts
Student submissions: src/routes/student-coursework.ts, web/src/StudentPortal.tsx
Upload validation and storage: src/file-storage.ts
Database: src/db/migrations/002_assignments_files.sql, src/db/migrations/003_student_submissions.sql
Migration runner: src/db/bootstrap.ts
Tests: src/file-storage.test.ts, src/student-workflow.test.ts (optional PostgreSQL integration)
```

## Technical debt and warnings

- Files are stored on the application host. Loss of the VPS or volume loses uploads unless an off-server copy exists.
- SMTP delivery and live Coolify persistent-volume behavior still need production configuration and verification.
- OBJ textures/material libraries and browser-side file version history are unsupported.

## Open questions

- What storage capacity and off-site backup schedule will production use?
- What model-size and device-performance limits should the future classroom world impose?
