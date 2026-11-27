import { createHash, randomBytes } from "node:crypto";
import { Elysia, t } from "elysia";
import type postgres from "postgres";
import { readSessionUser, requireActor, requireStudent } from "../auth/session";
import { sql } from "../db/client";
import { storedFilePath } from "../file-storage";
import { HttpError } from "../http-error";
import { termKey, wordCloud, type ActivityKind, type PollSnapshot } from "../live-activity-content";
import { gradeQuiz, referencedQuizImages, studentQuizQuestions, type QuizAnswers, type QuizContent } from "../quiz-core";
import { checkRequestOrigin, cleanText } from "../security";

type Phase = "lobby" | "answering" | "revealed" | "discussion" | "finished" | "cancelled";
type Activity = {
  id: string; classroomId: string; classroomName: string; quizId: string | null; ownerId: string;
  title: string; kind: ActivityKind; phase: Phase; questionIndex: number; questionSeconds: number;
  revision: number; deadline: Date | null; prompt: string | null; recap: string | null;
  includeInGradebook: boolean; content: QuizContent | null; serverNow: number;
  poll: PollSnapshot | null; pollCounts: number[] | null;
};
type Viewer = { activity: Activity; teacher: boolean; studentId: string | null; accountId: string };
type Pick = { studentId: string; questionIndex: number; choiceIndex: number | null };
type Idea = { id: string; text: string; approved: boolean; mine: boolean | null; author: string | null };
const uuid = t.String({ format: "uuid" });
const idParams = t.Object({ id: uuid });
const classParams = t.Object({ classroomId: uuid });
const ended = (phase: Phase) => phase === "finished" || phase === "cancelled";
const unavailable = () => new HttpError(404, "ไม่พบกิจกรรมสดนี้");
const conflict = () => new HttpError(409, "สถานะกิจกรรมเปลี่ยนไปแล้ว กรุณาลองอีกครั้ง");

async function ownedClassroom(classroomId: string, ownerId: string, db: postgres.ISql = sql) {
  const [room] = await db`SELECT id FROM classroom.classrooms WHERE id = ${classroomId}
    AND owner_id = ${ownerId} AND archived_at IS NULL FOR SHARE`;
  if (!room) throw unavailable();
}

async function getViewer(request: Request, id: string, db: postgres.ISql = sql, lock = false): Promise<Viewer> {
  const actor = await readSessionUser(request, db);
  if (!actor) throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
  const [activity] = await db<Activity[]>`SELECT l.id, l.classroom_id AS "classroomId", c.name AS "classroomName",
      c.owner_id AS "ownerId", l.quiz_id AS "quizId", l.title, l.kind, l.phase, l.question_index AS "questionIndex",
      l.question_seconds AS "questionSeconds", l.deadline, l.prompt, l.recap, l.revision,
      l.include_in_gradebook AS "includeInGradebook", l.content_snapshot AS content,
      l.poll_snapshot AS poll, l.poll_counts AS "pollCounts",
      (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS "serverNow"
    FROM classroom.live_activities l JOIN classroom.classrooms c ON c.id=l.classroom_id AND c.archived_at IS NULL
    LEFT JOIN classroom.quizzes q ON q.id=l.quiz_id
    WHERE l.id=${id} AND q.trashed_at IS NULL
    ${lock ? db`FOR UPDATE OF l` : db``}`;
  if (!activity) throw unavailable();
  if (actor.role !== "student") {
    if (activity.ownerId !== actor.id) throw unavailable();
    return { activity, teacher: true, studentId: null, accountId: actor.id };
  }
  const [student] = await db<{ id: string }[]>`SELECT id FROM classroom.students WHERE classroom_id=${activity.classroomId}
    AND account_id=${actor.id} AND archived_at IS NULL ${lock ? db`FOR SHARE` : db``}`;
  if (!student) throw unavailable();
  return { activity, teacher: false, studentId: student.id, accountId: actor.id };
}

