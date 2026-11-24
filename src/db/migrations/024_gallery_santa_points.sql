CREATE TABLE classroom.gallery_point_claims (
  gift_id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES classroom.student_accounts(id) ON DELETE CASCADE,
  classroom_id UUID REFERENCES classroom.classrooms(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX gallery_point_claims_account_idx
  ON classroom.gallery_point_claims (account_id);
