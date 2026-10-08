import { createHash, randomBytes } from "node:crypto";
import { Elysia, t } from "elysia";
import { createStudentSession, sessionCookie } from "../auth/session";
import { sql } from "../db/client";
import { HttpError } from "../http-error";
import { checkRequestOrigin, normalizeEmail } from "../security";
import { sendStudentAccessEmail } from "../student-mail";

type Account = { id: string; email: string; passwordHash: string };
const attempts = new Map<string, { count: number; resetAt: number }>();
const resetAttempts = new Map<string, { count: number; resetAt: number }>();

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function accountEmail(value: string) {
  return normalizeEmail(value) ?? "";
}

export const studentAuthRoutes = new Elysia({ prefix: "/api/auth/student" })
  .post("/login", async ({ body, request, set }) => {
    checkRequestOrigin(request);
    const email = accountEmail(body.email);
    const now = Date.now();
    const bucket = attempts.get(email);
    if (bucket && bucket.resetAt > now && bucket.count >= 8) throw new HttpError(429, "ลองเข้าสู่ระบบอีกครั้งในอีกสักครู่");
    const [account] = await sql<Account[]>`
      SELECT id, email, password_hash AS "passwordHash"
      FROM classroom.student_accounts WHERE email = ${email}
    `;
    const matches = await Bun.password.verify(body.password, account?.passwordHash ?? dummyPasswordHash);
    if (!account || !matches) {
      const next = bucket && bucket.resetAt > now ? bucket : { count: 0, resetAt: now + 60_000 };
      next.count += 1;
      attempts.set(email, next);
      throw new HttpError(401, "อีเมลหรือรหัสผ่านไม่ถูกต้อง");
    }
    attempts.delete(email);
    const [membership] = await sql<{ displayName: string }[]>`
      SELECT s.display_name AS "displayName"
      FROM classroom.students s JOIN classroom.classrooms c ON c.id = s.classroom_id
      WHERE s.account_id = ${account.id} AND s.archived_at IS NULL AND c.archived_at IS NULL
      ORDER BY s.created_at LIMIT 1
    `;
    if (!membership) throw new HttpError(401, "บัญชียังไม่มีห้องเรียนที่ใช้งานได้");
    const token = await createStudentSession(account.id);
    set.headers["Set-Cookie"] = sessionCookie(token);
    return { user: { id: account.id, username: account.email, displayName: membership.displayName, role: "student" as const } };
  }, { body: t.Object({ email: t.String({ minLength: 3, maxLength: 254 }), password: t.String({ minLength: 1, maxLength: 200 }) }) })
  .post("/invite/status", async ({ body }) => {
    const [invite] = await sql<{ needsPassword: boolean }[]>`
      SELECT NOT EXISTS (SELECT 1 FROM classroom.student_accounts a WHERE a.email = i.email) AS "needsPassword"
      FROM classroom.student_auth_tokens i
      JOIN classroom.students s ON s.id = i.student_id
      JOIN classroom.classrooms c ON c.id = s.classroom_id
      WHERE i.token_hash = ${tokenHash(body.token)} AND i.token_kind = 'invite'
        AND i.consumed_at IS NULL AND i.expires_at > NOW()
        AND i.email = s.email AND s.archived_at IS NULL AND c.archived_at IS NULL
    `;
    if (!invite) throw new HttpError(410, "ลิงก์เชิญหมดอายุหรือใช้งานแล้ว");
    return invite;
  }, { body: t.Object({ token: t.String({ minLength: 20, maxLength: 128 }) }) })
  .post("/invite/accept", async ({ body, request, set }) => {
    checkRequestOrigin(request);
    if (body.password !== undefined && body.password.length < 12) throw new HttpError(422, "รหัสผ่านต้องมีอย่างน้อย 12 ตัวอักษร");
    const accepted = await sql.begin(async (tx) => {
      const [invite] = await tx<{ email: string; studentId: string }[]>`
        SELECT i.email, i.student_id AS "studentId"
        FROM classroom.student_auth_tokens i
        JOIN classroom.students s ON s.id = i.student_id
        JOIN classroom.classrooms c ON c.id = s.classroom_id
        WHERE i.token_hash = ${tokenHash(body.token)} AND i.token_kind = 'invite'
          AND i.consumed_at IS NULL AND i.expires_at > NOW()
          AND i.email = s.email AND s.archived_at IS NULL AND c.archived_at IS NULL
        FOR UPDATE OF i, s
      `;
      if (!invite) throw new HttpError(410, "ลิงก์เชิญหมดอายุหรือใช้งานแล้ว");
      await tx`SELECT pg_advisory_xact_lock(hashtext(${invite.email})::bigint)`;
      let [account] = await tx<Account[]>`
        SELECT id, email, password_hash AS "passwordHash"
        FROM classroom.student_accounts WHERE email = ${invite.email} FOR UPDATE
      `;
      if (!account) {
        if (!body.password) throw new HttpError(422, "กรุณาตั้งรหัสผ่านอย่างน้อย 12 ตัวอักษร");
        const passwordHash = await Bun.password.hash(body.password, { algorithm: "argon2id" });
        [account] = await tx<Account[]>`
          INSERT INTO classroom.student_accounts (email, password_hash)
          VALUES (${invite.email}, ${passwordHash}) RETURNING id, email, password_hash AS "passwordHash"
        `;
      }
      await tx`
        UPDATE classroom.students SET account_id = ${account.id}
        WHERE id = ${invite.studentId} AND email = ${invite.email}
      `;
      await tx`UPDATE classroom.student_auth_tokens SET consumed_at = NOW() WHERE token_hash = ${tokenHash(body.token)}`;
      return { accountId: account.id, email: account.email };
    });
    const [membership] = await sql<{ displayName: string }[]>`
      SELECT display_name AS "displayName" FROM classroom.students
      WHERE account_id = ${accepted.accountId} AND archived_at IS NULL ORDER BY created_at LIMIT 1
    `;
    const session = await createStudentSession(accepted.accountId);
    set.headers["Set-Cookie"] = sessionCookie(session);
    return { user: { id: accepted.accountId, username: accepted.email, displayName: membership?.displayName ?? accepted.email, role: "student" as const } };
  }, { body: t.Object({ token: t.String({ minLength: 20, maxLength: 128 }), password: t.Optional(t.String({ maxLength: 200 })) }) })
  .post("/password-reset/request", async ({ body, request }) => {
    checkRequestOrigin(request);
    if (!process.env.SMTP_HOST?.trim() || !process.env.EMAIL_FROM?.trim()) {
      throw new HttpError(503, "ระบบอีเมลยังไม่ได้ตั้งค่า");
    }
    const email = accountEmail(body.email);
    const now = Date.now();
    const bucket = resetAttempts.get(email);
    if (bucket && bucket.resetAt > now && bucket.count >= 3) return { ok: true, message: "หากอีเมลนี้มีบัญชี ระบบจะส่งลิงก์ตั้งรหัสผ่านให้" };
    const next = bucket && bucket.resetAt > now ? bucket : { count: 0, resetAt: now + 15 * 60_000 };
    next.count++;
    resetAttempts.set(email, next);
    const [account] = await sql<{ id: string }[]>`SELECT id FROM classroom.student_accounts WHERE email = ${email}`;
    if (account) {
      const token = randomBytes(32).toString("base64url");
      const hash = tokenHash(token);
      await sql.begin(async (tx) => {
        await tx`DELETE FROM classroom.student_auth_tokens WHERE token_kind = 'password_reset' AND account_id = ${account.id}`;
        await tx`
          INSERT INTO classroom.student_auth_tokens (token_hash, token_kind, email, account_id, expires_at)
          VALUES (${hash}, 'password_reset', ${email}, ${account.id}, NOW() + INTERVAL '1 hour')
        `;
      });
      try {
        await sendStudentAccessEmail(email, new URL("/student/reset#token=" + token, process.env.APP_URL ?? "http://localhost:3000").toString(), "password_reset");
      } catch (error) {
        await sql`DELETE FROM classroom.student_auth_tokens WHERE token_hash = ${hash}`;
        console.error("Student password reset email delivery failed:", error instanceof Error ? error.message : "Unknown error");
      }
    }
    return { ok: true, message: "หากอีเมลนี้มีบัญชี ระบบจะส่งลิงก์ตั้งรหัสผ่านให้" };
  }, { body: t.Object({ email: t.String({ minLength: 3, maxLength: 254 }) }) })
  .post("/password-reset/confirm", async ({ body, request }) => {
    checkRequestOrigin(request);
    if (body.password.length < 12) throw new HttpError(422, "รหัสผ่านต้องมีอย่างน้อย 12 ตัวอักษร");
    const hash = tokenHash(body.token);
    const accountId = await sql.begin(async (tx) => {
      const [token] = await tx<{ accountId: string }[]>`
        SELECT account_id AS "accountId" FROM classroom.student_auth_tokens
        WHERE token_hash = ${hash} AND token_kind = 'password_reset'
          AND consumed_at IS NULL AND expires_at > NOW()
        FOR UPDATE
      `;
      if (!token) throw new HttpError(410, "ลิงก์หมดอายุหรือใช้งานแล้ว");
      const passwordHash = await Bun.password.hash(body.password, { algorithm: "argon2id" });
      await tx`UPDATE classroom.student_accounts SET password_hash = ${passwordHash} WHERE id = ${token.accountId}`;
      await tx`UPDATE classroom.student_auth_tokens SET consumed_at = NOW() WHERE token_hash = ${hash}`;
      await tx`DELETE FROM classroom.student_sessions WHERE account_id = ${token.accountId}`;
      return token.accountId;
    });
    return { ok: true, accountId };
  }, { body: t.Object({ token: t.String({ minLength: 20, maxLength: 128 }), password: t.String({ minLength: 12, maxLength: 200 }) }) });

const dummyPasswordHash = await Bun.password.hash(randomBytes(32).toString("hex"), { algorithm: "argon2id" });
