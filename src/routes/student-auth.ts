import { timingSafeEqual } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { Elysia } from "elysia";
import { createStudentSession, sessionCookie } from "../auth/session";
import { sql } from "../db/client";
import { HttpError } from "../http-error";
import { normalizeEmail } from "../security";

const google = new OAuth2Client();
const appUrl = process.env.APP_URL ?? "http://localhost:3000";
const clientId = () => process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
const workspaceDomain = () => (process.env.GOOGLE_WORKSPACE_DOMAIN?.trim() || "banjan.ac.th").toLowerCase();

function loginRedirect(reason: "config" | "signin" | "domain" | "roster") {
  const url = new URL("/", appUrl);
  url.searchParams.set("role", "student");
  url.searchParams.set("error", reason);
  return new Response(null, { status: 303, headers: { Location: url.href } });
}

function csrfMatches(request: Request, submitted: string) {
  const cookie = request.headers.get("cookie")?.split(";").map((item) => item.trim())
    .find((item) => item.startsWith("g_csrf_token="))?.slice("g_csrf_token=".length);
  if (!cookie || !submitted) return false;
  try {
    const cookieBytes = Buffer.from(decodeURIComponent(cookie));
    const submittedBytes = Buffer.from(submitted);
    return cookieBytes.length === submittedBytes.length && timingSafeEqual(cookieBytes, submittedBytes);
  } catch { return false; }
}

export const studentAuthRoutes = new Elysia({ prefix: "/api/auth/student" })
  .get("/config", () => ({
    enabled: Boolean(clientId()),
    clientId: clientId() || null,
    domain: workspaceDomain(),
    loginUri: new URL("/api/auth/student/google", appUrl).href,
  }))
  .post("/google", async ({ request }) => {
    const audience = clientId();
    if (!audience) return loginRedirect("config");
    if (Number(request.headers.get("content-length") ?? 0) > 32 * 1024) return loginRedirect("signin");
    const form = await request.formData().catch(() => null);
    if (!form || !csrfMatches(request, String(form.get("g_csrf_token") ?? ""))) return loginRedirect("signin");

    let payload;
    try {
      const ticket = await google.verifyIdToken({ idToken: String(form.get("credential") ?? ""), audience });
      payload = ticket.getPayload();
    } catch { return loginRedirect("signin"); }

    const domain = workspaceDomain();
    const email = normalizeEmail(payload?.email);
    const audiences = Array.isArray(payload?.aud) ? payload.aud : [payload?.aud];
    if (!payload?.sub || !email || payload.email_verified !== true || payload.hd?.toLowerCase() !== domain
      || !audiences.includes(audience)
      || !email.endsWith(`@${domain}`)
      || !["accounts.google.com", "https://accounts.google.com"].includes(payload.iss ?? "")
      || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return loginRedirect("domain");

    let signedIn: { id: string; email: string };
    try {
      signedIn = await sql.begin(async (tx) => {
        const lockKeys = [`email:${email}`, `google:${payload!.sub!}`].sort();
        for (const key of lockKeys) await tx`SELECT pg_advisory_xact_lock(hashtext(${key})::bigint)`;
        const [bySubject] = await tx<{ id: string; email: string; googleSubject: string | null }[]>`
          SELECT id, email, google_subject AS "googleSubject" FROM classroom.student_accounts
          WHERE google_subject = ${payload!.sub} FOR UPDATE
        `;
        const [byEmail] = await tx<{ id: string; email: string; googleSubject: string | null }[]>`
          SELECT id, email, google_subject AS "googleSubject" FROM classroom.student_accounts
          WHERE email = ${email} FOR UPDATE
        `;
        if (bySubject && byEmail && bySubject.id !== byEmail.id) throw new HttpError(409, "Google identity conflict");
        let account = bySubject ?? byEmail;
        if (account?.googleSubject && account.googleSubject !== payload!.sub) throw new HttpError(409, "Google identity conflict");
        const matches = await tx<{ id: string; accountId: string | null }[]>`
          SELECT s.id, s.account_id AS "accountId"
          FROM classroom.students s JOIN classroom.classrooms c ON c.id = s.classroom_id
          WHERE s.email = ${email} AND s.archived_at IS NULL AND c.archived_at IS NULL
          FOR UPDATE OF s
        `;
        if (matches.some((student) => student.accountId && student.accountId !== account?.id)) {
          throw new HttpError(409, "Google identity conflict");
        }
        if (!account && !matches.length) throw new HttpError(403, "No active roster match");
        if (!account) {
          [account] = await tx<{ id: string; email: string; googleSubject: string | null }[]>`
            INSERT INTO classroom.student_accounts (email, google_subject)
            VALUES (${email}, ${payload!.sub})
            RETURNING id, email, google_subject AS "googleSubject"
          `;
        } else {
          await tx`UPDATE classroom.student_accounts SET email = ${email}, google_subject = ${payload!.sub} WHERE id = ${account.id}`;
        }
        await tx`
          UPDATE classroom.students SET account_id = ${account.id}
          WHERE email = ${email} AND account_id IS NULL AND archived_at IS NULL
            AND classroom_id IN (SELECT id FROM classroom.classrooms WHERE archived_at IS NULL)
        `;
        const [membership] = await tx<{ displayName: string }[]>`
          SELECT s.display_name AS "displayName" FROM classroom.students s
          JOIN classroom.classrooms c ON c.id = s.classroom_id
          WHERE s.account_id = ${account.id} AND s.archived_at IS NULL AND c.archived_at IS NULL
          ORDER BY s.created_at LIMIT 1
        `;
        if (!membership) throw new HttpError(403, "No active roster match");
        return { id: account.id, email };
      });
    } catch (error) {
      if (error instanceof HttpError && (error.status === 403 || error.status === 409)) return loginRedirect("roster");
      throw error;
    }
    const token = await createStudentSession(signedIn.id);
    return new Response(null, {
      status: 303,
      headers: { Location: new URL("/", appUrl).href, "Set-Cookie": sessionCookie(token) },
    });
  })
  .post("/login", () => { throw new HttpError(410, "Student password login was retired. Use Google sign-in."); })
  .post("/invite/status", () => { throw new HttpError(410, "Student invitations were retired. Use Google sign-in."); })
  .post("/invite/accept", () => { throw new HttpError(410, "Student invitations were retired. Use Google sign-in."); })
  .post("/password-reset/request", () => { throw new HttpError(410, "Student password recovery was retired. Use Google sign-in."); })
  .post("/password-reset/confirm", () => { throw new HttpError(410, "Student password recovery was retired. Use Google sign-in."); });
