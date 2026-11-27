import { randomBytes } from "node:crypto";
import { Elysia, t } from "elysia";
import type postgres from "postgres";
import { createStudentSession, hashToken, readSessionUser, requireOwner, sessionCookie } from "../auth/session";
import { revokeTestStudentAccess, revokeTestStudentSessions } from "../auth/test-students";
import { sql } from "../db/client";
import { HttpError } from "../http-error";
import { checkRequestOrigin, cleanText } from "../security";

const linkMinutes = 10;
const sessionSeconds = 2 * 60 * 60;
const uuid = t.String({ format: "uuid" });
const roomParams = t.Object({ classroomId: uuid });
const testerParams = t.Object({ classroomId: uuid, studentId: uuid });
const missingTester = () => new HttpError(404, "ไม่พบนักเรียนทดสอบในห้องนี้");
const invalidLink = () => new HttpError(410, "ลิงก์นี้หมดอายุหรือถูกใช้แล้ว ให้ผู้ดูแลสร้างลิงก์ใหม่");

async function lockTestRoom(db: postgres.ISql, classroomId: string, ownerId?: string) {
  const [room] = await db`SELECT c.id FROM classroom.classrooms c JOIN classroom.teachers t ON t.id = c.owner_id
    WHERE c.id = ${classroomId} AND c.is_test AND c.archived_at IS NULL AND t.active AND t.role = 'owner'
      AND (${ownerId ?? null}::uuid IS NULL OR t.id = ${ownerId ?? null})
    FOR SHARE OF c, t`;
  return room;
}

async function lockActiveTester(db: postgres.ISql, classroomId: string, studentId: string) {
  const [tester] = await db<{ accountId: string }[]>`SELECT s.account_id AS "accountId"
    FROM classroom.students s JOIN classroom.student_accounts a ON a.id = s.account_id AND a.test_classroom_id = s.classroom_id
    WHERE s.classroom_id = ${classroomId} AND s.id = ${studentId} AND s.archived_at IS NULL FOR UPDATE OF s`;
  return tester;
}

export const testStudentRoutes = new Elysia({ prefix: "/api" })
  .post("/classrooms/:classroomId/testers", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireOwner(request);
    const displayName = cleanText(body.displayName, 120);
    try {
      return await sql.begin(async (tx) => {
        if (!await lockTestRoom(tx, params.classroomId, actor.id)) throw missingTester();
        const [account] = await tx<{ id: string }[]>`INSERT INTO classroom.student_accounts (test_classroom_id)
          VALUES (${params.classroomId}) RETURNING id`;
        const [student] = await tx`INSERT INTO classroom.students (classroom_id, account_id, display_name, student_number)
          VALUES (${params.classroomId}, ${account.id}, ${displayName}, ${body.studentNumber ?? null}) RETURNING id`;
        return student;
      });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") {
        throw new HttpError(409, "เลขที่นักเรียนนี้มีอยู่ในห้องแล้ว");
      }
      throw error;
    }
  }, { params: roomParams, body: t.Object({
    displayName: t.String({ minLength: 1, maxLength: 120 }),
    studentNumber: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 2147483647 }))),
  }) })
  .post("/classrooms/:classroomId/testers/:studentId/link", async ({ params, request, set }) => {
    checkRequestOrigin(request);
    const actor = await requireOwner(request);
    return sql.begin(async (tx) => {
      if (!await lockTestRoom(tx, params.classroomId, actor.id)) throw missingTester();
      const tester = await lockActiveTester(tx, params.classroomId, params.studentId);
      if (!tester) throw missingTester();
      const token = randomBytes(32).toString("base64url");
      const [link] = await tx<{ expiresAt: Date }[]>`INSERT INTO classroom.test_student_links(account_id, token_hash, expires_at)
        VALUES (${tester.accountId}, ${hashToken(token)}, clock_timestamp() + ${linkMinutes} * INTERVAL '1 minute')
        ON CONFLICT (account_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at
        RETURNING expires_at AS "expiresAt"`;
      set.headers["cache-control"] = "no-store";
      return { path: "/tester#" + token, expiresAt: link.expiresAt };
    });
  }, { params: testerParams })
  .delete("/classrooms/:classroomId/testers/:studentId/access", async ({ params, request }) => {
    checkRequestOrigin(request);
    const actor = await requireOwner(request);
    return sql.begin(async (tx) => {
      if (!await lockTestRoom(tx, params.classroomId, actor.id)) throw missingTester();
      const tester = await lockActiveTester(tx, params.classroomId, params.studentId);
      if (!tester) throw missingTester();
      await revokeTestStudentAccess(tx, tester.accountId);
      return { ok: true };
    });
  }, { params: testerParams })
  .post("/auth/test-student/redeem", async ({ body, request, set }) => {
    checkRequestOrigin(request);
    set.headers["cache-control"] = "no-store";
    if (await readSessionUser(request)) throw new HttpError(409, "มีบัญชีเข้าสู่ระบบอยู่ กรุณาเปิดลิงก์ในหน้าต่างไม่ระบุตัวตนหรือออกจากระบบก่อน");
    const tokenHash = hashToken(body.token);
    const { token, classroomId } = await sql.begin(async (tx) => {
      const [candidate] = await tx<{ classroomId: string; studentId: string }[]>`
        SELECT a.test_classroom_id AS "classroomId", s.id AS "studentId"
        FROM classroom.test_student_links l JOIN classroom.student_accounts a ON a.id = l.account_id
        JOIN classroom.students s ON s.account_id = a.id AND s.classroom_id = a.test_classroom_id
        WHERE l.token_hash = ${tokenHash} AND l.expires_at > clock_timestamp()`;
      if (!candidate || !await lockTestRoom(tx, candidate.classroomId)) throw invalidLink();
      const tester = await lockActiveTester(tx, candidate.classroomId, candidate.studentId);
      if (!tester) throw invalidLink();
      const [link] = await tx`DELETE FROM classroom.test_student_links WHERE token_hash = ${tokenHash}
        AND account_id = ${tester.accountId} AND expires_at > clock_timestamp() RETURNING account_id`;
      if (!link) throw invalidLink();
      await revokeTestStudentSessions(tx, tester.accountId);
      const session = await createStudentSession(tester.accountId, tx, sessionSeconds);
      return { token: session, classroomId: candidate.classroomId };
    });
    set.headers["set-cookie"] = sessionCookie(token, false, sessionSeconds);
    return { path: `/classrooms/${classroomId}/join` };
  }, { body: t.Object({ token: t.String({ pattern: "^[A-Za-z0-9_-]{43}$" }) }) });
