import { expect, test } from "bun:test";
import { aiImportTemplate, parseLessonPackImportText, parseWorksheetImportText } from "./lesson-pack-import";
import { gradeWorksheet } from "./worksheet-core";

function example(kind: "worksheet" | "pack" | "wio") {
  const prompt = aiImportTemplate(kind, "โมเดล 3 มิติ", "ม.3");
  return prompt.slice(prompt.lastIndexOf("\n\n{") + 2);
}

test("the worksheet prompt yields an importable Thai worksheet with all three scoring modes", () => {
  const template = aiImportTemplate("worksheet", "โมเดล 3 มิติ", "ม.3");
  expect(template).toContain("หัวข้อ: โมเดล 3 มิติ");
  expect(template).toContain("ระดับชั้น: ม.3");
  const worksheet = parseWorksheetImportText("```json\n" + example("worksheet") + "\n```");
  expect(worksheet.questions.map((question) => question.type)).toEqual(["choice", "boolean", "blank"]);
  const [choice, boolean, blank] = worksheet.questions;
  expect(gradeWorksheet(worksheet.questions, { [choice.id]: 0, [boolean.id]: 0, [blank.id]: " ย้าย " })).toBe(4);
  expect(gradeWorksheet(worksheet.questions, { [blank.id]: "MOVE" })).toBe(2);
  expect(parseWorksheetImportText(example("worksheet")).questions[0].id).not.toBe(choice.id);
});

test("invalid worksheet data reports its field and question index", () => {
  const sample = JSON.parse(example("worksheet"));
  const question = sample.questions[0];
  for (const [index, field, value, error] of [
    [0, "correctAnswer", 0, "questions[1].correctAnswer"],
    [0, "points", 0.5, "questions[1].points"],
    [0, "choices", ["one"], "questions[1].choices"],
    [0, "id", "invalid", "unknown field"],
    [1, "correctAnswer", "false", "questions[2].correctAnswer"],
    [2, "acceptedAnswers", ["   "], "acceptedAnswers[1]"],
    [2, "acceptedAnswers", ["\u0000"], "valid text"],
  ] as const) {
    const questions = sample.questions.map((item: Record<string, unknown>, i: number) => i === index ? { ...item, [field]: value } : item);
    expect(() => parseWorksheetImportText(JSON.stringify({ ...sample, questions }))).toThrow(error);
  }
  expect(() => parseWorksheetImportText(JSON.stringify({ ...sample, questions: Array(101).fill(question) }))).toThrow("1–100");
  expect(() => parseWorksheetImportText(JSON.stringify({ ...sample, version: 2 }))).toThrow("version");
  expect(() => parseWorksheetImportText("ผิด".repeat(120_000))).toThrow("1 MiB");
  expect(() => parseWorksheetImportText("{ malformed")).toThrow("Invalid JSON");
});

test("a lesson pack uses the matching quiz format and preserves lesson source for the sandbox", () => {
  const sample = JSON.parse(example("pack"));
  const html = "<h1>พื้นฐาน Blender</h1>\n<script>document.title = 'ตัวอย่าง';</script>\n";
  sample.lesson.html = html;
  sample.lesson.css = "\nmain { color: navy; }\n";
  sample.lesson.javascript = "\ndocument.title = 'บทเรียน';\n";
  const pack = parseLessonPackImportText(JSON.stringify(sample));
  expect(pack.lesson.code).toEqual({ type: "code", html, css: sample.lesson.css, javascript: sample.lesson.javascript, framework: "bootstrap", imageIds: [] });
  const question = pack.quiz?.content.questions[0];
  expect(question?.correctChoiceId).toEqual(expect.any(String));
  expect(question?.correctChoiceId).toBe(question?.choices[0].id);
  expect(pack.worksheet?.questions).toHaveLength(3);

  expect(() => parseLessonPackImportText(JSON.stringify({ ...sample, worksheet: {} }))).toThrow("worksheet: missing field");
  expect(() => parseLessonPackImportText(JSON.stringify({ ...sample, quiz: { ...sample.quiz, title: "" } }))).toThrow("quiz.title");
  expect(() => parseLessonPackImportText(JSON.stringify({ ...sample, lesson: { ...sample.lesson, framework: "tailwind" } }))).toThrow("lesson.framework");
  expect(() => parseLessonPackImportText(JSON.stringify({ ...sample, lesson: { ...sample.lesson, html: "<img src='lesson-image://bad'>" } }))).toThrow("uploaded lesson images");
  expect(() => parseLessonPackImportText(JSON.stringify({ ...sample, classroomId: "not accepted" }))).toThrow("unknown field");
});

test("imports a Wio lesson from the generated template with optional quiz and worksheet", () => {
  const sample = JSON.parse(example("wio"));
  const wio = parseLessonPackImportText("```json\n" + example("wio") + "\n```");
  expect(wio).toMatchObject({ quiz: null, worksheet: null, lab: { preset: "blink", maxScore: 10 } });
  const old = JSON.parse(example("pack"));
  const mixed = parseLessonPackImportText(JSON.stringify({ ...sample, quiz: old.quiz, worksheet: old.worksheet, lab: { ...sample.lab, maxScore: undefined } }));
  expect(mixed).toMatchObject({ lab: { maxScore: 100 }, quiz: { title: old.quiz.title }, worksheet: { title: old.worksheet.title } });
  expect(parseLessonPackImportText(JSON.stringify({ ...sample, quiz: old.quiz })).worksheet).toBeNull();
  expect(parseLessonPackImportText(JSON.stringify({ ...sample, worksheet: old.worksheet })).quiz).toBeNull();
});

test("rejects invalid Wio lab fields and unrelated classroom instructions in the paste", () => {
  const sample = JSON.parse(example("wio"));
  for (const [changes, error] of [
    [{ preset: "wifi" }, "lab.preset"],
    [{ instructions: 5 }, "lab.instructions"],
    [{ title: " " }, "lab.title"],
    [{ maxScore: 0 }, "lab.maxScore"],
    [{ maxScore: 120.005 }, "lab.maxScore"],
    [{ classroomId: "not-accepted" }, "unknown field"],
    [{ starter: "void setup() {}" }, "unknown field"],
  ] as const) {
    expect(() => parseLessonPackImportText(JSON.stringify({ ...sample, lab: { ...sample.lab, ...changes } }))).toThrow(error);
  }
  expect(() => parseLessonPackImportText(JSON.stringify({ ...sample, lab: null }))).toThrow("expected an object");
});
