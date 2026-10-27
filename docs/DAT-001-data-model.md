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
- **Assignment:** UUID ID, classroom foreign key, title, instructions, archive and creation timestamps. `(id, classroom_id)` supports file/classroom consistency.
- **File:** stable UUID ID, classroom and assignment foreign keys, optional student, teacher-uploader, and student-submitter foreign keys, kind, original and generated storage names, media type, byte size, and creation timestamp. Worksheets require a teacher uploader and have no student; models and submissions require a student in the same classroom. New student submissions identify the uploading account; a model cannot have both teacher and student submitter attribution. Multiple files may reference one student and assignment.

## Constraints and behavior

- Attendance status is constrained to `present`, `absent`, `late`, or `excused`; an unmarked student has no attendance row.
- Attendance dates are calendar dates, interpreted as Asia/Bangkok for “today”; future dates are rejected.
- Teacher passwords are never stored in plaintext. Student login uses Google's verified `sub` identity; old student password hashes are retained but no longer used. Session cookies carry a random token while PostgreSQL stores its hash.
- Student account access is derived from active roster rows. Archiving a roster row or its classroom removes that membership from student APIs while preserving the account and file/attendance history.
- Classroom numbers stay assigned while archived, but may be reused by another active student; restoration conflicts until the number is available.
- Permanent student removal deletes that classroom's attendance, attributed files, legacy student-specific tokens, and roster row in one transaction. It frees that classroom's number/code/email and preserves the shared account and other-classroom roster records. Stored files are staged using `.deleting` and cleaned after commit.
- Classroom/student archival is soft archival; attendance rows remain. Summaries include archived students so earlier records remain visible.
- Assignment archival is soft; attached files remain. File removal deletes the row and stored content.
- Student import matches `student_code` within one classroom. Existing details are preserved; only active matches missing a classroom number can be updated by import. Archived and already-numbered IDs are skipped; imported spreadsheets are not stored.
- Blank emails on digit-only student IDs become the digits plus `@banjan.ac.th`, preserving leading zeroes. Existing nonblank emails are preserved, and the migration leaves classroom email collisions unchanged for teacher correction.
- File contents live outside PostgreSQL on persistent application storage. PostgreSQL keeps file ownership metadata.
- A roster import requires student IDs even though manual student creation still permits a blank code.
- The API enforces classroom ownership for classroom, roster, attendance, and summary access. PostgreSQL row-level security is not configured.

## Open questions

- Student names are edited in place, so historical summaries show the student's current name. Should historical names be snapshotted?
- What student information or retention limits are required beyond name and optional code?
- The future gallery's blocks and likes do not exist yet. Student accounts and student submissions now exist, and the gallery can reference their existing model file UUIDs later.
