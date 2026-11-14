import { HttpError } from "./http-error";

export type QuizChoice = { id: string; text: string; imageId: string | null };
export type QuizQuestion = {
  id: string; type: "multiple-choice" | "true-false"; prompt: string; imageId: string | null;
  points: number; choices: QuizChoice[]; correctChoiceId: string | null; explanation: string;
};
export type QuizContent = { description: string; questions: QuizQuestion[] };
export type QuizAnswers = Record<string, string | null>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

export function normalizeQuizContent(value: unknown, publishing = false): QuizContent {
  if (!isRecord(value) || !Array.isArray(value.questions) || value.questions.length > 100) {
    throw new HttpError(422, "แบบทดสอบต้องมีคำถามไม่เกิน 100 ข้อ");
  }
  const description = typeof value.description === "string" ? value.description.trim() : "";
  if (description.length > 4000) throw new HttpError(422, "คำอธิบายแบบทดสอบยาวเกินกำหนด");
  const ids = new Set<string>();
  const questions = value.questions.map((raw): QuizQuestion => {
    if (!isRecord(raw) || !uuid.test(String(raw.id ?? "")) || ids.has(String(raw.id).toLowerCase())) {
      throw new HttpError(422, "รหัสคำถามไม่ถูกต้องหรือซ้ำกัน");
    }
    const id = String(raw.id).toLowerCase(); ids.add(id);
    if (raw.type !== "multiple-choice" && raw.type !== "true-false") throw new HttpError(422, "ชนิดคำถามไม่ถูกต้อง");
    const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
    const explanation = typeof raw.explanation === "string" ? raw.explanation.trim() : "";
    const imageId = nullableImage(raw.imageId);
    const points = raw.points;
    if (!Number.isSafeInteger(points) || Number(points) < 1 || Number(points) > 2147483647 || prompt.length > 4000 || explanation.length > 4000) {
      throw new HttpError(422, "คะแนนหรือข้อความคำถามไม่ถูกต้อง");
    }
    if (!Array.isArray(raw.choices) || raw.choices.length > 8) throw new HttpError(422, "ตัวเลือกต้องมีไม่เกิน 8 ข้อ");
    const choiceIds = new Set<string>();
    const choices = raw.choices.map((entry): QuizChoice => {
      if (!isRecord(entry) || !uuid.test(String(entry.id ?? ""))) throw new HttpError(422, "รหัสตัวเลือกไม่ถูกต้อง");
      const choiceId = String(entry.id).toLowerCase();
      if (choiceIds.has(choiceId)) throw new HttpError(422, "รหัสตัวเลือกซ้ำกัน");
      choiceIds.add(choiceId);
      const text = typeof entry.text === "string" ? entry.text.trim() : "";
      if (text.length > 1000) throw new HttpError(422, "ข้อความตัวเลือกยาวเกินกำหนด");
      return { id: choiceId, text, imageId: nullableImage(entry.imageId) };
    });
    const correctChoiceId = typeof raw.correctChoiceId === "string" && uuid.test(raw.correctChoiceId)
      ? raw.correctChoiceId.toLowerCase() : null;
    if (publishing && (prompt.length === 0 && !imageId || choices.length < 2
      || raw.type === "true-false" && choices.length !== 2
      || choices.some((choice) => !choice.text && !choice.imageId)
      || !correctChoiceId || !choiceIds.has(correctChoiceId))) {
      throw new HttpError(422, "เติมคำถาม ตัวเลือก และคำตอบที่ถูกต้องให้ครบก่อนเผยแพร่");
    }
    return { id, type: raw.type, prompt, imageId, points: Number(points), choices, correctChoiceId, explanation };
  });
  if (publishing && !questions.length) throw new HttpError(422, "เพิ่มคำถามอย่างน้อย 1 ข้อก่อนเผยแพร่");
  return { description, questions };
}

function nullableImage(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !uuid.test(value)) throw new HttpError(422, "รหัสภาพไม่ถูกต้อง");
  return value.toLowerCase();
}

export function validateAnswers(content: QuizContent, input: unknown): QuizAnswers {
  if (!isRecord(input)) throw new HttpError(422, "คำตอบไม่ถูกต้อง");
  const questions = new Map(content.questions.map((question) => [question.id, question]));
  const answers: QuizAnswers = {};
  for (const [questionId, choiceId] of Object.entries(input)) {
    const question = questions.get(questionId);
    if (!question || choiceId !== null && (typeof choiceId !== "string" || !question.choices.some((choice) => choice.id === choiceId))) {
      throw new HttpError(422, "พบคำตอบที่ไม่อยู่ในแบบทดสอบ");
    }
    answers[questionId] = choiceId as string | null;
  }
  return answers;
}

export function gradeQuiz(content: QuizContent, answers: QuizAnswers) {
  let score = 0;
  const details = content.questions.map((question) => {
    const selectedChoiceId = answers[question.id] ?? null;
    const isCorrect = Boolean(question.correctChoiceId && selectedChoiceId === question.correctChoiceId);
    const awardedPoints = isCorrect ? question.points : 0;
    score += awardedPoints;
    return { questionId: question.id, selectedChoiceId, correctChoiceId: question.correctChoiceId, isCorrect, awardedPoints, explanation: question.explanation };
  });
  return { score, details };
}

export function referencedQuizImages(content: QuizContent) {
  return [...new Set(content.questions.flatMap((question) => [question.imageId, ...question.choices.map((choice) => choice.imageId)]).filter((id): id is string => Boolean(id)))];
}

export function studentQuizQuestions(content: QuizContent, answers: QuizAnswers, showSolutions: boolean, grading?: ReturnType<typeof gradeQuiz>) {
  return content.questions.map((question) => {
    const base = {
      id: question.id, type: question.type, prompt: question.prompt, imageId: question.imageId,
      points: question.points, choices: question.choices,
      selectedChoiceId: answers[question.id] ?? null,
    };
    if (!showSolutions || !grading) return base;
    const result = grading.details.find((item) => item.questionId === question.id)!;
    return { ...base, correctChoiceId: result.correctChoiceId, isCorrect: result.isCorrect, awardedPoints: result.awardedPoints, explanation: question.explanation };
  });
}
