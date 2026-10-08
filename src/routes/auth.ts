import { Elysia, t } from "elysia";
import { randomBytes } from "node:crypto";
import { sql } from "../db/client";
import { createSession, deleteSession, readActor, readSessionUser, requireActor, sessionCookie } from "../auth/session";
import { checkRequestOrigin } from "../security";
import { HttpError } from "../http-error";

type LoginRow = { id: string; username: string; displayName: string; role: "owner" | "teacher"; active: boolean; passwordHash: string };
const attempts = new Map<string, { count: number; resetAt: number }>();
const dummyPasswordHash = await Bun.password.hash(randomBytes(32).toString("hex"), { algorithm: "argon2id" });

export const authRoutes = new Elysia({ prefix: "/api/auth" })
  .get("/me", async ({ request }) => ({ user: await readSessionUser(request) }))
  .post("/login", async ({ body, request, set }) => {
    checkRequestOrigin(request);
    const username = body.username.trim().toLowerCase();
    const now = Date.now();
    const bucket = attempts.get(username);
    if (bucket && bucket.resetAt > now && bucket.count >= 8) {
      throw new HttpError(429, "ลองเข้าสู่ระบบอีกครั้งในอีกสักครู่");
    }
    const [user] = await sql<LoginRow[]>`
      SELECT id, username, display_name AS "displayName", role, active, password_hash AS "passwordHash"
      FROM classroom.teachers WHERE username = ${username} LIMIT 1
    `;
    const matches = await Bun.password.verify(body.password, user?.passwordHash ?? dummyPasswordHash);
    if (!user || !matches || !user.active) {
      const next = bucket && bucket.resetAt > now ? bucket : { count: 0, resetAt: now + 60_000 };
      next.count += 1;
      attempts.set(username, next);
      throw new HttpError(401, "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง");
    }
    attempts.delete(username);
    const token = await createSession(user.id);
    set.headers["Set-Cookie"] = sessionCookie(token);
    return { user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role } };
  }, {
    body: t.Object({ username: t.String({ minLength: 1, maxLength: 100 }), password: t.String({ minLength: 1, maxLength: 200 }) }),
  })
  .post("/logout", async ({ request, set }) => {
    checkRequestOrigin(request);
    const actor = await readActor(request);
    const cookie = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith("classroom_session="));
    const token = cookie?.slice("classroom_session=".length);
    if (token) await deleteSession(token);
    set.headers["Set-Cookie"] = sessionCookie("", true);
    return { ok: true, signedOut: Boolean(actor) };
  })
  .get("/current", async ({ request }) => ({ user: await requireActor(request) }));
