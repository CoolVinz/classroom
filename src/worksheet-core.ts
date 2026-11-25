import { HttpError } from "./http-error";

export type WorksheetQuestionType = "choice" | "boolean" | "blank";
export type WorksheetPrompt = { id: string; type: WorksheetQuestionType; prompt: string; choices: string[]; points: number };
export type WorksheetQuestion = WorksheetPrompt & { correctChoice: number | null; acceptedAnswers: string[] };
export type WorksheetAnswers = Record<string, string | number>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const answerKey = (value: string) => value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();

export function normalizeWorksheetQuestions(value: unknown, publishing: boolean): WorksheetQuestion[] {
  if (!Array.isArray(value) || value.length > 100 || publishing && !value.length) throw new HttpError(422, "ใบงานต้องมี 1–100 ข้อก่อนเผยแพร่");
  const ids = new Set<string>();
  return value.map((question, index) => {
    const fail = () => new HttpError(422, `ตรวจสอบคำถาม ข้อ ${index + 1} และคำตอบที่ถูกต้อง`);
    if (!record(question) || typeof question.id !== "string" || !uuid.test(question.id) || ids.has(question.id)) throw fail();
    const { id, type, prompt, points, correctChoice, choices, acceptedAnswers } = question;
    ids.add(id);
    if (type !== "choice" && type !== "boolean" && type !== "blank") throw fail();
    if (typeof prompt !== "string" || prompt.length > 4000 || publishing && !prompt.trim() ||
      typeof points !== "number" || !Number.isInteger(points) || points < 1 || points > 1000) throw fail();
    if (type === "blank") {
      if (!Array.isArray(acceptedAnswers) || acceptedAnswers.length > 20 ||
        acceptedAnswers.some((item) => typeof item !== "string" || item.length > 500)) throw fail();
      const accepted = acceptedAnswers.map((item: string) => item.trim()).filter(Boolean);
      if (publishing && !accepted.length) throw fail();
      return { id, type, prompt: prompt.trim(), points, choices: [], correctChoice: null, acceptedAnswers: accepted };
    }
    const options = type === "boolean" ? ["ถูก", "ผิด"] : choices;
    if (!Array.isArray(options) || options.length > 8 || options.some((item) => typeof item !== "string" || item.length > 500)) throw fail();
    const correct = typeof correctChoice === "number" && Number.isInteger(correctChoice) && correctChoice >= 0 && correctChoice < options.length ? correctChoice : null;
    if (publishing && (options.length < 2 || options.some((item: string) => !item.trim()) || correct === null)) throw fail();
    return { id, type, prompt: prompt.trim(), points, choices: options.map((item: string) => item.trim()), correctChoice: correct, acceptedAnswers: [] };
  });
}

export function worksheetPrompts(questions: WorksheetQuestion[]): WorksheetPrompt[] {
  return questions.map(({ id, type, prompt, choices, points }) => ({ id, type, prompt, choices, points }));
}

export function validateWorksheetAnswers(questions: WorksheetPrompt[], input: unknown): WorksheetAnswers {
  if (!record(input)) throw new HttpError(422, "รูปแบบคำตอบไม่ถูกต้อง");
  const byId = new Map(questions.map((question) => [question.id, question]));
  const answers: WorksheetAnswers = {};
  for (const [id, answer] of Object.entries(input)) {
    const question = byId.get(id);
    if (!question) throw new HttpError(422, "ไม่พบข้อคำถามนี้ในใบงาน");
    if (question.type === "blank" && typeof answer === "string" && answer.length <= 500) answers[id] = answer;
    else if (question.type !== "blank" && typeof answer === "number" && Number.isInteger(answer) && answer >= 0 && answer < question.choices.length) answers[id] = answer;
    else throw new HttpError(422, "คำตอบไม่ตรงกับชนิดของคำถาม");
  }
  return answers;
}

export function gradeWorksheet(questions: WorksheetQuestion[], answers: WorksheetAnswers): number {
  return questions.reduce((score, question) => {
    const answer = answers[question.id];
    const correct = question.type === "blank"
      ? typeof answer === "string" && question.acceptedAnswers.some((accepted) => answerKey(accepted) === answerKey(answer))
      : answer !== undefined && answer === question.correctChoice;
    return score + (correct ? question.points : 0);
  }, 0);
}
