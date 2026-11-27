ALTER TABLE classroom.classrooms ADD COLUMN is_test boolean NOT NULL DEFAULT false;

ALTER TABLE classroom.student_accounts
  ADD COLUMN test_classroom_id uuid REFERENCES classroom.classrooms(id),
  ALTER COLUMN email DROP NOT NULL,
  ADD CONSTRAINT student_account_identity_check CHECK (
    (test_classroom_id IS NULL AND email IS NOT NULL) OR
    (test_classroom_id IS NOT NULL AND email IS NULL AND google_subject IS NULL AND password_hash IS NULL)
  );

CREATE FUNCTION classroom.check_test_roster_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  test_room boolean;
  account_room uuid;
BEGIN
  SELECT is_test INTO test_room FROM classroom.classrooms WHERE id = NEW.classroom_id;
  SELECT test_classroom_id INTO account_room FROM classroom.student_accounts WHERE id = NEW.account_id;
  IF (test_room AND (account_room IS DISTINCT FROM NEW.classroom_id OR NEW.email IS NOT NULL))
    OR (NOT test_room AND account_room IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid membership for a test classroom or tester account' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER check_test_roster_membership
  BEFORE INSERT OR UPDATE OF classroom_id, account_id, email ON classroom.students
  FOR EACH ROW EXECUTE FUNCTION classroom.check_test_roster_membership();

CREATE TABLE classroom.test_student_links (
  account_id uuid PRIMARY KEY REFERENCES classroom.student_accounts(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL
);
