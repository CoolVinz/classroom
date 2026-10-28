import type { ErrorHandler } from "elysia";
import { HttpError } from "./http-error";

export const handleAppError: ErrorHandler = ({ error, code, set }) => {
  if (error instanceof HttpError) {
    set.status = error.status;
    return { error: error.message };
  }
  if (code === "VALIDATION") {
    set.status = 422;
    return { error: "ข้อมูลที่ส่งไม่ถูกต้อง กรุณาตรวจสอบค่าที่กรอก" };
  }
  if (code === "PARSE") {
    set.status = 400;
    return { error: "ข้อมูลคำขอไม่ถูกต้อง" };
  }
  console.error("Request failed:", error instanceof Error ? error.name : "UnknownError");
  set.status = 500;
  return { error: "เกิดข้อผิดพลาดภายในระบบ กรุณาลองอีกครั้ง" };
}
