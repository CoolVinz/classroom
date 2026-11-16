ALTER TABLE classroom.teachers
  ADD COLUMN avatar_settings JSONB NOT NULL DEFAULT '{"skinColor":"#f3c8a6","hairColor":"#3e2d27","shirtColor":"#4f9b86","trousersColor":"#435875","hairStyle":"short"}'::jsonb,
  ADD CONSTRAINT teachers_avatar_settings_check CHECK (COALESCE(
    avatar_settings->>'hairStyle' IN ('none','short','long') AND
    avatar_settings->>'skinColor' ~ '^#[0-9a-fA-F]{6}$' AND
    avatar_settings->>'hairColor' ~ '^#[0-9a-fA-F]{6}$' AND
    avatar_settings->>'shirtColor' ~ '^#[0-9a-fA-F]{6}$' AND
    avatar_settings->>'trousersColor' ~ '^#[0-9a-fA-F]{6}$', FALSE
  ));

ALTER TABLE classroom.student_accounts
  ADD COLUMN avatar_settings JSONB NOT NULL DEFAULT '{"skinColor":"#f3c8a6","hairColor":"#3e2d27","shirtColor":"#4f9b86","trousersColor":"#435875","hairStyle":"short"}'::jsonb,
  ADD CONSTRAINT student_accounts_avatar_settings_check CHECK (COALESCE(
    avatar_settings->>'hairStyle' IN ('none','short','long') AND
    avatar_settings->>'skinColor' ~ '^#[0-9a-fA-F]{6}$' AND
    avatar_settings->>'hairColor' ~ '^#[0-9a-fA-F]{6}$' AND
    avatar_settings->>'shirtColor' ~ '^#[0-9a-fA-F]{6}$' AND
    avatar_settings->>'trousersColor' ~ '^#[0-9a-fA-F]{6}$', FALSE
  ));
