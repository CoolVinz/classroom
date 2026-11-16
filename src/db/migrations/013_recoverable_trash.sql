ALTER TABLE classroom.quizzes ADD COLUMN trashed_at TIMESTAMPTZ;
ALTER TABLE classroom.lesson_pages ADD COLUMN trashed_at TIMESTAMPTZ;

CREATE INDEX quizzes_owner_trash_updated_idx ON classroom.quizzes (owner_id, trashed_at, updated_at DESC);
CREATE INDEX lesson_pages_owner_trash_updated_idx ON classroom.lesson_pages (owner_id, trashed_at, updated_at DESC);
