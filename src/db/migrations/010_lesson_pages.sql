CREATE TABLE classroom.lesson_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES classroom.teachers(id),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
  draft_blocks JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(draft_blocks) = 'array'),
  draft_revision INTEGER NOT NULL DEFAULT 0 CHECK (draft_revision >= 0),
  published_blocks JSONB CHECK (published_blocks IS NULL OR jsonb_typeof(published_blocks) = 'array'),
  published_revision INTEGER,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX lesson_pages_owner_updated_idx
  ON classroom.lesson_pages (owner_id, updated_at DESC);

CREATE TABLE classroom.lesson_page_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id UUID NOT NULL REFERENCES classroom.lesson_pages(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  storage_name TEXT NOT NULL UNIQUE,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX lesson_page_images_lesson_idx
  ON classroom.lesson_page_images (lesson_id, created_at);
