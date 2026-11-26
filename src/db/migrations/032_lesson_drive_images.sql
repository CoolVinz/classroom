ALTER TABLE classroom.lesson_page_images
  ADD COLUMN drive_file_id TEXT,
  ALTER COLUMN storage_name DROP NOT NULL,
  ALTER COLUMN size_bytes DROP NOT NULL,
  ADD CONSTRAINT lesson_page_image_source CHECK (
    (drive_file_id IS NULL AND storage_name IS NOT NULL AND size_bytes IS NOT NULL)
    OR (drive_file_id IS NOT NULL AND drive_file_id ~ '^[A-Za-z0-9_-]{1,200}$'
      AND storage_name IS NULL AND size_bytes IS NULL)
  );

CREATE UNIQUE INDEX lesson_page_image_drive_file_idx
  ON classroom.lesson_page_images (lesson_id, drive_file_id) WHERE drive_file_id IS NOT NULL;
