ALTER TABLE classroom.files
  ADD COLUMN thumbnail_media_type TEXT;

UPDATE classroom.files
SET thumbnail_media_type = 'image/png'
WHERE thumbnail_size_bytes IS NOT NULL;

ALTER TABLE classroom.files
  ADD CONSTRAINT files_thumbnail_media_type_check
  CHECK (
    (thumbnail_size_bytes IS NULL AND thumbnail_media_type IS NULL)
    OR (thumbnail_size_bytes IS NOT NULL AND thumbnail_media_type IS NOT NULL
      AND thumbnail_media_type IN ('image/png', 'image/webp'))
  );
