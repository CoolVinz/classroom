import { createHash, randomBytes } from "node:crypto";
import type postgres from "postgres";
import { sql } from "../db/client";
import { HttpError } from "../http-error";

export type Actor = {
  id: string;
  username: string;
  displayName: string;
  role: "owner" | "teacher";
  active: boolean;
};

export type StudentActor = {
  id: string;
  username: string;
  displayName: string;
  role: "student";
  active: true;
  isTester: boolean;
};

export type SessionUser = Actor | StudentActor;

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

const standardSessionSeconds = 60 * 60 * 24 * 14;

export function sessionCookie(token: string, remove = false, durationSeconds = standardSessionSeconds) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const age = remove ? 0 : durationSeconds;
  return `classroom_session=${remove ? "" : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure}`;
}

export async function createSession(teacherId: string) {
  const token = randomBytes(32).toString("base64url");
  await sql`
    INSERT INTO classroom.sessions (token_hash, teacher_id, expires_at)
    VALUES (${hashToken(token)}, ${teacherId}, NOW() + INTERVAL '14 days')
  `;
  return token;
}

export async function createStudentSession(accountId: string, db: postgres.ISql = sql, durationSeconds = standardSessionSeconds) {
  const token = randomBytes(32).toString("base64url");
  await db`
    INSERT INTO classroom.student_sessions (token_hash, account_id, expires_at)
    VALUES (${hashToken(token)}, ${accountId}, NOW() + ${durationSeconds} * INTERVAL '1 second')
  `;
  return token;
}

export async function readActor(request: Request, db: postgres.ISql = sql): Promise<Actor | null> {
  const cookie = request.headers.get("cookie")?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("classroom_session="));
  const token = cookie?.slice("classroom_session=".length);
  if (!token || token.length > 128) return null;

  const [row] = await db<Actor[]>`
    SELECT t.id, t.username, t.display_name AS "displayName", t.role, t.active
    FROM classroom.sessions s
    JOIN classroom.teachers t ON t.id = s.teacher_id
    WHERE s.token_hash = ${hashToken(token)}
      AND s.expires_at > NOW()
      AND t.active = TRUE
  `;
  return row ?? null;
}

export async function readStudentActor(request: Request, db: postgres.ISql = sql): Promise<StudentActor | null> {
  const cookie = request.headers.get("cookie")?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("classroom_session="));
  const token = cookie?.slice("classroom_session=".length);
  if (!token || token.length > 128) return null;

  const [row] = await db<StudentActor[]>`
    SELECT a.id, COALESCE(a.email, 'นักเรียนทดสอบ') AS username,
      COALESCE((SELECT s.display_name FROM classroom.students s
        JOIN classroom.classrooms c ON c.id = s.classroom_id
        WHERE s.account_id = a.id AND s.archived_at IS NULL AND c.archived_at IS NULL
        ORDER BY s.created_at LIMIT 1), a.email) AS "displayName",
      'student' AS role, TRUE AS active, a.test_classroom_id IS NOT NULL AS "isTester"
    FROM classroom.student_sessions ss
    JOIN classroom.student_accounts a ON a.id = ss.account_id
    WHERE ss.token_hash = ${hashToken(token)} AND ss.expires_at > NOW()
      AND EXISTS (SELECT 1 FROM classroom.students s
        JOIN classroom.classrooms c ON c.id = s.classroom_id
        WHERE s.account_id = a.id AND s.archived_at IS NULL AND c.archived_at IS NULL)
  `;
  return row ?? null;
}

export async function readSessionUser(request: Request, db: postgres.ISql = sql): Promise<SessionUser | null> {
  return await readActor(request, db) ?? await readStudentActor(request, db);
}

export async function deleteSession(token: string) {
  const hash = hashToken(token);
  await sql.begin(async (tx) => {
    await tx`DELETE FROM classroom.sessions WHERE token_hash = ${hash}`;
    await tx`DELETE FROM classroom.student_sessions WHERE token_hash = ${hash}`;
  });
}

export async function requireActor(request: Request): Promise<Actor> {
  const actor = await readActor(request);
  if (!actor) throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
  return actor;
}

export async function requireStudent(request: Request): Promise<StudentActor> {
  const actor = await readStudentActor(request);
  if (!actor) throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
  return actor;
}

export async function requireOwner(request: Request): Promise<Actor> {
  const actor = await requireActor(request);
  if (actor.role !== "owner") throw new HttpError(403, "เฉพาะผู้ดูแลบัญชีเท่านั้น");
  return actor;
}