async function closePoll(activity: Activity, poll: PollSnapshot, db: postgres.ISql, expiredOnly = false) {
  const picks = await db<{ index: number; count: number }[]>`SELECT choice_index AS index, COUNT(*)::int AS count
    FROM classroom.live_activity_choices WHERE activity_id=${activity.id} AND question_index=0
      AND choice_index IS NOT NULL GROUP BY choice_index`;
  const counts = poll.choices.map((_, index) => picks.find((pick) => pick.index === index)?.count ?? 0);
  const [closed] = await db<{ revision: number }[]>`UPDATE classroom.live_activities
    SET phase='finished', deadline=NULL, poll_counts=${counts}::integer[], revision=revision+1
    WHERE id=${activity.id} AND phase='answering' AND revision=${activity.revision}
      AND (NOT ${expiredOnly} OR deadline <= clock_timestamp()) RETURNING revision`;
  if (closed) Object.assign(activity, { phase: "finished", deadline: null, revision: closed.revision, pollCounts: counts });
}

async function expireQuestion(viewer: Viewer, db: postgres.ISql) {
  const { activity } = viewer;
  if (activity.phase !== "answering") return;
  if (activity.poll) return closePoll(activity, activity.poll, db, true);
  const [expired] = await db<{ revision: number }[]>`UPDATE classroom.live_activities
    SET phase='revealed', deadline=NULL, revision=revision+1
    WHERE id=${activity.id} AND phase='answering' AND revision=${activity.revision}
      AND deadline <= clock_timestamp() RETURNING revision`;
  if (expired) {
    activity.phase = "revealed";
    activity.revision = expired.revision;
    activity.deadline = null;
  }
}

function answersFor(content: QuizContent, picks: Pick[]): QuizAnswers {
  return Object.fromEntries(picks.map(({ questionIndex, choiceIndex }) => {
    const question = content.questions[questionIndex];
    return [question.id, choiceIndex === null ? null : question.choices[choiceIndex]?.id ?? null];
  }));
}

async function activityView({ activity: { content, poll, pollCounts, ownerId: _owner, quizId: _quiz, ...activity }, teacher, studentId }: Viewer) {
  const { id, phase, questionIndex } = activity;
  const [picks, ideas, joined, turnout] = await Promise.all([
    (poll || content && questionIndex >= 0) ? sql<Pick[]>`SELECT student_id AS "studentId", question_index AS "questionIndex", choice_index AS "choiceIndex"
      FROM classroom.live_activity_choices WHERE activity_id=${id}
        AND (student_id=${studentId} OR (${!!content} AND (${teacher} OR (question_index=${questionIndex} AND ${phase === "revealed"}))))` : [],
    (activity.kind === "discussion" || activity.kind === "word-cloud") ? sql<Idea[]>`SELECT i.id, i.text, i.approved, i.student_id=${studentId} AS "mine",
        CASE WHEN ${teacher} THEN s.display_name END AS "author"
      FROM classroom.live_activity_ideas i JOIN classroom.students s ON s.id=i.student_id
      WHERE i.activity_id=${id} AND (${teacher} OR i.approved OR i.student_id=${studentId})
      ORDER BY i.created_at, i.id` : [],
    studentId ? sql`SELECT student_id FROM classroom.live_activity_participants WHERE activity_id=${id} AND student_id=${studentId}` : [],
    poll && teacher && phase === "answering" ? sql<{ count: number }[]>`SELECT COUNT(*)::int AS count
      FROM classroom.live_activity_choices WHERE activity_id=${id} AND question_index=0 AND choice_index IS NOT NULL` : [],
  ]);
  const question = content?.questions[questionIndex];
  const selected = picks.find((pick) => pick.studentId === studentId && pick.questionIndex === (poll ? 0 : questionIndex))?.choiceIndex ?? null;
  const ownLockedPicks = picks.filter((pick) => pick.studentId === studentId
    && (pick.questionIndex < questionIndex || (phase === "revealed" || phase === "finished") && pick.questionIndex === questionIndex));
  const score = content && studentId && joined.length && phase !== "cancelled"
    ? gradeQuiz(content, answersFor(content, ownLockedPicks)).score : null;
  const remainingQuestion = question && !ended(phase);
  return {
    ...activity, teacher, joined: Boolean(joined.length), selected,
    poll: poll && phase !== "lobby" && phase !== "cancelled" ? { ...poll, counts: pollCounts, voted: turnout[0]?.count ?? null } : null,
    terms: activity.kind === "word-cloud" ? wordCloud(ideas) : [],
    questionCount: content?.questions.length ?? 0,
    maxScore: content?.questions.reduce((total, item) => total + item.points, 0) ?? 0, score, ideas,
    question: remainingQuestion ? studentQuizQuestions({ description: "", questions: [question] }, {}, false)[0] : null,
    reveal: remainingQuestion && phase === "revealed" ? {
      correctChoiceId: question.correctChoiceId, explanation: question.explanation,
      counts: question.choices.map((_choice, index) => picks.filter((pick) => pick.questionIndex === questionIndex && pick.choiceIndex === index).length),
    } : null,
  };
}

