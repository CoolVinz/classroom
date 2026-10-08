import { createHash, randomBytes } from "node:crypto";
import { sql } from "../db/client";
import { HttpError } from "../http-error";

export type Actor = {
  id: string;
  username: string;
  displayName: string;
  role: "owner" | "teacher";
  active: boolean;
};

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function sessionCookie(token: string, remove = false) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const age = remove ? 0 : 60 * 60 * 24 * 14;
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

export async function readActor(request: Request): Promise<Actor | null> {
  const cookie = request.headers.get("cookie")?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("classroom_session="));
  const token = cookie?.slice("classroom_session=".length);
  if (!token || token.length > 128) return null;

  const [row] = await sql<Actor[]>`
    SELECT t.id, t.username, t.display_name AS "displayName", t.role, t.active
    FROM classroom.sessions s
    JOIN classroom.teachers t ON t.id = s.teacher_id
    WHERE s.token_hash = ${hashToken(token)}
      AND s.expires_at > NOW()
      AND t.active = TRUE
  `;
  return row ?? null;
}

export async function requireActor(request: Request): Promise<Actor> {
  const actor = await readActor(request);
  if (!actor) throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
  return actor;
}

export async function requireOwner(request: Request): Promise<Actor> {
  const actor = await requireActor(request);
  if (actor.role !== "owner") throw new HttpError(403, "เฉพาะผู้ดูแลบัญชีเท่านั้น");
  return actor;
}
