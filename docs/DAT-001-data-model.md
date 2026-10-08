# DAT-001 — Data Model

## Storage boundary

PostgreSQL 18 or newer stores app data in an app-owned `classroom` schema in the configured database. The migration creates only objects inside this schema. The app stops if the schema is not owned by the configured database login or contains untracked objects.

## Entities and relationships

- **Teacher:** UUID ID, unique normalized username, display name, Argon2id password hash, owner/teacher role, active flag, creation time. A partial unique index permits at most one owner.
- **Session:** SHA-256 token hash, teacher foreign key, creation and expiry timestamps. Deleting a teacher cascades to their sessions.
- **Classroom:** UUID ID, owner teacher foreign key, name, optional archive time, creation time. Class ownership is the main data-access boundary.
- **Student:** UUID ID, classroom foreign key, optional code, display name, optional archive time, creation time. Student codes are unique within a classroom; `(id, classroom_id)` supports attendance's composite foreign key.
- **Attendance:** classroom and student foreign keys, `DATE`, status, update timestamp. Composite primary key `(student_id, attendance_date)` allows one daily mark per student. A composite foreign key keeps the classroom consistent with the student's roster.

## Constraints and behavior

- Attendance status is constrained to `present`, `absent`, `late`, or `excused`; an unmarked student has no attendance row.
- Attendance dates are calendar dates, interpreted as Asia/Bangkok for “today”; future dates are rejected.
- Passwords are never stored in plaintext. Session cookies carry a random token while PostgreSQL stores its hash.
- Classroom/student archival is soft archival; attendance rows remain. Summaries include archived students so earlier records remain visible.
- The API enforces classroom ownership for classroom, roster, attendance, and summary access. PostgreSQL row-level security is not configured.

## Open questions

- Student names are edited in place, so historical summaries show the student's current name. Should historical names be snapshotted?
- What student information or retention limits are required beyond name and optional code?
