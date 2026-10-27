ALTER TABLE classroom.attendance
  ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'automatic'));

CREATE TABLE classroom.weekly_timetables (
  classroom_id UUID PRIMARY KEY REFERENCES classroom.classrooms(id),
  term_starts_on DATE NOT NULL,
  term_ends_on DATE NOT NULL,
  grace_minutes SMALLINT NOT NULL DEFAULT 10 CHECK (grace_minutes BETWEEN 0 AND 120),
  CHECK (term_ends_on >= term_starts_on AND term_ends_on <= term_starts_on + 365)
);

CREATE TABLE classroom.weekly_timetable_days (
  classroom_id UUID NOT NULL REFERENCES classroom.weekly_timetables(classroom_id) ON DELETE CASCADE,
  weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  starts_at TIME NOT NULL,
  ends_at TIME NOT NULL,
  PRIMARY KEY (classroom_id, weekday),
  CHECK (ends_at > starts_at)
);

CREATE TABLE classroom.lessons (
  classroom_id UUID NOT NULL REFERENCES classroom.classrooms(id),
  lesson_date DATE NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  grace_minutes SMALLINT NOT NULL CHECK (grace_minutes BETWEEN 0 AND 120),
  cancelled_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  PRIMARY KEY (classroom_id, lesson_date),
  CHECK (ends_at > starts_at)
);

CREATE TABLE classroom.attendance_presence (
  classroom_id UUID NOT NULL,
  student_id UUID NOT NULL,
  attendance_date DATE NOT NULL,
  first_arrival_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  visible_seconds INTEGER NOT NULL DEFAULT 0 CHECK (visible_seconds >= 0),
  active_view UUID,
  last_sequence BIGINT NOT NULL DEFAULT 0,
  last_heartbeat_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (student_id, attendance_date),
  FOREIGN KEY (student_id, classroom_id)
    REFERENCES classroom.students(id, classroom_id) ON DELETE CASCADE,
  FOREIGN KEY (classroom_id, attendance_date)
    REFERENCES classroom.lessons(classroom_id, lesson_date) ON DELETE CASCADE
);

CREATE INDEX lessons_start_idx ON classroom.lessons (starts_at) WHERE cancelled_at IS NULL;
