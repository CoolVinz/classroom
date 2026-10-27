# MOD-001 — Authentication and Teacher Accounts

**Status:** Implemented
**Coupling:** HIGH
**Risk:** HIGH

## Purpose and behavior

Authenticate owner and teacher accounts with passwords and students with verified Google Workspace accounts. The owner manages teacher credentials. A student's verified school email links all matching active roster rows across classrooms to one Google-subject account.

## Workflows

- Teachers and owners sign in by username/password; students use Google's redirect sign-in button. Sign out revokes the current session.
- Create the initial owner through a one-time CLI or first-start environment seed.
- Owner creates a teacher login, disables/enables it, or sets a new password.
- Google ID tokens are verified for signature, audience, issuer, expiry, verified email, and the configured Workspace `hd` claim. A school email suffix alone is not sufficient.
- First sign-in reuses a matching legacy student account when it has no conflicting Google subject, then attaches eligible active roster rows in a transaction. A conflicting account or roster link is rejected; accounts are never merged.
- New student accounts are created only when an active, nonarchived classroom roster row matches the verified school email. Later sign-ins by the same Google subject continue only while an active classroom membership exists.
- Teacher and student sessions are stored in separate tables; a student session cannot authorize teacher APIs. The one-time migration clears existing student sessions and invitation/reset tokens while preserving teacher sessions and historical password hashes.
- Student password and invitation endpoints return HTTP 410; old `/student/activate`, `/student/forgot`, and `/student/reset` links redirect to Google sign-in.

## Business rules

- Username is normalized to lowercase; owner provisioning and teacher creation require a 3–40 character username using lowercase letters, digits, dot, dash, or underscore.
- Teacher passwords require at least 12 characters and are hashed with Argon2id. Students have no password login; historical student password hashes are retained but unused.
- The database permits at most one owner account. Only an owner can manage teacher accounts.
- Sessions are random 32-byte tokens in HttpOnly, SameSite=Lax cookies. Only SHA-256 token hashes are stored, with a 14-day expiry; production cookies use Secure.
- Google's double-submit `g_csrf_token` cookie/body pair is checked on the cross-site redirect callback. The callback does not use the app's same-origin check because Google posts directly to it.
- Teacher login throttling uses process-local memory keyed by username.
- Student access is limited to active classroom roster rows linked to the account. Archiving a student or classroom removes that membership from student APIs and clears its active attendance-tracking lease.

## Dependencies and consumers

**dependencies:** `src/db/client.ts`, DAT-001, `src/security.ts`
**used_by:** MOD-002, MOD-003, MOD-004; every protected API route

**Code Map:**

```text
UI: web/src/App.tsx (teacher/Google student login, TeacherAdmin)
API: src/routes/auth.ts, src/routes/student-auth.ts, src/routes/teachers.ts
Session/access checks: src/auth/session.ts, src/routes/student-coursework.ts
Input and origin checks: src/security.ts
Database: src/db/migrations/001_initial.sql (teachers, sessions), 003_student_submissions.sql (student accounts, sessions, tokens), 004_google_student_auth.sql (Google subject, passwordless accounts, email backfill, session/token invalidation)
Tests: src/student-workflow.test.ts (optional PostgreSQL integration; set CLASSROOM_TEST_DATABASE_URL)
```

## Technical debt and warnings

- A live Google sign-in test requires the school's OAuth client, authorized callback, and Google Workspace policy approval.
- Login throttling is an in-memory counter per account identifier and resets on process restart; it is not shared between replicas.
- Initial owner seed variables must be removed after first account creation.
- Initial owner self-service password change is not implemented.

## Open questions

- Should the owner be able to change their own password in the app?
- Which Google Workspace administrator approval steps apply to Banjan School's student accounts?
