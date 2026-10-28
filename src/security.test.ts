import { expect, test } from "bun:test";
import { validCalendarDateRange } from "./security";

test("timetable date ranges allow at most 365 calendar days, including leap years", () => {
  expect(validCalendarDateRange("2026-10-27", "2027-10-27", 365)).toBe(true);
  expect(validCalendarDateRange("2096-02-29", "2097-02-28", 365)).toBe(true);
  expect(validCalendarDateRange("2026-10-27", "2027-10-28", 365)).toBe(false);
  expect(validCalendarDateRange("2027-02-23", "2026-10-27", 365)).toBe(false);
  expect(validCalendarDateRange("2096-02-30", "2097-02-28", 365)).toBe(false);
});
