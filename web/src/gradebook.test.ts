import { describe, expect, test } from "bun:test";
import { formatGradebookPoints, gradebookExportRows, gradebookTotalForStudent } from "./gradebook";

describe("gradebook totals", () => {
  const scores = [
    { studentId: "a", itemId: "assignment", score: 0, maxScore: 10 },
    { studentId: "a", itemId: "quiz", score: 8, maxScore: 10 },
    { studentId: "a", itemId: "manual", score: 7.5, maxScore: 10 },
    { studentId: "b", itemId: "quiz", score: 5, maxScore: 10 },
  ];

  test("adds only recorded, selected marks and counts an explicit zero", () => {
    expect(gradebookTotalForStudent("a", scores, new Set(["assignment", "quiz"]))).toEqual({
      earned: 8, possible: 20, percent: 40, scoredItems: 2,
    });
  });

  test("leaves an ungraded student blank and excludes unselected items", () => {
    expect(gradebookTotalForStudent("c", scores, new Set(["quiz"]))).toEqual({
      earned: 0, possible: 0, percent: null, scoredItems: 0,
    });
    expect(gradebookTotalForStudent("a", scores, new Set(["manual"]))).toMatchObject({ earned: 7.5, possible: 10, scoredItems: 1 });
  });

  test("formats fractional points without hiding decimals", () => {
    expect(formatGradebookPoints(7.5)).toBe("7.5");
    expect(formatGradebookPoints(10)).toBe("10");
  });

  test("exports Thai names and leading-zero school IDs with only selected items", () => {
    const rows = gradebookExportRows(
      [{ studentId: "a", studentCode: "00245", studentNumber: 1, displayName: "นักเรียน ตัวอย่าง" }],
      [{ id: "assignment", name: "งาน 1", maxScore: 20, kind: "assignment" }, { id: "quiz", name: "แบบฝึก", maxScore: 10, kind: "quiz" }],
      scores,
      new Set(["assignment"]),
    );
    expect(rows[0]).toEqual(["เลขที่", "รหัสนักเรียน", "ชื่อ-สกุล", "งาน 1", "รวมคะแนน", "ร้อยละ", "ให้คะแนนแล้ว"]);
    expect(rows[1]).toEqual([1, "00245", "นักเรียน ตัวอย่าง", "0 / 10", "0 / 10", 0, "1 รายการ"]);
  });
});
