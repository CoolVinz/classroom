CREATE TABLE classroom.group_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  classroom_id UUID NOT NULL REFERENCES classroom.classrooms(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  student_limit INTEGER CHECK (student_limit BETWEEN 1 AND 400),
  group_limit INTEGER CHECK (group_limit BETWEEN 1 AND 400),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'locked', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (student_limit IS NOT NULL OR group_limit IS NOT NULL),
  UNIQUE (id, classroom_id)
);
CREATE INDEX group_sets_classroom_idx ON classroom.group_sets (classroom_id, created_at DESC);

CREATE TABLE classroom.student_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_set_id UUID NOT NULL,
  classroom_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  creator_student_id UUID REFERENCES classroom.students(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_set_id, id),
  FOREIGN KEY (group_set_id, classroom_id) REFERENCES classroom.group_sets(id, classroom_id) ON DELETE CASCADE
);
CREATE INDEX student_groups_set_idx ON classroom.student_groups (group_set_id, created_at, id);

CREATE TABLE classroom.group_memberships (
  group_set_id UUID NOT NULL,
  classroom_id UUID NOT NULL,
  group_id UUID NOT NULL,
  student_id UUID NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_set_id, student_id),
  FOREIGN KEY (group_set_id, classroom_id) REFERENCES classroom.group_sets(id, classroom_id) ON DELETE CASCADE,
  FOREIGN KEY (group_set_id, group_id) REFERENCES classroom.student_groups(group_set_id, id) ON DELETE CASCADE,
  FOREIGN KEY (student_id, classroom_id) REFERENCES classroom.students(id, classroom_id) ON DELETE CASCADE
);
CREATE INDEX group_memberships_group_idx ON classroom.group_memberships (group_set_id, group_id);
CREATE INDEX group_memberships_student_idx ON classroom.group_memberships (student_id, group_set_id);
