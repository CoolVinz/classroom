CREATE TABLE classroom.live_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  classroom_id uuid NOT NULL REFERENCES classroom.classrooms(id) ON DELETE CASCADE,
  quiz_id uuid REFERENCES classroom.quizzes(id) ON DELETE CASCADE,
  lesson_id uuid REFERENCES classroom.lesson_pages(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('quiz', 'discussion')),
  phase text NOT NULL DEFAULT 'lobby' CHECK (phase IN ('lobby', 'answering', 'revealed', 'discussion', 'finished', 'cancelled')),
  content_snapshot jsonb,
  prompt text,
  recap text,
  question_index integer NOT NULL DEFAULT -1,
  question_seconds integer NOT NULL DEFAULT 30 CHECK (question_seconds BETWEEN 10 AND 120),
  deadline timestamptz,
  include_in_gradebook boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, classroom_id),
  CHECK ((kind = 'quiz' AND quiz_id IS NOT NULL AND content_snapshot IS NOT NULL)
    OR (kind = 'discussion' AND quiz_id IS NULL AND prompt IS NOT NULL)),
  CHECK ((phase = 'answering') = (deadline IS NOT NULL))
);

CREATE UNIQUE INDEX live_activities_one_active_idx ON classroom.live_activities (classroom_id)
  WHERE phase NOT IN ('finished', 'cancelled');
CREATE INDEX live_activities_quiz_idx ON classroom.live_activities (quiz_id);
CREATE INDEX live_activities_history_idx ON classroom.live_activities (classroom_id, created_at DESC);

CREATE TABLE classroom.live_activity_participants (
  activity_id uuid NOT NULL,
  classroom_id uuid NOT NULL,
  student_id uuid NOT NULL,
  score bigint,
  PRIMARY KEY (activity_id, student_id),
  FOREIGN KEY (activity_id, classroom_id) REFERENCES classroom.live_activities(id, classroom_id) ON DELETE CASCADE,
  FOREIGN KEY (student_id, classroom_id) REFERENCES classroom.students(id, classroom_id) ON DELETE CASCADE
);
CREATE INDEX live_activity_participants_student_idx ON classroom.live_activity_participants (student_id);

CREATE TABLE classroom.live_activity_choices (
  activity_id uuid NOT NULL,
  student_id uuid NOT NULL,
  question_index integer NOT NULL CHECK (question_index BETWEEN 0 AND 99),
  choice_index integer CHECK (choice_index BETWEEN 0 AND 7),
  PRIMARY KEY (activity_id, student_id, question_index),
  FOREIGN KEY (activity_id, student_id) REFERENCES classroom.live_activity_participants(activity_id, student_id) ON DELETE CASCADE
);

CREATE TABLE classroom.live_activity_ideas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id uuid NOT NULL,
  student_id uuid NOT NULL,
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  approved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (activity_id, student_id) REFERENCES classroom.live_activity_participants(activity_id, student_id) ON DELETE CASCADE
);
CREATE INDEX live_activity_ideas_activity_idx ON classroom.live_activity_ideas (activity_id, created_at);

CREATE TABLE classroom.live_activity_tickets (
  token_hash text PRIMARY KEY,
  activity_id uuid NOT NULL REFERENCES classroom.live_activities(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  session_hash text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('teacher', 'student')),
  expires_at timestamptz NOT NULL
);
CREATE INDEX live_activity_tickets_expiry_idx ON classroom.live_activity_tickets (expires_at);
