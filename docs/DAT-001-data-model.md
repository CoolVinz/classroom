# DAT-001 — Data Model

## Storage boundary

PostgreSQL 18 or newer stores app data in an app-owned `classroom` schema in the configured database. The migration creates only objects inside this schema. The app stops if the schema is not owned by the configured database login or contains untracked objects.

## Entities and relationships

- **Teacher:** UUID ID, unique normalized username, display name, Argon2id password hash, owner/teacher role, active flag, creation time. A partial unique index permits at most one owner.
- **Session:** SHA-256 token hash, teacher foreign key, creation and expiry timestamps. Deleting a teacher cascades to their sessions.
- **Classroom:** UUID ID, owner teacher foreign key, name, optional archive time, creation time. Class ownership is the main data-access boundary.
- **Student:** UUID ID, classroom foreign key, optional positive 32-bit classroom number, optional school code, display name, optional archive time, creation time. Student codes are unique within a classroom; active non-null numbers are unique within a classroom, while archived rows retain their number; `(id, classroom_id)` supports attendance/file composite foreign keys.
- **Student account:** UUID ID, unique normalized email, nullable unique Google subject, historical nullable password hash, and creation time. A nullable account link on a roster row lets one account access several classrooms; email addresses are unique per roster within a classroom.
- **Student session/auth token:** Hashed 14-day session tokens reference an account. The legacy invitation/reset-token table remains for schema compatibility, but migration 004 clears its rows and no route issues or consumes them.
- **Attendance:** classroom and student foreign keys, `DATE`, status, update timestamp. Composite primary key `(student_id, attendance_date)` allows one daily mark per student. A composite foreign key keeps the classroom consistent with the student's roster.
- **Weekly timetable:** one per classroom, with term bounds and grace minutes; child weekday rows store one start/end time window per ISO weekday in Bangkok local time.
- **Lesson:** one dated classroom lesson with snapshotted `TIMESTAMPTZ` start/end, grace, cancellation, and finalization timestamps. Future unstarted lessons can be resynchronized from timetable edits; started and historical lessons remain stable.
- **Attendance provenance and presence:** attendance source distinguishes manual from automatic results. `attendance_presence` stores first arrival, last contact, estimated visible seconds, and a short-lived active-view lease per roster student/day; its composite foreign keys bind both student and lesson to the same classroom.
- **Assignment:** UUID ID, classroom foreign key, title, instructions, editable positive maximum score (default 100), archive and creation timestamps. `(id, classroom_id)` supports file/classroom consistency.
- **Assessment:** one row per assignment and classroom student, with a private draft score/feedback/reviewed-file list and revision, plus a separately snapshotted published result, maximum score, and revision. Composite classroom-scoped foreign keys prevent cross-class assessment links; roster removal cascades only the removed student's assessment. Student APIs read only the published snapshot.
- **File:** stable UUID ID, classroom and assignment foreign keys, optional student, teacher-uploader, and student-submitter foreign keys, kind, original and generated storage names, media type, original byte size, optional thumbnail byte size and image/png or image/webp media type, work-order sequence, and creation timestamp. Worksheets require a teacher uploader and have no student; models and submissions require a student in the same classroom. New student submissions identify the uploading account; a model cannot have both teacher and student submitter attribution. Working files belong to a roster student but have no submitter/uploader attribution, and a partial unique index allows one per assignment/student.
- **Lesson page:** UUID and owning teacher foreign key, immutable block/code editor mode, draft title and structured JSON/revision, nullable published title/content/revision and publish time, and nullable `trashed_at`. Trash retains snapshots and the stable UUID but hides the public page and images; restore retains the prior publication state. Permanent deletion cascades to its images only.
- **Lesson page image:** UUID, lesson foreign key, safe original filename, generated storage UUID, optimized WebP byte size, and creation time. Block or code snapshots refer to image UUIDs; public reads require the image to be referenced by the current published snapshot.
- **Quiz:** UUID, owner teacher, title, JSON draft and revision, separate nullable published title/content/revision/time, and nullable `trashed_at`. Drafts may be incomplete. Published JSON contains the description and ordered questions, choices, answer IDs, points, explanations, and image UUID references. Trash retains snapshots and round history while hiding quiz-linked access.
- **Quiz image:** UUID, quiz foreign key, safe original filename, unique storage UUID, optimized WebP size, and creation time. Images are retained while a saved draft, current published quiz, or classroom round snapshot references them.
- **Classroom quiz round:** UUID, classroom/owner/quiz references, immutable title and published-content snapshot, optional duration, state (`awaiting_open`, `open`, `closed`), and open/close/solutions-release times. A new round copies the then-published quiz; later library edits do not change it.
- **Quiz attempt:** UUID, round/classroom/student composite references, JSON answer map, revision, server start/deadline/finish times, finish reason, and total score. Unique `(classroom_quiz_id, student_id)` permits one attempt per student per round. Student removal cascades only that student's attempt in that classroom.
- **Lesson quiz links:** JSON draft and published snapshots on a lesson page store quiz UUIDs and button labels. Publishing snapshots links with the lesson title/content; the link renders outside custom-code frames. Buttons are hidden while their quiz is trashed. Permanent quiz deletion removes matching references and increments affected lesson revisions.
- **Gallery world:** one optional enabled flag per classroom. `gallery_blocks` assigns a stable per-student block index; blocks are created under a classroom advisory lock and retained through roster archival.
- **Gallery character appearance:** each teacher and student account stores a validated JSON appearance (skin, hair, shirt, and trousers colors plus one of three hair styles). Existing accounts use a default; settings are shared by that account across classrooms and do not contain identity or role data.
- **Gallery display state:** `gallery_hidden_models` stores teacher-hidden file UUIDs. `gallery_likes` is unique per model/student and scoped to that student's classroom membership. File/student deletion removes likes and hidden metadata through existing file/roster references.
- **Gallery admission ticket:** a SHA-256 token hash, classroom, actor kind/account, optional roster student, existing session hash, and 60-second expiry/consumption timestamps. Tickets are single-use; the Colyseus service checks the active session and membership again after admission.

