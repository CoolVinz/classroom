import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { previewRoster, readRosterFile, suggestRosterColumns } from "./roster-import";

describe("student roster import", () => {
  test("keeps leading zeroes and skips existing student IDs", () => {
    const result = previewRoster([
      ["รหัส", "ชื่อ"],
      ["0012", "  สมใจ   ใจดี "],
      ["22", "ใหม่"],
    ], { code: 0, fullName: 1 }, new Set(["0012"]));
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ studentCode: "0012", displayName: "สมใจ ใจดี" });
    expect(result.add.map(({ studentCode, displayName }) => [studentCode, displayName])).toEqual([["22", "ใหม่"]]);
  });

  test("rejects missing and duplicated IDs in the source", () => {
    const result = previewRoster([
      ["ID", "Name"], ["4", "A"], ["4", "B"], ["", "C"], ["5", ""],
    ], { code: 0, fullName: 1 }, new Set());
    expect(result.add).toHaveLength(0);
    expect(result.errors).toHaveLength(4);
  });

  test("reads XLSX workbooks and reports sheets", async () => {
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([["ID", "Name"], ["0007", "Student"]]);
    XLSX.utils.book_append_sheet(book, sheet, "Roster");
    const fileBytes = XLSX.write(book, { type: "array", bookType: "xlsx" });
    const files = await readRosterFile(new File([fileBytes], "roster.xlsx"));
    expect(files[0].name).toBe("Roster");
    expect(previewRoster(files[0].rows, { code: 0, fullName: 1 }, new Set()).add[0].studentCode).toBe("0007");
  });

  test("a repeated import skips a student already in the roster", () => {
    const rows = [["รหัส", "ชื่อ"], ["0008", "นักเรียนไทย"]];
    expect(previewRoster(rows, { code: 0, fullName: 1 }, new Set()).add).toHaveLength(1);
    expect(previewRoster(rows, { code: 0, fullName: 1 }, new Set(["0008"])).skipped[0]).toMatchObject({ studentCode: "0008", displayName: "นักเรียนไทย" });
  });

  test("maps optional email for new students without changing existing IDs", () => {
    const result = previewRoster([
      ["ID", "Name", "Email"],
      ["0009", "New Student", "NEW@SCHOOL.EDU"],
      ["0010", "Existing Student", "changed@school.edu"],
    ], { code: 0, fullName: 1, email: 2 }, new Set(["0010"]));
    expect(result.add).toMatchObject([{ studentCode: "0009", email: "new@school.edu" }]);
    expect(result.skipped).toMatchObject([{ studentCode: "0010" }]);
    expect(result.skipped[0]).not.toHaveProperty("email");
  });

  test("generates school emails from numeric IDs and preserves explicit emails and leading zeroes", () => {
    const result = previewRoster([
      ["ID", "Name", "Email"], ["0024514", "Student One", ""], ["24515", "Student Two", "custom@school.edu"], ["AB15", "Student Three", ""],
    ], { code: 0, fullName: 1, email: 2 }, new Set());
    expect(result.add.map(({ studentCode, email }) => [studentCode, email])).toEqual([
      ["0024514", "0024514@banjan.ac.th"], ["24515", "custom@school.edu"], ["AB15", undefined],
    ]);
  });

  test("suggests Thai ID and prefix columns and joins a nonblank prefix with split names", () => {
    const headers = ["ลำดับ", "เลขประจำตัวนักเรียน", "คำนำหน้าชื่อ", "ชื่อ", "นามสกุล", "หมายเหตุ"];
    const mapping = suggestRosterColumns(headers);
    expect(mapping).toEqual({ code: 1, fullName: -1, firstName: 3, lastName: 4, prefix: 2, email: -1 });

    const result = previewRoster([
      headers,
      ["1", "001234", "ด.ช.", "สมชาย", "ใจดี", ""],
      ["2", "001235", "", "ผู้เรียนใหม่", "ทดสอบ", ""],
    ], {
      code: mapping.code,
      prefix: mapping.prefix,
      firstName: mapping.firstName,
      lastName: mapping.lastName,
    }, new Set());

    expect(result.add.map(({ studentCode, displayName, email }) => [studentCode, displayName, email])).toEqual([
      ["001234", "ด.ช. สมชาย ใจดี", "001234@banjan.ac.th"],
      ["001235", "ผู้เรียนใหม่ ทดสอบ", "001235@banjan.ac.th"],
    ]);
  });

  test("rejects invalid and duplicate emails for new roster rows", () => {
    const result = previewRoster([
      ["ID", "Name", "Email"],
      ["1", "Invalid", "not-an-email"],
      ["2", "First", "same@school.edu"],
      ["3", "Second", "SAME@school.edu"],
      ["4", "Already in class", "used@school.edu"],
    ], { code: 0, fullName: 1, email: 2 }, new Set(), new Set(["used@school.edu"]));
    expect(result.add).toHaveLength(0);
    expect(result.errors).toHaveLength(4);
  });
});
