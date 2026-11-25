ALTER TABLE classroom.lesson_pages ADD COLUMN legacy_public BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE classroom.lesson_pages SET legacy_public = TRUE WHERE published_blocks IS NOT NULL;

CREATE TABLE classroom.classroom_lessons (
  classroom_id UUID NOT NULL REFERENCES classroom.classrooms(id) ON DELETE CASCADE,
  lesson_id UUID NOT NULL REFERENCES classroom.lesson_pages(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (classroom_id, lesson_id)
);
CREATE INDEX classroom_lessons_lesson_idx ON classroom.classroom_lessons (lesson_id);

CREATE TABLE classroom.worksheets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES classroom.teachers(id),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
  draft_questions JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(draft_questions) = 'array'),
  revision INTEGER NOT NULL DEFAULT 0,
  published_title TEXT,
  published_questions JSONB CHECK (jsonb_typeof(published_questions) = 'array'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((published_title IS NULL) = (published_questions IS NULL))
);
CREATE INDEX worksheets_owner_idx ON classroom.worksheets (owner_id, updated_at DESC);

CREATE TABLE classroom.worksheet_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  classroom_id UUID NOT NULL REFERENCES classroom.classrooms(id) ON DELETE CASCADE,
  worksheet_id UUID NOT NULL REFERENCES classroom.worksheets(id),
  lesson_id UUID,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
  questions JSONB NOT NULL CHECK (jsonb_typeof(questions) = 'array'),
  max_score INTEGER NOT NULL CHECK (max_score > 0),
  status TEXT NOT NULL DEFAULT 'awaiting_open' CHECK (status IN ('awaiting_open', 'open', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, classroom_id),
  FOREIGN KEY (classroom_id, lesson_id) REFERENCES classroom.classroom_lessons (classroom_id, lesson_id) ON DELETE SET NULL (lesson_id)
);
CREATE INDEX worksheet_rounds_room_idx ON classroom.worksheet_rounds (classroom_id, created_at DESC);
CREATE INDEX worksheet_rounds_template_idx ON classroom.worksheet_rounds (worksheet_id, created_at DESC);

CREATE TABLE classroom.worksheet_attempts (
  round_id UUID NOT NULL,
  classroom_id UUID NOT NULL,
  student_id UUID NOT NULL,
  answers JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(answers) = 'object'),
  revision INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at TIMESTAMPTZ,
  score INTEGER CHECK (score >= 0),
  PRIMARY KEY (round_id, student_id),
  FOREIGN KEY (round_id, classroom_id) REFERENCES classroom.worksheet_rounds (id, classroom_id) ON DELETE CASCADE,
  FOREIGN KEY (student_id, classroom_id) REFERENCES classroom.students (id, classroom_id) ON DELETE CASCADE,
  CHECK ((submitted_at IS NULL) = (score IS NULL))
);
CREATE INDEX worksheet_attempts_student_idx ON classroom.worksheet_attempts (student_id);
