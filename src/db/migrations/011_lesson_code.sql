ALTER TABLE classroom.lesson_pages
  ADD COLUMN editor_mode TEXT NOT NULL DEFAULT 'blocks' CHECK (editor_mode IN ('blocks', 'code')),
  ADD COLUMN published_title TEXT;

UPDATE classroom.lesson_pages
SET published_title = title
WHERE published_blocks IS NOT NULL;

ALTER TABLE classroom.lesson_pages
  ADD CONSTRAINT lesson_pages_published_title_check
  CHECK ((published_blocks IS NULL) = (published_title IS NULL));
