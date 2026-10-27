ALTER TABLE classroom.student_accounts
  ALTER COLUMN password_hash DROP NOT NULL,
  ADD COLUMN google_subject TEXT UNIQUE;

UPDATE classroom.students s
SET email = s.student_code || '@banjan.ac.th'
WHERE (s.email IS NULL OR btrim(s.email) = '')
  AND s.student_code ~ '^[0-9]+$'
  AND NOT EXISTS (
    SELECT 1 FROM classroom.students other
    WHERE other.classroom_id = s.classroom_id
      AND lower(btrim(other.email)) = (s.student_code || '@banjan.ac.th')
  );

DELETE FROM classroom.student_sessions;
DELETE FROM classroom.student_auth_tokens;
