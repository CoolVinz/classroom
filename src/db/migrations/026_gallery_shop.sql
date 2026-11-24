ALTER TABLE classroom.gallery_worlds
  ADD COLUMN wand_price INTEGER NOT NULL DEFAULT 5 CHECK (wand_price BETWEEN 1 AND 1000),
  ADD COLUMN license_price INTEGER NOT NULL DEFAULT 10 CHECK (license_price BETWEEN 1 AND 1000);

CREATE TABLE classroom.gallery_purchases (
  account_id UUID NOT NULL REFERENCES classroom.student_accounts(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  classroom_id UUID REFERENCES classroom.classrooms(id) ON DELETE SET NULL,
  item TEXT NOT NULL CHECK (item IN ('wand', 'license')),
  price INTEGER NOT NULL CHECK (price BETWEEN 1 AND 1000),
  remaining INTEGER NOT NULL,
  use_ids UUID[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (account_id, request_id),
  CHECK (remaining >= 0 AND remaining + cardinality(use_ids) = CASE item WHEN 'wand' THEN 15 ELSE 1 END)
);

CREATE UNIQUE INDEX gallery_one_unused_item_idx
  ON classroom.gallery_purchases (account_id, classroom_id, item)
  WHERE remaining > 0 AND classroom_id IS NOT NULL;

CREATE FUNCTION classroom.gallery_point_balance(student_account UUID)
RETURNS INTEGER
LANGUAGE sql STABLE
AS $$
  SELECT (
    (SELECT COUNT(*) FROM classroom.gallery_point_claims WHERE account_id = student_account)
    - (SELECT COALESCE(SUM(price), 0) FROM classroom.gallery_purchases WHERE account_id = student_account)
  )::integer;
$$;
