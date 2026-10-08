CREATE TABLE classroom.assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  classroom_id UUID NOT NULL REFERENCES classroom.classrooms(id),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
  instructions TEXT NOT NULL DEFAULT '',
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, classroom_id)
);

CREATE INDEX assignments_class_active_idx
  ON classroom.assignments (classroom_id, archived_at, created_at DESC);

CREATE TABLE classroom.files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  classroom_id UUID NOT NULL,
  assignment_id UUID NOT NULL,
  student_id UUID,
  uploaded_by UUID REFERENCES classroom.teachers(id),
  kind TEXT NOT NULL CHECK (kind IN ('worksheet', 'model')),
  original_name TEXT NOT NULL,
  storage_name TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((kind = 'worksheet' AND student_id IS NULL) OR (kind = 'model' AND student_id IS NOT NULL)),
  CHECK (kind = 'model' OR uploaded_by IS NOT NULL),
  FOREIGN KEY (assignment_id, classroom_id)
    REFERENCES classroom.assignments(id, classroom_id) ON DELETE CASCADE,
  FOREIGN KEY (student_id, classroom_id)
    REFERENCES classroom.students(id, classroom_id)
);

CREATE INDEX files_assignment_idx
  ON classroom.files (classroom_id, assignment_id, created_at);
CREATE INDEX files_student_idx
  ON classroom.files (classroom_id, student_id, created_at);