## Constraints and behavior

- Attendance status is constrained to `present`, `absent`, `late`, or `excused`; an unmarked student has no attendance row.
- Existing attendance remains keyed once per roster student/day and is marked manual by migration default. Presence duration is stored separately and does not affect status counts.
- The server determines lesson eligibility and timestamps. A visible focused-page heartbeat is capped at 45 credited seconds; duplicate/stale views cannot extend a lease, and one student account may track only one classroom at once.
- Finalization records eligible no-arrivals as absent after lesson end, preserves all existing marks, and is idempotent. Manual marks override automatic results until explicitly reset.
- Attendance dates are calendar dates, interpreted as Asia/Bangkok for “today”; future dates are rejected.
- Teacher passwords are never stored in plaintext. Student login uses Google's verified `sub` identity; old student password hashes are retained but no longer used. Session cookies carry a random token while PostgreSQL stores its hash.
- Student account access is derived from active roster rows. Archiving a roster row or its classroom removes that membership from student APIs while preserving the account and file/attendance history.
- Classroom numbers stay assigned while archived, but may be reused by another active student; restoration conflicts until the number is available.
- Permanent student removal deletes that classroom's attendance, attributed files, legacy student-specific tokens, and roster row in one transaction. It frees that classroom's number/code/email and preserves the shared account and other-classroom roster records. Stored files are staged using `.deleting` and cleaned after commit.
- Quiz access is bound to active roster membership. Round snapshots preserve their answer keys server-side; student API projections hide correctness and explanations until a teacher releases solutions after closing the round. Quiz scores are separate from assignment assessments and daily attendance.
- Trash state is teacher-owned soft deletion with no expiry. Quiz trash closes open rounds and grades saved answers transactionally; restore never reopens them. Permanent quiz deletion cascades through rounds and attempts. Image files are staged as `.deleting` before metadata deletion and removed after commit; rollback restores staged files.
- Classroom/student archival is soft archival; attendance rows remain. Summaries include archived students so earlier records remain visible.
- Assignment archival is soft; attached files remain. File removal deletes the row and stored content.
- Blender working files use the existing private file table and upload volume, count toward quota, and are excluded from submissions and marking. A student can replace or delete only their own current file; teachers can download or delete files in their classrooms.
- Student import matches `student_code` within one classroom. Existing details are preserved; only active matches missing a classroom number can be updated by import. Archived and already-numbered IDs are skipped; imported spreadsheets are not stored.
- Blank emails on digit-only student IDs become the digits plus `@banjan.ac.th`, preserving leading zeroes. Existing nonblank emails are preserved, and the migration leaves classroom email collisions unchanged for teacher correction.
- Assignment files, lesson pictures, and quiz images live outside PostgreSQL on the shared persistent application volume. PostgreSQL keeps ownership, storage UUIDs, and byte accounting. The shared quota counts original and thumbnail bytes from assignment file rows plus optimized lesson and quiz image bytes.
- Lesson code is stored as text and is never evaluated by the server. The browser runs it only inside a sandboxed iframe with a restrictive Content Security Policy and a fixed external-host allowlist.
- Original files and generated 256 × 192 thumbnails share the persistent upload volume. Existing thumbnail files may be PNG; new previews are WebP. The database records thumbnail size and media type plus assessment-reviewed file UUIDs. Original and thumbnail bytes both count toward the configured storage quota.
- A roster import requires student IDs even though manual student creation still permits a blank code.
- The API enforces classroom ownership for classroom, roster, attendance, and summary access. PostgreSQL row-level security is not configured.
- Gallery files remain in the shared upload volume and are served only through gallery routes that recheck classroom ownership/membership, active roster and assignment state, supported model kind, and teacher-hidden state. Existing private submission routes are unchanged.

## Open questions

- Student names are edited in place, so historical summaries show the student's current name. Should historical names be snapshotted?
- What student information or retention limits are required beyond name and optional code?
- Gallery display blocks and likes are separate from assessment. They reference current model/submission files and do not expose score, feedback, or Blender working-file records.
