import { Elysia, t } from "elysia";
import { requireOwner } from "../auth/session";
import { sql } from "../db/client";
import { HttpError } from "../http-error";
import { checkRequestOrigin, cleanText } from "../security";

export const teacherRoutes = new Elysia({ prefix: "/api/teachers" })
  .get("/", async ({ request }) => {
    await requireOwner(request);
    return sql`
      SELECT id, username, display_name AS "displayName", active,
        created_at AS "createdAt"
      FROM classroom.teachers WHERE role = 'teacher' ORDER BY display_name
    `;
  })
  .post("/", async ({ body, request }) => {
    checkRequestOrigin(request);
    await requireOwner(request);
    const username = body.username.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new HttpError(422, "ชื่อผู้ใช้ต้องมี 3–40 ตัวอักษร a–z, 0–9, จุด, ขีดกลาง หรือขีดล่าง");
    if (body.password.length < 12) throw new HttpError(422, "รหัสผ่านต้องมีอย่างน้อย 12 ตัวอักษร");
    const name = cleanText(body.displayName, 120);
    const passwordHash = await Bun.password.hash(body.password, { algorithm: "argon2id" });
    try {
      const [teacher] = await sql<{ id: string; username: string; displayName: string }[]>`
        INSERT INTO classroom.teachers (username, display_name, password_hash, role)
        VALUES (${username}, ${name}, ${passwordHash}, 'teacher')
        RETURNING id, username, display_name AS "displayName"
      `;
      return teacher;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") {
        throw new HttpError(409, "ชื่อผู้ใช้นี้ถูกใช้แล้ว");
      }
      throw error;
    }
  }, { body: t.Object({ username: t.String({ minLength: 3, maxLength: 40 }), displayName: t.String({ minLength: 1, maxLength: 120 }), password: t.String({ minLength: 12, maxLength: 200 }) }) })
  .patch("/:teacherId", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    await requireOwner(request);
    const updated = await sql.begin(async (tx) => {
      const [teacher] = await tx<{ id: string }[]>`
        UPDATE classroom.teachers SET active = ${body.active}
        WHERE id = ${params.teacherId} AND role = 'teacher' RETURNING id
      `;
      if (!teacher) return false;
      if (!body.active) await tx`DELETE FROM classroom.sessions WHERE teacher_id = ${params.teacherId}`;
      return true;
    });
    if (!updated) throw new HttpError(404, "ไม่พบบัญชีครูนี้");
    return { ok: true };
  }, { body: t.Object({ active: t.Boolean() }) })
  .post("/:teacherId/reset-password", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    await requireOwner(request);
    if (body.password.length < 12) throw new HttpError(422, "รหัสผ่านต้องมีอย่างน้อย 12 ตัวอักษร");
    const passwordHash = await Bun.password.hash(body.password, { algorithm: "argon2id" });
    const updated = await sql.begin(async (tx) => {
      const [teacher] = await tx<{ id: string }[]>`
        UPDATE classroom.teachers SET password_hash = ${passwordHash}
        WHERE id = ${params.teacherId} AND role = 'teacher' RETURNING id
      `;
      if (!teacher) return false;
      await tx`DELETE FROM classroom.sessions WHERE teacher_id = ${params.teacherId}`;
      return true;
    });
    if (!updated) throw new HttpError(404, "ไม่พบบัญชีครูนี้");
    return { ok: true };
  }, { body: t.Object({ password: t.String({ minLength: 12, maxLength: 200 }) }) });
