import { importFields, importObject, importString, readImportJson } from "./ai-import-json";

export type QuizImport = {
  format: "classroom-quiz";
  version: 1;
  title: string;
  description: string;
  questions: ({ type: "multiple-choice"; prompt: string; points: number; choices: string[]; correctAnswer: number | null; explanation: string }
    | { type: "true-false"; prompt: string; points: number; correctAnswer: boolean | null; explanation: string })[];
};

export function parseQuizImportText(source: string) {
  return parseQuizImport(readImportJson(source));
}

export function parseQuizImport(value: unknown, path = "root") {
  const raw = importObject(value, path);
  const prefix = path === "root" ? "" : path + ".";
  importFields(raw, ["format", "version", "title", "description", "questions"], path);
  if (raw.format !== "classroom-quiz" || raw.version !== 1) throw new Error(`${prefix}Unsupported quiz format or version`);
  const title = importString(raw.title, prefix + "title", 120);
  const description = importString(raw.description, prefix + "description", 4000);
  if (!title) throw new Error(`${prefix}title: cannot be blank`);
  if (!Array.isArray(raw.questions) || raw.questions.length < 1 || raw.questions.length > 100) throw new Error(`${prefix}questions: expected 1–100 questions`);
  const questions = raw.questions.map((value, index) => {
    const path = `${prefix}questions[${index + 1}]`;
    const item = importObject(value, path);
    if (item.type === "multiple-choice") {
      importFields(item, ["type", "prompt", "points", "choices", "correctAnswer", "explanation"], path);
      const prompt = importString(item.prompt, `${path}.prompt`, 4000);
      const explanation = importString(item.explanation, `${path}.explanation`, 4000);
      if (!prompt) throw new Error(`${path}.prompt: cannot be blank`);
      if (!Number.isSafeInteger(item.points) || Number(item.points) < 1 || Number(item.points) > 2147483647) throw new Error(`${path}.points: expected a positive integer`);
      if (!Array.isArray(item.choices) || item.choices.length < 2 || item.choices.length > 8) throw new Error(`${path}.choices: expected 2–8 options`);
      const choices = item.choices.map((choice, choiceIndex) => {
        const text = importString(choice, `${path}.choices[${choiceIndex + 1}]`, 1000);
        if (!text) throw new Error(`${path}.choices[${choiceIndex + 1}]: cannot be blank`);
        return text;
      });
      if (!Number.isInteger(item.correctAnswer) || Number(item.correctAnswer) < 1 || Number(item.correctAnswer) > choices.length) throw new Error(`${path}.correctAnswer: use a choice number from 1 to ${choices.length}`);
      return { type: "multiple-choice" as const, prompt, points: Number(item.points), choices, correctAnswer: Number(item.correctAnswer), explanation };
    }
    if (item.type === "true-false") {
      importFields(item, ["type", "prompt", "points", "correctAnswer", "explanation"], path);
      const prompt = importString(item.prompt, `${path}.prompt`, 4000);
      const explanation = importString(item.explanation, `${path}.explanation`, 4000);
      if (!prompt) throw new Error(`${path}.prompt: cannot be blank`);
      if (!Number.isSafeInteger(item.points) || Number(item.points) < 1 || Number(item.points) > 2147483647) throw new Error(`${path}.points: expected a positive integer`);
      if (typeof item.correctAnswer !== "boolean") throw new Error(`${path}.correctAnswer: use true or false`);
      return { type: "true-false" as const, prompt, points: Number(item.points), correctAnswer: item.correctAnswer, explanation };
    }
    throw new Error(`${path}.type: use "multiple-choice" or "true-false"`);
  });
  return {
    title,
    content: {
      description,
      questions: questions.map((question) => {
        const choices = question.type === "true-false" ? ["จริง", "เท็จ"] : question.choices;
        const ids = choices.map(() => crypto.randomUUID());
        const answerIndex = question.type === "true-false" ? (question.correctAnswer ? 0 : 1) : question.correctAnswer - 1;
        return {
          id: crypto.randomUUID(), type: question.type, prompt: question.prompt, imageId: null, points: question.points,
          choices: choices.map((text, index) => ({ id: ids[index], text, imageId: null })), correctChoiceId: ids[answerIndex], explanation: question.explanation,
        };
      }),
    },
  };
}

export function exportQuizForAI(title: string, content: { description: string; questions: { type: string; prompt: string; points: number; choices: { id: string; text: string; imageId: string | null }[]; correctChoiceId: string | null; explanation: string; imageId: string | null }[] }) {
  return {
    format: "classroom-quiz", version: 1, title, description: content.description,
    questions: content.questions.map((question) => {
      const correctIndex = question.choices.findIndex((choice) => choice.id === question.correctChoiceId);
      return {
        type: question.type, prompt: question.prompt, points: question.points,
        ...(question.type === "multiple-choice" ? {
          choices: question.choices.map((choice) => choice.text),
          correctAnswer: correctIndex < 0 ? null : correctIndex + 1,
        } : { correctAnswer: correctIndex < 0 ? null : correctIndex === 0 }),
        explanation: question.explanation,
      };
    }),
  };
}

export const quizImportExample = { format: "classroom-quiz", version: 1, title: "ตัวอย่างแบบทดสอบ", description: "เลือกคำตอบที่ถูกต้อง", questions: [{ type: "multiple-choice", prompt: "โปรแกรมใดใช้สร้างโมเดลสามมิติ?", points: 1, choices: ["Blender", "โปรแกรมตารางคำนวณ"], correctAnswer: 1, explanation: "Blender ใช้สร้างงานสามมิติ" }, { type: "true-false", prompt: "Blender ใช้สร้างโมเดลสามมิติได้", points: 1, correctAnswer: true, explanation: "เป็นโปรแกรมสร้างงานสามมิติ" }] } satisfies QuizImport;

export const quizAITemplate = `สร้างแบบทดสอบจากหัวข้อด้านล่าง แล้วตอบกลับเป็น JSON ที่ถูกต้องเท่านั้นตามรูปแบบตัวอย่าง ใช้ correctAnswer เป็นเลขลำดับเริ่มที่ 1 สำหรับปรนัย และใช้ true/false สำหรับถูกผิด สร้าง 1–100 ข้อ มีตัวเลือกข้อความ 2–8 ข้อ คะแนนเป็นจำนวนเต็มบวก และคำอธิบายเฉลยสั้น ๆ ห้ามใส่รูปภาพ รหัส Markdown หรือฟิลด์อื่น\n\nหัวข้อ: __REPLACE_WITH_TOPIC__\n\nตัวอย่างรูปแบบ:\n${JSON.stringify(quizImportExample, null, 2)}`;
