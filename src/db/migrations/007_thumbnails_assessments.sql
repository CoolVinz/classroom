ALTER TABLE classroom.assignments
  ADD COLUMN max_score NUMERIC(12, 2) NOT NULL DEFAULT 100 CHECK (max_score > 0);

CREATE SEQUENCE classroom.file_work_version_seq AS BIGINT;

ALTER TABLE classroom.files
  ADD COLUMN thumbnail_size_bytes BIGINT
    CHECK (thumbnail_size_bytes IS NULL OR thumbnail_size_bytes BETWEEN 1 AND 262144),
  ADD COLUMN work_version BIGINT NOT NULL DEFAULT nextval('classroom.file_work_version_seq');

ALTER SEQUENCE classroom.file_work_version_seq OWNED BY classroom.files.work_version;

CREATE TABLE classroom.assignment_assessments (
  assignment_id UUID NOT NULL,
  classroom_id UUID NOT NULL,
  student_id UUID NOT NULL,
  draft_score NUMERIC(12, 2) CHECK (draft_score IS NULL OR draft_score >= 0),
  draft_feedback TEXT NOT NULL DEFAULT '',
  draft_reviewed_file_ids UUID[] NOT NULL DEFAULT '{}',
  draft_revision INTEGER NOT NULL DEFAULT 0 CHECK (draft_revision >= 0),
  draft_updated_at TIMESTAMPTZ,
  published_score NUMERIC(12, 2),
  published_max_score NUMERIC(12, 2),
  published_feedback TEXT,
  published_reviewed_file_ids UUID[],
  published_revision INTEGER,
  published_at TIMESTAMPTZ,
  PRIMARY KEY (assignment_id, student_id),
  FOREIGN KEY (assignment_id, classroom_id)
    REFERENCES classroom.assignments(id, classroom_id) ON DELETE CASCADE,
  FOREIGN KEY (student_id, classroom_id)
    REFERENCES classroom.students(id, classroom_id) ON DELETE CASCADE,
  CHECK ((published_score IS NULL AND published_max_score IS NULL AND published_feedback IS NULL
      AND published_reviewed_file_ids IS NULL AND published_revision IS NULL AND published_at IS NULL)
    OR (published_score IS NOT NULL AND published_score >= 0 AND published_max_score IS NOT NULL
      AND published_max_score > 0 AND published_score <= published_max_score
      AND published_feedback IS NOT NULL AND published_reviewed_file_ids IS NOT NULL
      AND published_revision IS NOT NULL AND published_revision > 0 AND published_at IS NOT NULL))
);

CREATE INDEX assignment_assessments_class_idx
  ON classroom.assignment_assessments (classroom_id, assignment_id, student_id);
