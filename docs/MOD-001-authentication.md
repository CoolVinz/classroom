# MOD-001 — Authentication and Teacher Accounts

**Status:** Implemented
**Coupling:** HIGH
**Risk:** HIGH

## Purpose and behavior

Authenticate owner and teacher accounts, maintain server-side sessions, and let the owner manage teacher credentials and access. There is no public registration or external identity provider.

## Workflows

- Sign in by username/password; sign out and revoke the active session.
- Create the initial owner through a one-time CLI or first-start environment seed.
- Owner creates a teacher login, disables/enables it, or sets a new password.
- Password reset and disabling remove that teacher's existing sessions.

## Business rules

- Username is normalized to lowercase; owner provisioning and teacher creation require a 3–40 character username using lowercase letters, digits, dot, dash, or underscore.
- Passwords require at least 12 characters and are hashed with Argon2id.
- The database permits at most one owner account. Only an owner can manage teacher accounts.
- Sessions are random 32-byte tokens in HttpOnly, SameSite=Lax cookies. Only SHA-256 token hashes are stored, with a 14-day expiry; production cookies use Secure.
- Mutating requests check origin and reject cross-site requests. Login attempts are limited per username in process memory.

## Dependencies and consumers

**dependencies:** `src/db/client.ts`, DAT-001, `src/security.ts`
**used_by:** MOD-002, MOD-003; every protected API route

**Code Map:**

```text
UI: web/src/App.tsx (Login, TeacherAdmin)
API: src/routes/auth.ts, src/routes/teachers.ts
Session/access checks: src/auth/session.ts
Input and origin checks: src/security.ts
Database: src/db/migrations/001_initial.sql (teachers, sessions)
Tests: None found
```

## Technical debt and warnings

- No automated authentication or authorization tests are present.
- Login throttling is an in-memory counter per username and resets on process restart; it is not shared between replicas.
- Initial owner seed variables must be removed after first account creation.
- Initial owner self-service password change is not implemented.

## Open questions

- Should the owner be able to change their own password in the app?
- Are MFA, invitations, or recovery flows required?
