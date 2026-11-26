import { importFields, importObject, importString, maxAiImportBytes, readImportJson } from "./ai-import-json";
import { parseQuizImport, quizImportExample } from "./quiz-import";
import { normalizeWorksheetQuestions } from "./worksheet-core";
import { isWioLabId, validWioMaxScore, wioLabIds, wioLabs, wioSupportedCode, type WioLabSettings } from "./wio-labs";

export function parseWorksheetImportText(source: string) {
  return parseWorksheetImport(readImportJson(source), "worksheet");
}

function importTitle(value: unknown, path: string) {
  const title = importString(value, path, 120).replace(/\s+/g, " ");
  if (!title) throw new Error(`${path}: cannot be blank`);
  return title;
}

function answerTexts(value: unknown, path: string, minimum: number, maximum: number) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${path}: expected ${minimum}–${maximum} text entries`);
  }
  return value.map((answer, index) => {
    const field = `${path}[${index + 1}]`;
    const text = importString(answer, field, 500);
    if (!text) throw new Error(`${field}: cannot be blank`);
    return text;
  });
}

function parseWorksheetImport(value: unknown, path: string) {
  const raw = importObject(value, path);
  importFields(raw, ["format", "version", "title", "questions"], path);
  if (raw.format !== "classroom-worksheet" || raw.version !== 1) throw new Error(`${path}: unsupported worksheet format or version`);
  const title = importTitle(raw.title, `${path}.title`);
  if (!Array.isArray(raw.questions) || raw.questions.length < 1 || raw.questions.length > 100) {
    throw new Error(`${path}.questions: expected 1–100 questions`);
  }
  const questions = raw.questions.map((value, index) => {
    const at = `${path}.questions[${index + 1}]`;
    const item = importObject(value, at);
    const base = ["type", "prompt", "points"];
    const prompt = importString(item.prompt, `${at}.prompt`, 4000);
    if (!prompt) throw new Error(`${at}.prompt: cannot be blank`);
    const points = item.points;
    if (typeof points !== "number" || !Number.isInteger(points) || points < 1 || points > 1000) {
      throw new Error(`${at}.points: expected an integer from 1 to 1000`);
    }
    const question = { id: crypto.randomUUID(), prompt, points };
    if (item.type === "multiple-choice") {
      importFields(item, [...base, "choices", "correctAnswer"], at);
      const choices = answerTexts(item.choices, `${at}.choices`, 2, 8);
      const answer = item.correctAnswer;
      if (typeof answer !== "number" || !Number.isInteger(answer) || answer < 1 || answer > choices.length) {
        throw new Error(`${at}.correctAnswer: use a choice number from 1 to ${choices.length}`);
      }
      return { ...question, type: "choice", choices, correctChoice: answer - 1 };
    }
    if (item.type === "true-false") {
      importFields(item, [...base, "correctAnswer"], at);
      if (typeof item.correctAnswer !== "boolean") throw new Error(`${at}.correctAnswer: use true or false`);
      return { ...question, type: "boolean", correctChoice: item.correctAnswer ? 0 : 1 };
    }
    if (item.type === "fill-in-the-blank") {
      importFields(item, [...base, "acceptedAnswers"], at);
      return { ...question, type: "blank", acceptedAnswers: answerTexts(item.acceptedAnswers, `${at}.acceptedAnswers`, 1, 20) };
    }
    throw new Error(`${at}.type: use multiple-choice, true-false, or fill-in-the-blank`);
  });
  return { title, questions: normalizeWorksheetQuestions(questions, true) };
}

function parseLabImport(value: unknown): WioLabSettings {
  const lab = importObject(value, "lab");
  importFields(lab, ["preset", "title", "instructions"], "lab", ["maxScore"]);
  if (!isWioLabId(lab.preset)) throw new Error(`lab.preset: use ${wioLabIds.join(", ")}`);
  const maxScore = lab.maxScore === undefined ? 100 : lab.maxScore;
  if (!validWioMaxScore(maxScore)) throw new Error("lab.maxScore: use a positive score with at most two decimal places");
  const title = importTitle(lab.title, "lab.title");
  const instructions = importString(lab.instructions, "lab.instructions", 5000);
  return { preset: lab.preset, title, instructions, maxScore };
}

export function parseLessonPackImportText(source: string) {
  const raw = importObject(readImportJson(source), "root");
  if (Object.hasOwn(raw, "lab")) importFields(raw, ["format", "version", "lesson", "lab"], "root", ["quiz", "worksheet"]);
  else importFields(raw, ["format", "version", "lesson", "quiz", "worksheet"], "root");
  if (raw.format !== "classroom-lesson-pack" || raw.version !== 1) throw new Error("root: unsupported lesson pack format or version");

  const lesson = importObject(raw.lesson, "lesson");
  importFields(lesson, ["title", "html"], "lesson", ["css", "javascript", "framework"]);
  const title = importTitle(lesson.title, "lesson.title");
  const framework = lesson.framework === undefined ? "none" : lesson.framework;
  if (framework !== "none" && framework !== "bootstrap") throw new Error("lesson.framework: use none or bootstrap");
  const html = importString(lesson.html, "lesson.html", maxAiImportBytes, true);
  if (!html.trim()) throw new Error("lesson.html: cannot be blank");
  const css = lesson.css === undefined ? "" : importString(lesson.css, "lesson.css", maxAiImportBytes, true);
  const javascript = lesson.javascript === undefined ? "" : importString(lesson.javascript, "lesson.javascript", maxAiImportBytes, true);
  if ([html, css, javascript].some((text) => text.includes("lesson-image://"))) {
    throw new Error("lesson: add uploaded lesson images in the editor after import");
  }
  return {
    lesson: { title, code: { type: "code" as const, html, css, javascript, framework, imageIds: [] as string[] } },
    quiz: Object.hasOwn(raw, "quiz") ? parseQuizImport(raw.quiz, "quiz") : null,
    worksheet: Object.hasOwn(raw, "worksheet") ? parseWorksheetImport(raw.worksheet, "worksheet") : null,
    lab: Object.hasOwn(raw, "lab") ? parseLabImport(raw.lab) : null,
  };
}

const worksheetExample = {
  format: "classroom-worksheet", version: 1, title: "ใบงาน Blender",
  questions: [
    { type: "multiple-choice", prompt: "คำสั่งใดใช้หมุนวัตถุ?", points: 1, choices: ["Rotate", "Scale"], correctAnswer: 1 },
    { type: "true-false", prompt: "Scale ใช้เปลี่ยนขนาดวัตถุ", points: 1, correctAnswer: true },
    { type: "fill-in-the-blank", prompt: "คำสั่งใดใช้ย้ายวัตถุ?", points: 2, acceptedAnswers: ["Move", "ย้าย"] },
  ],
};

export function aiImportTemplate(kind: "worksheet" | "pack" | "wio", topic: string, grade: string) {
  const worksheetRules = "ใบงานใช้คำถามแบบเลือกตอบ ถูก/ผิด และเติมคำ ตามตัวอย่าง คะแนนเป็นจำนวนเต็ม 1–1000 ต่อข้อ ใช้ correctAnswer เป็นเลขตัวเลือกเริ่มที่ 1 สำหรับปรนัย และ true หรือ false สำหรับถูก/ผิด ข้อเติมคำใช้ acceptedAnswers เป็นรายการคำตอบสั้น ๆ ที่ยอมรับได้ ตัวเลือกปรนัยมี 2–8 ตัวเลือก ใบงานมี 1–100 ข้อ";
  const pack = {
    format: "classroom-lesson-pack", version: 1,
    lesson: { title: "พื้นฐาน Blender", html: '<!doctype html><html lang="th"><body><main class="container py-4"><h1>พื้นฐาน Blender</h1><p>เริ่มจากการย้าย หมุน และเปลี่ยนขนาดวัตถุ</p></main></body></html>', framework: "bootstrap" },
    quiz: quizImportExample, worksheet: worksheetExample,
  };
  const wioPack = {
    format: "classroom-lesson-pack", version: 1,
    lesson: { title: "ไฟ LED กะพริบด้วย Wio Terminal", html: '<h1>ไฟ LED กะพริบ</h1><p>ลองสลับไฟทุก 500 มิลลิวินาที</p>', framework: "bootstrap" },
    lab: { preset: "blink", title: wioLabs.blink.title, instructions: wioLabs.blink.instructions, maxScore: 10 },
  };
  const task = kind === "wio"
    ? `สร้างบทเรียนภาษาไทยพร้อมห้องปฏิบัติการ Wio Terminal ใช้ HTML ใน lesson.html และ framework เป็น bootstrap หรือ none เลือก lab.preset จากรายการนี้ แล้วเขียนคำชี้แจงให้ตรงกับการตรวจของ Classroom โปรแกรมจำลองมีโค้ดเริ่มต้นให้แล้ว ห้ามฝังตัวจำลองหรือเฉลยลงในบทเรียน maxScore เป็นคะแนนเต็มบวกที่มีทศนิยมไม่เกิน 2 ตำแหน่ง\n${wioLabIds.map((id) => `- ${id}: ${wioLabs[id].instructions}`).join("\n")}\n\nถ้าใส่ตัวอย่างโค้ด ให้ใส่ Arduino sketch ที่สมบูรณ์พร้อม setup() และ loop() ใน <pre><code> และแปลง &, <, > เป็น HTML entities เพื่อให้คัดลอกไปใช้ได้ ห้ามใส่ Arduino sketch ใน <script> ใช้เฉพาะคำสั่งในรายการนี้\n${wioSupportedCode.map(({ label, commands }) => `- ${label}: ${commands}`).join("\n")}`
    : kind === "pack"
    ? `สร้างชุดบทเรียนภาษาไทยที่มีบทเรียน แบบทดสอบ และใบงานในหัวข้อเดียวกัน บทเรียนใช้ HTML ฉบับเต็มใน html พร้อม Bootstrap ที่ Classroom โหลดให้อยู่แล้ว เพิ่ม CSS ใน css และ JavaScript ใน javascript ได้เมื่อจำเป็น ห้ามเรียก API หรือใช้ไฟล์ภายนอก เก็บเฉลยจริงไว้ใน quiz และ worksheet เท่านั้น ใช้แบบทดสอบ 1–100 ข้อ แบบ multiple-choice และ true-false ตามตัวอย่าง ใส่ explanation สั้น ๆ ให้ครบทุกข้อ ${worksheetRules}`
    : `สร้างใบงานภาษาไทย ${worksheetRules}`;
  return `${task}\n\nหัวข้อ: ${topic.trim() || "[ใส่หัวข้อ]"}\nระดับชั้น: ${grade.trim() || "[ใส่ระดับชั้น]"}\n\nตอบกลับเป็น JSON ที่ถูกต้องเท่านั้น ใช้ฟิลด์ตามตัวอย่าง ไม่ใส่ Markdown รหัสภายใน หรือข้อมูลรูปภาพ ชื่อแต่ละรายการยาวไม่เกิน 120 ตัวอักษร\n\n${JSON.stringify(kind === "wio" ? wioPack : kind === "pack" ? pack : worksheetExample, null, 2)}`;
}
