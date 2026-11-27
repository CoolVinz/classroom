CREATE TABLE classroom.gallery_vote_rewards (
  account_id UUID NOT NULL REFERENCES classroom.student_accounts(id) ON DELETE CASCADE,
  assignment_id UUID NOT NULL,
  file_id UUID NOT NULL,
  voter_student_id UUID NOT NULL,
  vote_created_at TIMESTAMPTZ NOT NULL,
  points SMALLINT NOT NULL CHECK (points > 0),
  PRIMARY KEY (account_id, file_id)
);

-- Work and roster IDs are historical so teacher removals leave earned points intact.
CREATE INDEX gallery_vote_rewards_assignment_idx ON classroom.gallery_vote_rewards (account_id, assignment_id);

CREATE OR REPLACE FUNCTION classroom.gallery_point_balance(student_account UUID)
RETURNS INTEGER
LANGUAGE sql STABLE
AS $$
  SELECT (
    (SELECT COUNT(*) FROM classroom.gallery_point_claims WHERE account_id = student_account)
    + (SELECT COALESCE(SUM(points), 0) FROM classroom.gallery_vote_rewards WHERE account_id = student_account)
    - (SELECT COALESCE(SUM(price), 0) FROM classroom.gallery_purchases WHERE account_id = student_account)
  )::integer;
$$;
