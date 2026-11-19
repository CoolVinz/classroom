CREATE TABLE classroom.gradebook_columns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  classroom_id UUID NOT NULL REFERENCES classroom.classrooms(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  max_score NUMERIC(12, 2) NOT NULL CHECK (max_score > 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, classroom_id)
);

CREATE INDEX gradebook_columns_classroom_idx
  ON classroom.gradebook_columns (classroom_id, archived_at, created_at);

CREATE TABLE classroom.gradebook_marks (
  column_id UUID NOT NULL,
  classroom_id UUID NOT NULL,
  student_id UUID NOT NULL,
  score NUMERIC(12, 2) NOT NULL CHECK (score >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (column_id, student_id),
  FOREIGN KEY (column_id, classroom_id)
    REFERENCES classroom.gradebook_columns(id, classroom_id) ON DELETE CASCADE,
  FOREIGN KEY (student_id, classroom_id)
    REFERENCES classroom.students(id, classroom_id) ON DELETE CASCADE
);

CREATE INDEX gradebook_marks_student_idx ON classroom.gradebook_marks (student_id, column_id);
