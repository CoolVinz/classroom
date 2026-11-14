import { describe, expect, test } from "bun:test";
import { gradeQuiz, normalizeQuizContent, studentQuizQuestions, validateAnswers } from "./quiz-core";

const qid = "11111111-1111-4111-8111-111111111111";
const yes = "22222222-2222-4222-8222-222222222222";
const no = "33333333-3333-4333-8333-333333333333";
const content = normalizeQuizContent({ description: "", questions: [{ id: qid, type: "true-false", prompt: "true?", imageId: null, points: 2, choices: [{ id: yes, text: "จริง", imageId: null }, { id: no, text: "เท็จ", imageId: null }], correctChoiceId: yes, explanation: "เหตุผล" }] }, true);

describe("quiz content and scoring", () => {
  test("drafts may be incomplete but publish requires an answer key", () => {
    expect(() => normalizeQuizContent({ description: "", questions: [{ id: qid, type: "multiple-choice", prompt: "", imageId: null, points: 1, choices: [], correctChoiceId: null }] })).not.toThrow();
    expect(() => normalizeQuizContent({ description: "", questions: [] }, true)).toThrow();
  });

  test("grades correct, wrong, and blank responses without partial credit", () => {
    expect(gradeQuiz(content, { [qid]: yes }).score).toBe(2);
    expect(gradeQuiz(content, { [qid]: no }).score).toBe(0);
    expect(gradeQuiz(content, {}).score).toBe(0);
  });

  test("does not expose answer keys before release", () => {
    const answers = validateAnswers(content, { [qid]: yes });
    expect(JSON.stringify(studentQuizQuestions(content, answers, false))).not.toContain("correctChoiceId");
    expect(studentQuizQuestions(content, answers, true, gradeQuiz(content, answers))[0]).toMatchObject({ correctChoiceId: yes, isCorrect: true, awardedPoints: 2 });
  });
});
