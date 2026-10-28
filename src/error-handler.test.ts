import { expect, spyOn, test } from "bun:test";
import { Elysia, t } from "elysia";
import { HttpError } from "./http-error";
import { handleAppError } from "./error-handler";

test("API errors return safe JSON with their expected status", async () => {
  const routes = new Elysia()
    .get("/timetable", () => { throw new HttpError(422, "ช่วงวันที่ของตารางเรียนไม่ถูกต้อง (ไม่เกินหนึ่งปี)"); })
    .post("/validation", ({ body }) => body, { body: t.Object({ name: t.String() }) })
    .post("/parse", ({ body }) => body)
    .get("/unexpected", () => { throw new Error("database detail"); });
  const app = new Elysia().onError(handleAppError).use(routes);
  const internalLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    const timetable = await app.handle(new Request("http://localhost/timetable"));
    expect(timetable.status).toBe(422);
    expect(await timetable.json()).toEqual({ error: "ช่วงวันที่ของตารางเรียนไม่ถูกต้อง (ไม่เกินหนึ่งปี)" });

    const validation = await app.handle(new Request("http://localhost/validation", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }));
    expect(validation.status).toBe(422);
    expect(await validation.json()).toEqual({ error: "ข้อมูลที่ส่งไม่ถูกต้อง กรุณาตรวจสอบค่าที่กรอก" });

    const parse = await app.handle(new Request("http://localhost/parse", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    }));
    expect(parse.status).toBe(400);
    expect(await parse.json()).toEqual({ error: "ข้อมูลคำขอไม่ถูกต้อง" });

    const unexpected = await app.handle(new Request("http://localhost/unexpected"));
    expect(unexpected.status).toBe(500);
    expect(await unexpected.json()).toEqual({ error: "เกิดข้อผิดพลาดภายในระบบ กรุณาลองอีกครั้ง" });
    expect(internalLog).toHaveBeenCalledWith("Request failed:", "Error");
  } finally {
    internalLog.mockRestore();
  }
});
