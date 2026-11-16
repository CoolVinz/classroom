CREATE TABLE classroom.gallery_worlds (
  classroom_id UUID PRIMARY KEY REFERENCES classroom.classrooms(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE classroom.gallery_blocks (
  classroom_id UUID NOT NULL,
  student_id UUID NOT NULL,
  block_index BIGINT NOT NULL,
  PRIMARY KEY (classroom_id, student_id),
  UNIQUE (classroom_id, block_index),
  FOREIGN KEY (student_id, classroom_id) REFERENCES classroom.students(id, classroom_id) ON DELETE CASCADE
);

CREATE TABLE classroom.gallery_hidden_models (
  classroom_id UUID NOT NULL,
  file_id UUID NOT NULL REFERENCES classroom.files(id) ON DELETE CASCADE,
  hidden_by UUID NOT NULL REFERENCES classroom.teachers(id),
  hidden_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (classroom_id, file_id)
);

CREATE TABLE classroom.gallery_likes (
  classroom_id UUID NOT NULL,
  file_id UUID NOT NULL REFERENCES classroom.files(id) ON DELETE CASCADE,
  student_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (file_id, student_id),
  FOREIGN KEY (student_id, classroom_id) REFERENCES classroom.students(id, classroom_id) ON DELETE CASCADE
);

CREATE TABLE classroom.gallery_tickets (
  token_hash TEXT PRIMARY KEY,
  classroom_id UUID NOT NULL REFERENCES classroom.classrooms(id) ON DELETE CASCADE,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('teacher', 'student')),
  account_id UUID NOT NULL,
  student_id UUID,
  session_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK ((actor_kind = 'teacher' AND student_id IS NULL) OR (actor_kind = 'student' AND student_id IS NOT NULL))
);

CREATE INDEX gallery_tickets_expiry_idx ON classroom.gallery_tickets (expires_at);
CREATE INDEX gallery_likes_file_idx ON classroom.gallery_likes (classroom_id, file_id);