export const liveActivityRoutes = new Elysia({ prefix: "/api" })
  .get("/classrooms/:classroomId/live-activities", async ({ params, request }) => {
    const actor = await requireActor(request);
    await ownedClassroom(params.classroomId, actor.id);
    const [activities, quizzes, lessons] = await Promise.all([
      sql`SELECT l.id, l.title, l.kind, l.phase, l.created_at AS "createdAt", l.include_in_gradebook AS "includeInGradebook"
        FROM classroom.live_activities l LEFT JOIN classroom.quizzes q ON q.id=l.quiz_id
        WHERE l.classroom_id=${params.classroomId} AND q.trashed_at IS NULL ORDER BY l.created_at DESC LIMIT 100`,
      sql`SELECT id, published_title AS title FROM classroom.quizzes WHERE owner_id=${actor.id}
        AND published_at IS NOT NULL AND trashed_at IS NULL ORDER BY published_title`,
      sql`SELECT p.id, p.published_title AS title FROM classroom.classroom_lessons c
        JOIN classroom.lesson_pages p ON p.id=c.lesson_id
        WHERE c.classroom_id=${params.classroomId} AND p.owner_id=${actor.id} AND p.published_at IS NOT NULL AND p.trashed_at IS NULL
        ORDER BY p.published_title`,
    ]);
    return { activities, quizzes, lessons };
  }, { params: classParams })
  .post("/classrooms/:classroomId/live-activities", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    const actor = await requireActor(request);
    const classroomId = params.classroomId;
    return sql.begin(async (tx) => {
      let quiz: { title: string; content: QuizContent } | undefined;
      if (body.kind === "quiz") {
        if (!body.quizId) throw new HttpError(422, "เลือกแบบทดสอบที่เผยแพร่แล้ว");
        [quiz] = await tx<{ title: string; content: QuizContent }[]>`SELECT published_title AS title, published_content AS content
          FROM classroom.quizzes WHERE id=${body.quizId} AND owner_id=${actor.id}
          AND published_content IS NOT NULL AND trashed_at IS NULL FOR SHARE`;
        if (!quiz) throw new HttpError(422, "ไม่พบแบบทดสอบที่พร้อมเปิด");
      }
      if (body.lessonId) {
        const [lesson] = await tx`SELECT p.id FROM classroom.lesson_pages p JOIN classroom.classroom_lessons c ON c.lesson_id=p.id
          WHERE p.id=${body.lessonId} AND c.classroom_id=${classroomId} AND p.owner_id=${actor.id}
            AND p.published_at IS NOT NULL AND p.trashed_at IS NULL FOR SHARE OF p,c`;
        if (!lesson) throw new HttpError(422, "เลือกบทเรียนที่มอบหมายในห้องนี้");
      }
      await ownedClassroom(classroomId, actor.id, tx);
      const title = cleanText(body.title?.trim() || quiz?.title || "", 120);
      const prompt = body.kind !== "quiz" ? cleanText(body.prompt ?? "", 1000) : null;
      let poll: PollSnapshot | null = null;
      if (body.kind === "poll") {
        const choices = body.pollChoices?.map((choice) => cleanText(choice, 120));
        if (!choices || new Set(choices.map(termKey)).size !== choices.length) {
          throw new HttpError(422, "ระบุตัวเลือกที่แตกต่างกัน 2–8 ข้อ");
        }
        poll = { mode: body.pollMode ?? "private", choices };
      }
      const [activity] = await tx`INSERT INTO classroom.live_activities
        (classroom_id, quiz_id, lesson_id, title, kind, content_snapshot, prompt, question_seconds, poll_snapshot)
        VALUES (${classroomId}, ${quiz ? body.quizId! : null}, ${body.lessonId ?? null}, ${title}, ${body.kind},
          ${quiz ? tx.json(quiz.content) : null}, ${prompt}, ${body.questionSeconds ?? 30}, ${poll ? tx.json(poll) : null})
        ON CONFLICT (classroom_id) WHERE phase NOT IN ('finished','cancelled') DO NOTHING RETURNING id`;
      if (!activity) throw new HttpError(409, "ห้องเรียนนี้มีกิจกรรมสดอยู่แล้ว");
      return activity;
    });
  }, { params: classParams, body: t.Object({
    kind: t.Union([t.Literal("quiz"), t.Literal("discussion"), t.Literal("poll"), t.Literal("word-cloud")]), title: t.Optional(t.String({ maxLength: 120 })),
    quizId: t.Optional(uuid), lessonId: t.Optional(uuid), prompt: t.Optional(t.String({ maxLength: 1000 })),
    questionSeconds: t.Optional(t.Integer({ minimum: 10, maximum: 120 })),
    pollMode: t.Optional(t.Union([t.Literal("private"), t.Literal("walk")])),
    pollChoices: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 120 }), { minItems: 2, maxItems: 8 })),
  }) })
  .get("/student/live-activities", async ({ request, query }) => {
    const actor = await requireStudent(request);
    return sql`SELECT l.id, l.title, l.kind, l.phase, l.classroom_id AS "classroomId", c.name AS "classroomName"
      FROM classroom.live_activities l JOIN classroom.classrooms c ON c.id=l.classroom_id AND c.archived_at IS NULL
      JOIN classroom.students s ON s.classroom_id=c.id AND s.archived_at IS NULL AND s.account_id=${actor.id}
      LEFT JOIN classroom.quizzes q ON q.id=l.quiz_id
      WHERE q.trashed_at IS NULL AND l.phase <> 'cancelled'
        AND (l.phase <> 'finished' OR l.kind<>'quiz' OR EXISTS (
          SELECT 1 FROM classroom.live_activity_participants p WHERE p.activity_id=l.id AND p.student_id=s.id))
        AND (${query.classroomId ?? null}::uuid IS NULL OR l.classroom_id=${query.classroomId ?? null})
        AND (${query.lessonId ?? null}::uuid IS NULL OR (l.lesson_id=${query.lessonId ?? null} AND EXISTS (
          SELECT 1 FROM classroom.classroom_lessons a JOIN classroom.lesson_pages p ON p.id=a.lesson_id
          WHERE a.lesson_id=l.lesson_id AND a.classroom_id=l.classroom_id AND p.published_at IS NOT NULL AND p.trashed_at IS NULL)))
      ORDER BY (l.phase='finished'), l.created_at DESC LIMIT 50`;
  }, { query: t.Object({ classroomId: t.Optional(uuid), lessonId: t.Optional(uuid) }) })
  .get("/live-activities/:id", async ({ params, request, set }) => {
    set.headers["cache-control"] = "no-store";
    let viewer = await getViewer(request, params.id);
    if (viewer.activity.deadline && viewer.activity.deadline.getTime() <= viewer.activity.serverNow) {
      viewer = await sql.begin(async (tx) => {
        const current = await getViewer(request, params.id, tx, true);
        await expireQuestion(current, tx);
        return current;
      });
    }
    return activityView(viewer);
  }, { params: idParams })
  .post("/live-activities/:id/ticket", async ({ params, request }) => {
    checkRequestOrigin(request);
    const { activity, teacher, accountId } = await getViewer(request, params.id);
    if (ended(activity.phase)) throw conflict();
    const url = process.env.GALLERY_WS_URL;
    if (!url) throw new HttpError(503, "ยังไม่ได้ตั้งค่าบริการกิจกรรมสด");
    const sessionToken = request.headers.get("cookie")?.split(";").map((item) => item.trim())
      .find((item) => item.startsWith("classroom_session="))?.slice("classroom_session=".length);
    if (!sessionToken) throw new HttpError(401, "กรุณาเข้าสู่ระบบอีกครั้ง");
    const token = randomBytes(32).toString("base64url");
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    await sql`DELETE FROM classroom.live_activity_tickets WHERE expires_at < NOW()`;
    await sql`INSERT INTO classroom.live_activity_tickets (token_hash, activity_id, account_id, session_hash, actor_kind, expires_at)
      VALUES (${hash(token)}, ${activity.id}, ${accountId}, ${hash(sessionToken)}, ${teacher ? "teacher" : "student"}, NOW() + INTERVAL '60 seconds')`;
    return { ticket: token, url };
  }, { params: idParams })
  .post("/live-activities/:id/command", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    await requireActor(request);
    return sql.begin(async (tx) => {
      const viewer = await getViewer(request, params.id, tx, true);
      if (!viewer.teacher) throw unavailable();
      const { activity } = viewer;
      if (activity.revision !== body.revision || ended(activity.phase)) throw conflict();
      const { id, phase, content, questionIndex } = activity;
      if (body.action === "cancel") {
        await tx`UPDATE classroom.live_activities SET phase='cancelled', deadline=NULL, revision=revision+1 WHERE id=${id}`;
      } else if (body.action === "open" && phase === "lobby" && activity.poll) {
        // The room index stays at the lobby for private ballots, even during a mixed-version rollout.
        await tx`UPDATE classroom.live_activities SET phase='answering', question_index=${activity.poll.mode === "walk" ? 0 : -1},
          deadline=clock_timestamp() + question_seconds * INTERVAL '1 second', revision=revision+1 WHERE id=${id}`;
      } else if (body.action === "open" && phase === "lobby" && (activity.kind === "discussion" || activity.kind === "word-cloud")) {
        await tx`UPDATE classroom.live_activities SET phase='discussion', revision=revision+1 WHERE id=${id}`;
      } else if (body.action === "next" && (phase === "lobby" || phase === "revealed") && content && questionIndex + 1 < content.questions.length) {
        await tx`UPDATE classroom.live_activities SET phase='answering', question_index=question_index+1,
          deadline=clock_timestamp() + question_seconds * INTERVAL '1 second', revision=revision+1 WHERE id=${id}`;
      } else if (body.action === "lock" && phase === "answering") {
        if (activity.poll) await closePoll(activity, activity.poll, tx);
        else await tx`UPDATE classroom.live_activities SET phase='revealed', deadline=NULL, revision=revision+1 WHERE id=${id}`;
      } else if (body.action === "finish" && phase === "revealed" && content && questionIndex === content.questions.length - 1) {
        const participants = await tx<{ studentId: string }[]>`SELECT student_id AS "studentId" FROM classroom.live_activity_participants WHERE activity_id=${id}`;
        const picks = await tx<Pick[]>`SELECT student_id AS "studentId", question_index AS "questionIndex", choice_index AS "choiceIndex"
          FROM classroom.live_activity_choices WHERE activity_id=${id}`;
        if (participants.length) {
          const rows = participants.map(({ studentId }) => ({
            student_id: studentId, score: gradeQuiz(content, answersFor(content, picks.filter((pick) => pick.studentId === studentId))).score,
          }));
          await tx`UPDATE classroom.live_activity_participants p SET score=result.score
            FROM jsonb_to_recordset(${tx.json(rows)}::jsonb) result(student_id uuid, score bigint)
            WHERE p.activity_id=${id} AND p.student_id=result.student_id`;
        }
        await tx`UPDATE classroom.live_activities SET phase='finished', revision=revision+1 WHERE id=${id}`;
      } else if (body.action === "finish" && phase === "discussion") {
        const recap = body.recap?.trim();
        if (!recap && activity.kind === "discussion") throw new HttpError(422, "เขียนสรุปบทเรียนก่อนเผยแพร่");
        await tx`UPDATE classroom.live_activities SET phase='finished', recap=${recap || null}, revision=revision+1 WHERE id=${id}`;
      } else {
        throw conflict();
      }
      return { ok: true };
    });
  }, { params: idParams, body: t.Object({
    action: t.Union([t.Literal("open"), t.Literal("next"), t.Literal("lock"), t.Literal("finish"), t.Literal("cancel")]),
    revision: t.Integer({ minimum: 0 }), recap: t.Optional(t.String({ maxLength: 4000 })),
  }) })
  .put("/live-activities/:id/vote", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    return sql.begin(async (tx) => {
      const { activity, studentId } = await getViewer(request, params.id, tx, true);
      if (!studentId || activity.poll?.mode !== "private" || activity.phase !== "answering") throw conflict();
      if (body.choiceIndex !== null && body.choiceIndex >= activity.poll.choices.length) {
        throw new HttpError(422, "ไม่พบตัวเลือกนี้");
      }
      const [joined] = await tx`SELECT 1 FROM classroom.live_activity_participants WHERE activity_id=${activity.id} AND student_id=${studentId}`;
      if (!joined) throw new HttpError(403, "เข้าห้องกิจกรรมก่อนโหวต");
      const [saved] = await tx`INSERT INTO classroom.live_activity_choices (activity_id, student_id, question_index, choice_index)
        SELECT id, ${studentId}::uuid, 0, ${body.choiceIndex}::integer FROM classroom.live_activities
        WHERE id=${activity.id} AND deadline > clock_timestamp()
        ON CONFLICT (activity_id, student_id, question_index) DO UPDATE SET choice_index=EXCLUDED.choice_index
        RETURNING choice_index`;
      if (!saved) throw conflict();
      return { selected: body.choiceIndex };
    });
  }, { params: idParams, body: t.Object({ choiceIndex: t.Nullable(t.Integer({ minimum: 0, maximum: 7 })) }) })
  .post("/live-activities/:id/ideas", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    return sql.begin(async (tx) => {
      const { activity, studentId } = await getViewer(request, params.id, tx, true);
      if (!studentId || activity.phase !== "discussion") throw conflict();
      const [joined] = await tx`SELECT student_id FROM classroom.live_activity_participants WHERE activity_id=${activity.id} AND student_id=${studentId}`;
      if (!joined) throw new HttpError(403, "เข้าห้องกิจกรรมก่อนส่งความคิด");
      const entries = await tx<{ text: string }[]>`SELECT text FROM classroom.live_activity_ideas WHERE activity_id=${activity.id} AND student_id=${studentId}`;
      if (entries.length >= 3) throw new HttpError(409, "ส่งได้ไม่เกิน 3 รายการ");
      const cloud = activity.kind === "word-cloud";
      const text = cleanText(body.text, cloud ? 40 : 500);
      if (cloud && entries.some((entry) => termKey(entry.text) === termKey(text))) throw new HttpError(409, "ส่งคำหรือวลีนี้แล้ว");
      const [idea] = await tx`INSERT INTO classroom.live_activity_ideas (activity_id, student_id, text)
        VALUES (${activity.id}, ${studentId}, ${text}) RETURNING id`;
      return idea;
    });
  }, { params: idParams, body: t.Object({ text: t.String({ maxLength: 500 }) }) })
  .put("/live-activities/:id/ideas/:ideaId", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    await requireActor(request);
    return sql.begin(async (tx) => {
      const { activity, teacher } = await getViewer(request, params.id, tx, true);
      if (!teacher || !["discussion", "finished"].includes(activity.phase)
        || (activity.kind !== "discussion" && activity.kind !== "word-cloud")) throw conflict();
      const [idea] = await tx`UPDATE classroom.live_activity_ideas SET approved=${body.approved}
        WHERE id=${params.ideaId} AND activity_id=${activity.id} RETURNING id`;
      if (!idea) throw unavailable();
      return idea;
    });
  }, { params: t.Object({ id: uuid, ideaId: uuid }), body: t.Object({ approved: t.Boolean() }) })
  .get("/live-activities/:id/results", async ({ params, request }) => {
    await requireActor(request);
    const { teacher, activity } = await getViewer(request, params.id);
    if (!teacher || activity.kind !== "quiz") throw unavailable();
    return sql`SELECT s.id, s.display_name AS "displayName", s.student_number AS "studentNumber",
        p.student_id IS NOT NULL AS joined, p.score::float8 AS score
      FROM classroom.students s LEFT JOIN classroom.live_activity_participants p ON p.student_id=s.id AND p.activity_id=${activity.id}
      WHERE s.classroom_id=${activity.classroomId} AND (s.archived_at IS NULL OR p.student_id IS NOT NULL)
      ORDER BY s.student_number NULLS LAST, s.display_name, s.id`;
  }, { params: idParams })
  .put("/live-activities/:id/gradebook", async ({ params, body, request }) => {
    checkRequestOrigin(request);
    await requireActor(request);
    return sql.begin(async (tx) => {
      const { teacher, activity } = await getViewer(request, params.id, tx, true);
      if (!teacher || activity.kind !== "quiz" || activity.phase !== "finished") throw conflict();
      await tx`UPDATE classroom.live_activities SET include_in_gradebook=${body.include}, revision=revision+1
        WHERE id=${activity.id}`;
      return { ok: true };
    });
  }, { params: idParams, body: t.Object({ include: t.Boolean() }) })
  .get("/live-activities/:id/images/:imageId", async ({ params, request, set }) => {
    const { activity, teacher, studentId } = await getViewer(request, params.id);
    const content = activity.content;
    const question = content?.questions[activity.questionIndex];
    if (!content || !activity.quizId || !teacher && (!question || ended(activity.phase))) throw unavailable();
    if (!referencedQuizImages(teacher ? content : { description: "", questions: [question!] }).includes(params.imageId)) throw unavailable();
    if (!teacher) {
      const [joined] = await sql`SELECT student_id FROM classroom.live_activity_participants WHERE activity_id=${activity.id} AND student_id=${studentId}`;
      if (!joined) throw unavailable();
    }
    const [image] = await sql<{ storageName: string }[]>`SELECT storage_name AS "storageName" FROM classroom.quiz_images
      WHERE id=${params.imageId} AND quiz_id=${activity.quizId}`;
    if (!image) throw unavailable();
    set.headers["cache-control"] = "no-store";
    return Bun.file(await storedFilePath(image.storageName), { type: "image/webp" });
  }, { params: t.Object({ id: uuid, imageId: uuid }) });
