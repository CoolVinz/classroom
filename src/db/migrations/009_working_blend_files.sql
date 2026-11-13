ALTER TABLE classroom.files
  DROP CONSTRAINT files_kind_check,
  DROP CONSTRAINT files_attribution_check;

ALTER TABLE classroom.files
  ADD CONSTRAINT files_kind_check CHECK (kind IN ('worksheet', 'model', 'submission', 'working')),
  ADD CONSTRAINT files_attribution_check CHECK (
    (kind = 'worksheet' AND student_id IS NULL AND uploaded_by IS NOT NULL AND submitted_by_account_id IS NULL)
    OR (kind = 'model' AND student_id IS NOT NULL
      AND NOT (uploaded_by IS NOT NULL AND submitted_by_account_id IS NOT NULL))
    OR (kind = 'submission' AND student_id IS NOT NULL AND uploaded_by IS NULL
      AND submitted_by_account_id IS NOT NULL)
    OR (kind = 'working' AND student_id IS NOT NULL AND uploaded_by IS NULL
      AND submitted_by_account_id IS NULL)
  );

CREATE UNIQUE INDEX files_working_assignment_student_idx
  ON classroom.files (assignment_id, student_id) WHERE kind = 'working';
