# MOD-001 — Authentication and Teacher Accounts

**Status:** Implemented
**Coupling:** HIGH
**Risk:** HIGH

## Purpose and behavior

Authenticate owner, teacher, and invited student accounts with server-side sessions. The owner manages teacher credentials; teachers send one-time email invitations to rostered students. Students can link roster records across classrooms to one account.

## Workflows

- Sign in by username/password; sign out and revoke the active session.
- Create the initial owner through a one-time CLI or first-start environment seed.
- Owner creates a teacher login, disables/enables it, or sets a new password.
- A teacher sends or resends an invitation to the email stored on a roster row. The student opens the one-time link, sets a password, and can then sign in by email.
- Students request a one-time password recovery link by email. Completing recovery revokes all student sessions.
- Teacher and student sessions are stored in separate tables; a student session cannot authorize teacher APIs.

## Business rules

- Username is normalized to lowercase; owner provisioning and teacher creation require a 3–40 character username using lowercase letters, digits, dot, dash, or underscore.
- Passwords require at least 12 characters and are hashed with Argon2id.
- The database permits at most one owner account. Only an owner can manage teacher accounts.
- Sessions are random 32-byte tokens in HttpOnly, SameSite=Lax cookies. Only SHA-256 token hashes are stored, with a 14-day expiry; production cookies use Secure.
- Invitation tokens are one-time and expire after 24 hours; password recovery tokens expire after one hour. Only their SHA-256 hashes are stored.
- Mutating requests check origin and reject cross-site requests. Login and recovery-request throttles use process-local memory keyed by username or email.
- Student access is limited to active classroom roster rows linked to the account. Archiving a student or classroom removes that membership from student APIs.

## Dependencies and consumers

**dependencies:** `src/db/client.ts`, DAT-001, `src/security.ts`
**used_by:** MOD-002, MOD-003, MOD-004; every protected API route

**Code Map:**

```text
UI: web/src/App.tsx (teacher/student login, TeacherAdmin), web/src/StudentAccess.tsx
API: src/routes/auth.ts, src/routes/student-auth.ts, src/routes/teachers.ts
Session/access checks: src/auth/session.ts, src/routes/student-coursework.ts
Email delivery: src/student-mail.ts (SMTP)
Input and origin checks: src/security.ts
Database: src/db/migrations/001_initial.sql (teachers, sessions), 003_student_submissions.sql (student accounts, sessions, tokens)
Tests: src/student-workflow.test.ts (optional PostgreSQL integration; set CLASSROOM_TEST_DATABASE_URL)
```

## Technical debt and warnings

- SMTP delivery and end-to-end password-reset email delivery require a configured provider and are not tested against a live mail server.
- Login throttling is an in-memory counter per account identifier and resets on process restart; it is not shared between replicas.
- Initial owner seed variables must be removed after first account creation.
- Initial owner self-service password change is not implemented.

## Open questions

- Should the owner be able to change their own password in the app?
- Are MFA or additional student account recovery safeguards required?
