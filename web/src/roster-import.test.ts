import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { previewRoster, readPastedRoster, readRosterFile, suggestRosterColumns } from "./roster-import";

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

  test("reads copied Thai spreadsheet cells with blank columns, prefixes and leading zeroes", async () => {
    const sheet = await readPastedRoster([
      "\tลำดับ\tเลขประจำตัวนักเรียน\tคำนำหน้าชื่อ\tชื่อ\tนามสกุล\tหมายเหตุ",
      "\t1\t000123\tด.ช.\tผู้เรียน\tทดลอง\t",
      "\t2\t000124\t\tนักเรียนใหม่\tทดสอบ\t",
      "\t3\t000125\tด.ญ.\tนักเรียนเดิม\tตัวอย่าง\t",
      "",
    ].join("\r\n"));
    const columns = suggestRosterColumns(sheet.rows[0]);
    const result = previewRoster(sheet.rows, {
      code: columns.code, prefix: columns.prefix, firstName: columns.firstName, lastName: columns.lastName,
    }, new Set(["000125"]));
    expect(result.errors).toEqual([]);
    expect(result.add).toMatchObject([
      { studentCode: "000123", displayName: "ด.ช. ผู้เรียน ทดลอง", email: "000123@banjan.ac.th" },
      { studentCode: "000124", displayName: "นักเรียนใหม่ ทดสอบ", email: "000124@banjan.ac.th" },
    ]);
    expect(result.skipped).toMatchObject([{ studentCode: "000125" }]);
  });

  test("handles quoted and multiline pasted cells and keeps duplicate and missing-ID validation", async () => {
    const sheet = await readPastedRoster('ID\tName\n0001\t"ผู้เรียน, ทดสอบ"\n0002\t"ผู้เรียน\nตัวอย่าง"\n0003\tFirst\n0003\tDuplicate\n\tMissing ID\n');
    const result = previewRoster(sheet.rows, { code: 0, fullName: 1 }, new Set());
    expect(result.add.map(({ studentCode, displayName }) => [studentCode, displayName])).toEqual([
      ["0001", "ผู้เรียน, ทดสอบ"], ["0002", "ผู้เรียน ตัวอย่าง"],
    ]);
    expect(result.errors).toHaveLength(3);
  });

  test("rejects empty, oversized and non-tabular pasted data", async () => {
    await expect(readPastedRoster(" \n\t ")).rejects.toThrow("วางข้อมูลรายชื่อ");
    await expect(readPastedRoster("x".repeat(5 * 1024 * 1024 - 1) + "ก")).rejects.toThrow("5 MB");
    await expect(readPastedRoster("ID Name\n0001 Student")).rejects.toThrow("คัดลอกคอลัมน์");
  });

  test("applies the existing 1,000-student limit to pasted rows", async () => {
    const text = ["ID\tName", ...Array.from({ length: 1001 }, (_, index) => `${index}\tStudent ${index}`)].join("\n");
    const sheet = await readPastedRoster(text);
    const result = previewRoster(sheet.rows, { code: 0, fullName: 1 }, new Set());
    expect(result.add).toEqual([]);
    expect(result.errors).toMatchObject([{ message: "นำเข้าได้ไม่เกิน 1,000 คนต่อครั้ง" }]);
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
    expect(mapping).toEqual({ code: 1, studentNumber: 0, fullName: -1, firstName: 3, lastName: 4, prefix: 2, email: -1 });

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

  test("imports headerless pasted rows without dropping the first student", async () => {
    const sheet = await readPastedRoster([
      "1\t00024508\tด.ช.\tชื่อทดสอบ\tนามสกุลทดสอบ",
      "2\t00024509\t\tชื่อใหม่\tนามสกุลใหม่",
    ].join("\n"));
    const result = previewRoster(sheet.rows, { code: 1, studentNumber: 0, prefix: 2, firstName: 3, lastName: 4 }, new Set(), new Set(), new Map(), false);
    expect(result.errors).toEqual([]);
    expect(result.add.map(({ studentCode, studentNumber, displayName, email, row }) => [studentCode, studentNumber, displayName, email, row])).toEqual([
      ["00024508", 1, "ด.ช. ชื่อทดสอบ นามสกุลทดสอบ", "00024508@banjan.ac.th", 1],
      ["00024509", 2, "ชื่อใหม่ นามสกุลใหม่", "00024509@banjan.ac.th", 2],
    ]);
  });

  test("maps class number headers and reads UTF-8 CSV rows", async () => {
    const file = new File(["เลขที่,รหัสนักเรียน,คำนำหน้า,ชื่อ,นามสกุล\n1,0001,ด.ญ.,ชื่อทดสอบ,นามสกุลทดสอบ\n"], "roster.csv");
    const [sheet] = await readRosterFile(file);
    const columns = suggestRosterColumns(sheet.rows[0]);
    expect(columns).toMatchObject({ studentNumber: 0, code: 1, prefix: 2, firstName: 3, lastName: 4 });
    const preview = previewRoster(sheet.rows, { code: columns.code, studentNumber: columns.studentNumber, prefix: columns.prefix, firstName: columns.firstName, lastName: columns.lastName }, new Set());
    expect(preview.add).toMatchObject([{ studentNumber: 1, studentCode: "0001", displayName: "ด.ญ. ชื่อทดสอบ นามสกุลทดสอบ" }]);

    const headerless = ["3,0003,ด.ช.,ชื่อใหม่,นามสกุลใหม่\n"];
    const [csv] = await readRosterFile(new File(headerless, "headerless.csv"));
    const csvPreview = previewRoster(csv.rows, { studentNumber: 0, code: 1, prefix: 2, firstName: 3, lastName: 4 }, new Set(), new Set(), new Map(), false);
    expect(csvPreview.add).toMatchObject([{ row: 1, studentNumber: 3, studentCode: "0003", displayName: "ด.ช. ชื่อใหม่ นามสกุลใหม่" }]);

    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[4, "0004", "ด.ญ.", "ผู้เรียนใหม่", "ตัวอย่าง"]]), "No headers");
    const bytes = XLSX.write(book, { type: "array", bookType: "xlsx" });
    const [xlsx] = await readRosterFile(new File([bytes], "headerless.xlsx"));
    const xlsxPreview = previewRoster(xlsx.rows, { studentNumber: 0, code: 1, prefix: 2, firstName: 3, lastName: 4 }, new Set(), new Set(), new Map(), false);
    expect(xlsxPreview.add).toMatchObject([{ row: 1, studentNumber: 4, studentCode: "0004", displayName: "ด.ญ. ผู้เรียนใหม่ ตัวอย่าง" }]);
  });

  test("fills only missing numbers and detects occupied classroom numbers", () => {
    const result = previewRoster([
      ["No.", "ID", "Name"], ["4", "0001", "Changed name is ignored"], ["8", "0002", "Existing number is kept"], ["8", "0004", "Duplicate number"],
    ], { studentNumber: 0, code: 1, fullName: 2 }, new Set(["0001", "0002"]), new Set(), new Map([
      ["0001", { studentNumber: null }], ["0002", { studentNumber: 8 }], ["0003", { studentNumber: null, archived: true }],
    ]));
    expect(result.update).toEqual([{ studentCode: "0001", studentNumber: 4, row: 2 }]);
    expect(result.skipped).toMatchObject([{ studentCode: "0002" }]);
    expect(result.errors).toMatchObject([{ row: 4, message: "เลขที่ซ้ำในห้องเรียน" }]);
  });

  test("rejects duplicate numbers in new and fill-only rows", () => {
    const result = previewRoster([
      ["No.", "ID", "Name"], ["6", "0001", "Existing"], ["6", "0002", "New"],
    ], { studentNumber: 0, code: 1, fullName: 2 }, new Set(["0001"]), new Set(), new Map([["0001", { studentNumber: null }]]));
    expect(result.add).toEqual([]);
    expect(result.update).toEqual([]);
    expect(result.errors).toHaveLength(2);
  });
});
