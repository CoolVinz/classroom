import { HttpError } from "./http-error";

const appUrl = process.env.APP_URL ?? "http://localhost:3000";
const expectedOrigin = new URL(appUrl).origin;

export function checkRequestOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  let originMatches = true;
  if (origin) {
    let requestOrigin = "";
    try { requestOrigin = new URL(origin).origin; } catch { originMatches = false; }
    originMatches = originMatches && (requestOrigin === expectedOrigin || (
      process.env.NODE_ENV !== "production" && requestOrigin === "http://localhost:5173"
    ));
  }
  if (!originMatches || fetchSite === "cross-site") {
    throw new HttpError(403, "คำขอนี้ไม่ได้รับอนุญาต");
  }
}

export function validCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function bangkokToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const part = (name: string) => parts.find((item) => item.type === name)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function cleanText(value: string, maxLength: number) {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maxLength) {
    throw new HttpError(422, "กรุณาตรวจสอบข้อมูลที่กรอก");
  }
  return normalized;
}

export function normalizeEmail(value: string | null | undefined) {
  const email = value?.trim().toLowerCase() ?? "";
  if (!email) return null;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(422, "อีเมลไม่ถูกต้อง");
  }
  return email;
}
