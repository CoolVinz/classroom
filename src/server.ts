import { Elysia, file } from "elysia";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { sql } from "./db/client";
import { bootstrapDatabase } from "./db/bootstrap";
import { authRoutes } from "./routes/auth";
import { classroomRoutes } from "./routes/classrooms";
import { teacherRoutes } from "./routes/teachers";
import { HttpError } from "./http-error";
import { ensureUploadRoot, maxUploadBytes } from "./file-storage";
import { courseworkRoutes } from "./routes/coursework";

const port = Number(process.env.PORT ?? 3000);
const appUrl = process.env.APP_URL ?? "http://localhost:3000";
if (process.env.NODE_ENV === "production" && !appUrl.startsWith("https://")) {
  throw new Error("Set APP_URL to the HTTPS domain used by the production app.");
}

await bootstrapDatabase();
await ensureUploadRoot();
const webRoot = resolve(import.meta.dir, "../web/dist");
const indexFile = resolve(webRoot, "index.html");

const app = new Elysia({ serve: { maxRequestBodySize: maxUploadBytes() + 1024 * 1024 } })
  .get("/health/live", () => ({ ok: true }))
  .get("/health/ready", async () => {
    await sql.unsafe("SELECT 1");
    return { ok: true };
  })
  .use(authRoutes)
  .use(classroomRoutes)
  .use(courseworkRoutes)
  .use(teacherRoutes)
  .onError(({ error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return { error: error.message };
    }
    console.error("Request failed:", error instanceof Error ? error.name : "UnknownError");
    set.status = 500;
    return { error: "เกิดข้อผิดพลาดภายในระบบ กรุณาลองอีกครั้ง" };
  })
  .get("/", () => file(indexFile))
  .get("/assets/*", ({ request }) => {
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(request.url).pathname); }
    catch { return new Response("Not found", { status: 404 }); }
    const assetPath = resolve(webRoot, "." + pathname);
    if (!assetPath.startsWith(webRoot + sep) || !existsSync(assetPath)) return new Response("Not found", { status: 404 });
    return file(assetPath);
  })
  .get("/*", () => file(indexFile))
  .listen({ port, hostname: "0.0.0.0" });

console.log("Classroom server listening on " + app.server?.hostname + ":" + app.server?.port);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    app.stop();
    await sql.end({ timeout: 5 });
    process.exit(0);
  });
}
