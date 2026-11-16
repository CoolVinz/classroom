ALTER TABLE classroom.files
  ADD COLUMN material_storage_name TEXT,
  ADD COLUMN material_original_name TEXT,
  ADD COLUMN material_size_bytes BIGINT,
  ADD CONSTRAINT files_material_companion_check CHECK (
    (material_storage_name IS NULL AND material_original_name IS NULL AND material_size_bytes IS NULL)
    OR (kind IN ('model', 'submission') AND lower(original_name) ~ '\.obj$'
      AND material_storage_name IS NOT NULL AND material_original_name IS NOT NULL
      AND material_size_bytes BETWEEN 1 AND 1048576)
  );
