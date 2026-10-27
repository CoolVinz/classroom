ALTER TABLE classroom.students
  ADD COLUMN student_number INTEGER CHECK (student_number IS NULL OR student_number > 0);

CREATE UNIQUE INDEX students_class_active_number_idx
  ON classroom.students (classroom_id, student_number)
  WHERE archived_at IS NULL AND student_number IS NOT NULL;
