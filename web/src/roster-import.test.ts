import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { previewRoster, readRosterFile } from "./roster-import";

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
});
