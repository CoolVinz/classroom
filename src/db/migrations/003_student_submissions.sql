CREATE TABLE classroom.student_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND length(email) <= 254),
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE classroom.students
  ADD COLUMN email TEXT CHECK (email IS NULL OR (email = lower(btrim(email)) AND length(email) <= 254)),
  ADD COLUMN account_id UUID REFERENCES classroom.student_accounts(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX students_account_classroom_idx
  ON classroom.students (classroom_id, account_id) WHERE account_id IS NOT NULL;

CREATE UNIQUE INDEX students_email_classroom_idx
  ON classroom.students (classroom_id, email) WHERE email IS NOT NULL;

CREATE TABLE classroom.student_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES classroom.student_accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX student_sessions_expiry_idx ON classroom.student_sessions (expires_at);

CREATE TABLE classroom.student_auth_tokens (
  token_hash TEXT PRIMARY KEY,
  token_kind TEXT NOT NULL CHECK (token_kind IN ('invite', 'password_reset')),
  email TEXT NOT NULL CHECK (email = lower(btrim(email)) AND length(email) <= 254),
  student_id UUID REFERENCES classroom.students(id) ON DELETE CASCADE,
  account_id UUID REFERENCES classroom.student_accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK ((token_kind = 'invite' AND student_id IS NOT NULL AND account_id IS NULL)
    OR (token_kind = 'password_reset' AND student_id IS NULL AND account_id IS NOT NULL))
);

CREATE INDEX student_auth_tokens_expiry_idx ON classroom.student_auth_tokens (expires_at);

ALTER TABLE classroom.files
  ADD COLUMN submitted_by_account_id UUID REFERENCES classroom.student_accounts(id);

ALTER TABLE classroom.files
  DROP CONSTRAINT files_kind_check,
  DROP CONSTRAINT files_check,
  DROP CONSTRAINT files_check1;

ALTER TABLE classroom.files
  ADD CONSTRAINT files_kind_check CHECK (kind IN ('worksheet', 'model', 'submission')),
  ADD CONSTRAINT files_attribution_check CHECK (
    (kind = 'worksheet' AND student_id IS NULL AND uploaded_by IS NOT NULL AND submitted_by_account_id IS NULL)
    OR (kind = 'model' AND student_id IS NOT NULL
      AND NOT (uploaded_by IS NOT NULL AND submitted_by_account_id IS NOT NULL))
    OR (kind = 'submission' AND student_id IS NOT NULL AND uploaded_by IS NULL
      AND submitted_by_account_id IS NOT NULL)
  );

CREATE INDEX files_student_submission_idx
  ON classroom.files (submitted_by_account_id, assignment_id, created_at)
  WHERE submitted_by_account_id IS NOT NULL;
