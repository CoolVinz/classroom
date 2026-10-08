CREATE TABLE classroom.teachers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'teacher' CHECK (role IN ('owner', 'teacher')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX teachers_single_owner_idx ON classroom.teachers (role) WHERE role = 'owner';

CREATE TABLE classroom.sessions (
  token_hash TEXT PRIMARY KEY,
  teacher_id UUID NOT NULL REFERENCES classroom.teachers(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX sessions_expiry_idx ON classroom.sessions (expires_at);

CREATE TABLE classroom.classrooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES classroom.teachers(id),
  name TEXT NOT NULL,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX classrooms_owner_idx ON classroom.classrooms (owner_id, archived_at);

CREATE TABLE classroom.students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  classroom_id UUID NOT NULL REFERENCES classroom.classrooms(id),
  student_code TEXT,
  display_name TEXT NOT NULL,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, classroom_id),
  UNIQUE (classroom_id, student_code)
);

CREATE TABLE classroom.attendance (
  classroom_id UUID NOT NULL,
  student_id UUID NOT NULL,
  attendance_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('present', 'absent', 'late', 'excused')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (student_id, attendance_date),
  FOREIGN KEY (student_id, classroom_id)
    REFERENCES classroom.students(id, classroom_id)
);

CREATE INDEX attendance_class_date_idx
  ON classroom.attendance (classroom_id, attendance_date);

CREATE INDEX students_class_active_idx
  ON classroom.students (classroom_id, archived_at, display_name);
