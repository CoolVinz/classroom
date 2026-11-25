import { expect, test } from "bun:test";
import { gradeWorksheet, normalizeWorksheetQuestions, validateWorksheetAnswers, worksheetPrompts } from "./worksheet-core";

const blankId = crypto.randomUUID(), choiceId = crypto.randomUUID(), booleanId = crypto.randomUUID();
const questions = [
  { id: blankId, type: "blank", prompt: "โปรแกรมที่ใช้สร้างโมเดล", points: 3, acceptedAnswers: ["Blender 3D", "เบลนเดอร์"] },
  { id: choiceId, type: "choice", prompt: "เลือกสี", points: 2, choices: ["แดง", "ฟ้า"], correctChoice: 1 },
  { id: booleanId, type: "boolean", prompt: "รูปสามเหลี่ยมมีสามด้าน", points: 1, correctChoice: 0 },
];

test("grades Thai and case/spacing variants while hiding answer keys", () => {
  const content = normalizeWorksheetQuestions(questions, true);
  const prompts = worksheetPrompts(content);
  expect(prompts[2].choices).toEqual(["ถูก", "ผิด"]);
  expect(prompts.every((question) => !("acceptedAnswers" in question) && !("correctChoice" in question))).toBe(true);
  const answers = validateWorksheetAnswers(prompts, { [blankId]: "\tBLENDER   3d ", [choiceId]: 1, [booleanId]: 0 });
  expect(gradeWorksheet(content, answers)).toBe(6);
  expect(gradeWorksheet(content, { [blankId]: " เบลนเดอร์ " })).toBe(3);
  expect(gradeWorksheet(content, { [choiceId]: 0 })).toBe(0);
});

test("permits incomplete drafts but rejects invalid published questions and student values", () => {
  expect(normalizeWorksheetQuestions([], false)).toEqual([]);
  expect(() => normalizeWorksheetQuestions([], true)).toThrow();
  expect(() => normalizeWorksheetQuestions([{ ...questions[0], acceptedAnswers: [" "] }], true)).toThrow();
  expect(() => normalizeWorksheetQuestions([{ ...questions[1], points: 0 }], true)).toThrow();
  expect(() => normalizeWorksheetQuestions([questions[1], questions[1]], true)).toThrow();
  const prompts = worksheetPrompts(normalizeWorksheetQuestions(questions, true));
  expect(() => validateWorksheetAnswers(prompts, { [blankId]: 1 })).toThrow();
  expect(() => validateWorksheetAnswers(prompts, { [choiceId]: 2 })).toThrow();
  expect(() => validateWorksheetAnswers(prompts, { extra: "answer" })).toThrow();
});
