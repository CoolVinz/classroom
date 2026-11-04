# MOD-004 — Assignments and Classroom Files

**Status:** Implemented
**Coupling:** HIGH
**Risk:** HIGH

## Purpose and behavior

Let teachers create classroom assignments and attach worksheets, and let students with linked accounts submit work directly. Files keep a stable UUID, classroom/student/assignment links, and a separate student submitter identity. Teachers can still upload an STL/OBJ model on a student's behalf.

Students see active assignments and attached worksheets for their classrooms, plus their own work; classmates' submissions stay private. They can submit PDF, PNG/JPEG, DOC/DOCX, STL, or OBJ files. Each upload appends a separate record and students cannot replace or delete earlier uploads. Teachers review work grouped by student, with 20 students per page, submission counts, latest-work thumbnails, status, score, and an expandable file list. They can save a private draft score and feedback, then publish or unpublish each student's result separately. Published score, feedback, and maximum-score snapshot are the only assessment fields returned to student APIs. New uploads remain in the file history and flag work as awaiting review without replacing prior marks. Models have an interactive browser preview with orbit controls, fit-to-model framing, and wireframe mode. Assignments can be archived and restored; teacher file deletion requires confirmation.

Each assignment has an editable maximum score (default 100). Scores allow zero and two decimal places; the maximum cannot be lowered below any saved score. Editing a draft does not change the previously published result. Saving records the file UUIDs reviewed; later uploads remain unreviewed until the teacher saves again.

## Workflows and rules

- Teachers create or edit an assignment and attach one or more worksheet files.
- Teachers upload one or more model files for an active student in that classroom.
- Teacher file routes check classroom ownership. Student routes require a student session and an active linked roster row; students can see worksheets and their own attributed files only. Permanent student removal deletes attributed file metadata and stages stored files for cleanup under the same storage lock used by uploads and individual file deletion.
- An assignment, student, and file must belong to the same classroom. Models require a student; worksheets do not.
- Allowed formats: PDF, PNG, JPEG, DOC/DOCX, STL, OBJ. Teacher and student uploads default to 50 MiB each and 5 GiB total; configured limits are enforced by the server.
- Production storage defaults to `/app/uploads`; development defaults to `./uploads`. Container storage must be mounted persistently and backed up separately.
- Content requests check the configured upload directory and file before streaming. Authorized requests receive a clear `404` when an original is missing and a safe `503` when storage is unavailable; existing teacher/student authorization still runs first.
- The preview uses neutral geometry and accepts up to 500,000 triangles, with a 10-second parse limit. Complex models remain downloadable.
- Browser-generated 256 × 192 previews for STL/OBJ and PNG/JPEG files are saved beside originals and reused directly on later visits. New previews are stored as quality-80 WebP; existing PNG previews remain readable. Missing previews are generated lazily when visible; PDF and Word files use document icons. Model thumbnails render one at a time and open the interactive viewer when clicked. A failed thumbnail does not block upload or download.
- Thumbnail read/write routes enforce the same classroom ownership and active student membership as original files. The server validates PNG checksums and decoded dimensions, limits incoming images to 256 KiB, and converts them to WebP with sharp. Thumbnail bytes count toward the total storage quota.
- Saved thumbnail image URLs use the authenticated `/api` routes directly; a saved model preview is displayed without fetching or rendering its original model again.
- Thumbnails share the `/app/uploads/thumbnails` persistent volume. File and student removal stage thumbnails with originals, restore them on database rollback, and let startup reconciliation finish interrupted cleanup.
- Assignment archival hides work from students while preserving associated files. Earlier models and submissions are never replaced by later uploads.
- Removing a student from one classroom removes their files only in that classroom; shared Google accounts and records in other classes remain. Individual-file removal and student removal coordinate with uploads, move stored content to `.deleting` before database commit, restore staged content on rollback, and unlink after commit. Missing physical files do not block record deletion.
- Student uploads use the same private storage and UUIDs as teacher files. STL/OBJ remain distinguishable for future gallery use; the gallery itself is not implemented here.

## Dependencies and consumers

**dependencies:** MOD-001, MOD-002, DAT-001, TEC-001

**used_by:** future REQ-001

**Code Map:**

```text
UI and assignment limits: web/src/ClassroomWork.tsx
Assessment list and draft/publish controls: web/src/AssignmentAssessment.tsx
Thumbnails and job queue: web/src/FileThumbnail.tsx, web/src/thumbnail-jobs.ts
Shared model loading/rendering: web/src/model-view.ts, web/src/model-preview.worker.ts
Interactive model preview: web/src/ModelPreview.tsx
Teacher assignments, files, and assessments: src/routes/coursework.ts
Student submissions and published results: src/routes/student-coursework.ts, web/src/StudentPortal.tsx
Upload and thumbnail validation/storage: src/file-storage.ts
Database: src/db/migrations/002_assignments_files.sql, src/db/migrations/003_student_submissions.sql, src/db/migrations/007_thumbnails_assessments.sql, src/db/migrations/008_thumbnail_media_type.sql
Migration runner: src/db/bootstrap.ts
Tests: web/src/model-view.test.ts, src/file-storage.test.ts, src/student-workflow.test.ts (PostgreSQL integration)
```

## Technical debt and warnings

- Files are stored on the application host. Loss of the VPS or volume loses uploads unless an off-server copy exists.
- Production now has a Coolify volume mounted at `/app/uploads` with `UPLOAD_DIR=/app/uploads`. An audit on 2026-11-02 found 70 file records but no corresponding uploaded contents in the active container; no old container or upload volume remained. Metadata and attribution are preserved, but missing originals must be re-uploaded.
- OBJ textures/material libraries and browser-side file version history are unsupported.
- Legacy files need an initial visible thumbnail-generation pass; missing originals cannot produce thumbnails. Model thumbnails need browser WebGL; unsupported or complex files keep a fallback.

## Open questions

- What storage capacity and off-site backup schedule will production use?
- What model-size and device-performance limits should the future classroom world impose?
