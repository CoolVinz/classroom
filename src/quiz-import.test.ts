import { expect, test } from "bun:test";
import { exportQuizForAI, parseQuizImportText, quizAITemplate } from "./quiz-import";

const source = {
  format: "classroom-quiz", version: 1, title: "แบบทดสอบภาษาไทย", description: "คำชี้แจง",
  questions: [
    { type: "multiple-choice", prompt: "ข้อใดถูก", points: 3, choices: ["ตัวเลือก ก", "ตัวเลือก ข"], correctAnswer: 2, explanation: "เหตุผล" },
    { type: "true-false", prompt: "ข้อความถูก", points: 2, correctAnswer: true, explanation: "จริง" },
  ],
};

test("imports Thai multiple-choice and true-false content with new identifiers", () => {
  const result = parseQuizImportText(JSON.stringify(source));
  expect(result).toMatchObject({ title: source.title, content: { description: source.description, questions: [
    { type: "multiple-choice", points: 3, choices: [{ text: "ตัวเลือก ก" }, { text: "ตัวเลือก ข" }], explanation: "เหตุผล" },
    { type: "true-false", points: 2, choices: [{ text: "จริง" }, { text: "เท็จ" }], explanation: "จริง" },
  ] } });
  expect(result.content.questions[0].correctChoiceId).toBe(result.content.questions[0].choices[1].id);
  expect(result.content.questions[1].correctChoiceId).toBe(result.content.questions[1].choices[0].id);
  expect(result.content.questions[0].id).not.toBe(result.content.questions[1].id);
});

test("accepts a single JSON code fence and exports a quiz back to the AI format", () => {
  const imported = parseQuizImportText("```json\n" + JSON.stringify(source) + "\n```");
  const exported = exportQuizForAI(imported.title, imported.content);
  expect(exported).toMatchObject(source);
  expect(quizAITemplate).toContain("__REPLACE_WITH_TOPIC__");
});

test("rejects malformed, unsupported, incomplete, oversized, and image-bearing input with field paths", () => {
  expect(() => parseQuizImportText("{oops")).toThrow("Invalid JSON");
  expect(() => parseQuizImportText("```json\n" + JSON.stringify(source) + "\n``` trailing")).toThrow("code fence");
  expect(() => parseQuizImportText(JSON.stringify({ ...source, version: 2 }))).toThrow("Unsupported");
  expect(() => parseQuizImportText(JSON.stringify({ ...source, extra: true }))).toThrow("unknown field");
  expect(() => parseQuizImportText(JSON.stringify({ ...source, questions: [{ ...source.questions[0], correctAnswer: 0 }] }))).toThrow("questions[1].correctAnswer");
  expect(() => parseQuizImportText(JSON.stringify({ ...source, questions: [{ ...source.questions[0], imageId: "x" }] }))).toThrow("unknown field");
  expect(() => parseQuizImportText(" ".repeat(1_048_577))).toThrow("1 MiB");
});
