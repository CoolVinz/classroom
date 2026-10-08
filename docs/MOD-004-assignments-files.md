# MOD-004 — Assignments and Classroom Files

**Status:** Implemented
**Coupling:** HIGH
**Risk:** HIGH

## Purpose and behavior

Let teachers create classroom assignments, attach worksheets, and associate each student's STL/OBJ models with that student and assignment. File records keep a stable UUID and separate student attribution from the optional teacher uploader, so future student uploads can reuse the same model records.

Worksheets can be viewed as PDF or images and downloaded as Word files. Models have a browser preview with orbit controls, fit-to-model framing, and wireframe mode. Assignments can be archived and restored; file deletion requires confirmation.

## Workflows and rules

- Teachers create or edit an assignment and attach one or more worksheet files.
- Teachers upload one or more model files for an active student in that classroom.
- Every file is private to the teacher who owns its classroom. File routes check the current teacher session and classroom owner.
- An assignment, student, and file must belong to the same classroom. Models require a student; worksheets do not.
- Allowed formats: PDF, PNG, JPEG, DOC/DOCX, STL, OBJ. Uploads default to 50 MiB each and 5 GiB total; configured limits are enforced by the server.
- Production storage defaults to `/app/uploads`; development defaults to `./uploads`. Container storage must be mounted persistently and backed up separately.
- The preview uses neutral geometry and accepts up to 500,000 triangles, with a 10-second parse limit. Complex models remain downloadable.
- Assignment archival preserves associated files. Earlier models are never replaced by a new upload.

## Dependencies and consumers

**dependencies:** MOD-001, MOD-002, DAT-001, TEC-001

**used_by:** future REQ-001

**Code Map:**

```text
UI: web/src/ClassroomWork.tsx
Model preview: web/src/ModelPreview.tsx, web/src/model-preview.worker.ts
API and ownership: src/routes/coursework.ts
Upload validation and storage: src/file-storage.ts
Database: src/db/migrations/002_assignments_files.sql
Migration runner: src/db/bootstrap.ts
Tests: src/file-storage.test.ts
```

## Technical debt and warnings

- Files are stored on the application host. Loss of the VPS or volume loses uploads unless an off-server copy exists.
- There are no PostgreSQL integration tests for ownership, quota races, or migration rollback.
- OBJ textures/material libraries and browser-side file version history are unsupported.

## Open questions

- What storage capacity and off-site backup schedule will production use?
- What model-size and device-performance limits should the future classroom world impose?
