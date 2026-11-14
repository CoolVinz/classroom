CREATE TABLE classroom.quizzes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES classroom.teachers(id),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
  draft_content JSONB NOT NULL DEFAULT '{"description":"","questions":[]}'::jsonb
    CHECK (jsonb_typeof(draft_content) = 'object'),
  draft_revision INTEGER NOT NULL DEFAULT 0 CHECK (draft_revision >= 0),
  published_title TEXT,
  published_content JSONB CHECK (published_content IS NULL OR jsonb_typeof(published_content) = 'object'),
  published_revision INTEGER,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((published_content IS NULL) = (published_title IS NULL)),
  CHECK ((published_content IS NULL) = (published_at IS NULL))
);

CREATE INDEX quizzes_owner_updated_idx ON classroom.quizzes (owner_id, updated_at DESC);

CREATE TABLE classroom.quiz_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id UUID NOT NULL REFERENCES classroom.quizzes(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  storage_name TEXT NOT NULL UNIQUE,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX quiz_images_quiz_idx ON classroom.quiz_images (quiz_id, created_at);

CREATE TABLE classroom.classroom_quizzes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  classroom_id UUID NOT NULL REFERENCES classroom.classrooms(id),
  owner_id UUID NOT NULL REFERENCES classroom.teachers(id),
  quiz_id UUID NOT NULL REFERENCES classroom.quizzes(id),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
  content_snapshot JSONB NOT NULL CHECK (jsonb_typeof(content_snapshot) = 'object'),
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 1 AND 240),
  status TEXT NOT NULL DEFAULT 'awaiting_open' CHECK (status IN ('awaiting_open', 'open', 'closed')),
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  solutions_released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, classroom_id),
  CHECK ((status = 'awaiting_open' AND opened_at IS NULL AND closed_at IS NULL)
    OR (status = 'open' AND opened_at IS NOT NULL AND closed_at IS NULL)
    OR (status = 'closed' AND closed_at IS NOT NULL))
);

CREATE INDEX classroom_quizzes_room_idx ON classroom.classroom_quizzes (classroom_id, created_at DESC);
CREATE INDEX classroom_quizzes_quiz_idx ON classroom.classroom_quizzes (quiz_id, classroom_id);

CREATE TABLE classroom.quiz_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  classroom_quiz_id UUID NOT NULL,
  classroom_id UUID NOT NULL,
  student_id UUID NOT NULL,
  answers JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(answers) = 'object'),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  finish_reason TEXT CHECK (finish_reason IS NULL OR finish_reason IN ('submitted', 'expired', 'closed')),
  score BIGINT,
  UNIQUE (classroom_quiz_id, student_id),
  FOREIGN KEY (classroom_quiz_id, classroom_id)
    REFERENCES classroom.classroom_quizzes(id, classroom_id) ON DELETE CASCADE,
  FOREIGN KEY (student_id, classroom_id)
    REFERENCES classroom.students(id, classroom_id) ON DELETE CASCADE,
  CHECK ((finished_at IS NULL AND finish_reason IS NULL AND score IS NULL)
    OR (finished_at IS NOT NULL AND finish_reason IS NOT NULL AND score IS NOT NULL))
);

CREATE INDEX quiz_attempts_student_idx ON classroom.quiz_attempts (student_id, started_at DESC);
CREATE INDEX quiz_attempts_expiry_idx ON classroom.quiz_attempts (classroom_quiz_id, expires_at) WHERE finished_at IS NULL;

ALTER TABLE classroom.lesson_pages
  ADD COLUMN draft_quiz_links JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(draft_quiz_links) = 'array'),
  ADD COLUMN published_quiz_links JSONB CHECK (published_quiz_links IS NULL OR jsonb_typeof(published_quiz_links) = 'array');
