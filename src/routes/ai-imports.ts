import { Elysia, t } from "elysia";
import type postgres from "postgres";
import { maxAiImportBytes } from "../ai-import-json";
import { requireActor } from "../auth/session";
import { sql } from "../db/client";
import { HttpError } from "../http-error";
import { parseLessonPackImportText, parseWorksheetImportText } from "../lesson-pack-import";
import { parseQuizImportText } from "../quiz-import";
import { checkRequestOrigin } from "../security";

const importBody = t.Object({ json: t.String({ maxLength: maxAiImportBytes }) });

function validated<T>(parse: (text: string) => T, text: string): T {
  try { return parse(text); }
  catch (error) { throw new HttpError(422, error instanceof Error ? error.message : "รูปแบบข้อมูลไม่ถูกต้อง"); }
}

async function insertQuiz(db: postgres.ISql, ownerId: string, { title, content }: ReturnType<typeof parseQuizImportText>) {
  const [quiz] = await db`INSERT INTO classroom.quizzes (owner_id, title, draft_content)
    VALUES (${ownerId}, ${title}, ${sql.json(content)})
    RETURNING id, title, draft_content AS content, draft_revision AS revision,
      published_title AS "publishedTitle", published_at AS "publishedAt"`;
  return quiz;
}

async function insertWorksheet(db: postgres.ISql, ownerId: string, { title, questions }: ReturnType<typeof parseWorksheetImportText>) {
  const [worksheet] = await db`INSERT INTO classroom.worksheets (owner_id, title, draft_questions)
    VALUES (${ownerId}, ${title}, ${sql.json(questions)}) RETURNING id`;
  return worksheet;
}

export const aiImportRoutes = new Elysia({ prefix: "/api" })
  .post("/quizzes/import", async ({ body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    return insertQuiz(sql, actor.id, validated(parseQuizImportText, body.json));
  }, { body: importBody })
  .post("/worksheets/import", async ({ body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    return insertWorksheet(sql, actor.id, validated(parseWorksheetImportText, body.json));
  }, { body: importBody })
  .post("/lesson-packs/import", async ({ body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const pack = validated(parseLessonPackImportText, body.json);
    return sql.begin(async (tx) => {
      const quiz = await insertQuiz(tx, actor.id, pack.quiz);
      const worksheet = await insertWorksheet(tx, actor.id, pack.worksheet);
      const links = [{ quizId: quiz.id, label: "ทำแบบทดสอบ" }];
      const [lesson] = await tx`INSERT INTO classroom.lesson_pages (owner_id, title, editor_mode, draft_blocks, draft_quiz_links)
        VALUES (${actor.id}, ${pack.lesson.title}, 'code', ${sql.json([pack.lesson.code])}, ${sql.json(links)})
        RETURNING id`;
      return { lessonId: lesson.id, quizId: quiz.id, worksheetId: worksheet.id };
    });
  }, { body: importBody });
