ALTER TABLE classroom.assignments ADD COLUMN group_set_id UUID,
  ADD FOREIGN KEY (group_set_id, classroom_id)
    REFERENCES classroom.group_sets(id, classroom_id) ON DELETE SET NULL (group_set_id);
ALTER TABLE classroom.gallery_worlds ADD COLUMN exhibition_assignment_id UUID,
  ADD COLUMN displayed_assignment_id UUID,
  ADD FOREIGN KEY (exhibition_assignment_id, classroom_id)
    REFERENCES classroom.assignments(id, classroom_id) ON DELETE SET NULL (exhibition_assignment_id);

CREATE VIEW classroom.gallery_exhibition_assignments AS
SELECT a.classroom_id, a.id, a.title, a.group_set_id
FROM classroom.assignments a JOIN classroom.group_sets gs ON gs.id = a.group_set_id
WHERE a.archived_at IS NULL AND gs.status IN ('open', 'locked');

CREATE FUNCTION classroom.clear_assignment_exhibition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE classroom.gallery_worlds SET exhibition_assignment_id = NULL
  WHERE classroom_id = NEW.classroom_id AND exhibition_assignment_id = NEW.id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER clear_assignment_exhibition AFTER UPDATE OF archived_at, group_set_id ON classroom.assignments
FOR EACH ROW WHEN (NEW.archived_at IS NOT NULL OR NEW.group_set_id IS DISTINCT FROM OLD.group_set_id)
EXECUTE FUNCTION classroom.clear_assignment_exhibition();

CREATE FUNCTION classroom.clear_group_set_exhibition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE classroom.gallery_worlds w SET exhibition_assignment_id = NULL
  FROM classroom.assignments a
  WHERE w.classroom_id = NEW.classroom_id AND w.exhibition_assignment_id = a.id AND a.group_set_id = NEW.id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER clear_group_set_exhibition AFTER UPDATE OF status ON classroom.group_sets
FOR EACH ROW WHEN (NEW.status NOT IN ('open', 'locked'))
EXECUTE FUNCTION classroom.clear_group_set_exhibition();

CREATE FUNCTION classroom.gallery_layout(room_id UUID, exhibition_id UUID)
RETURNS TABLE (space_id UUID, display_name TEXT, student_number INTEGER)
LANGUAGE sql STABLE AS $$
  SELECT spaces.id, spaces.name, spaces.number
  FROM (
    SELECT s.id, s.display_name AS name, s.student_number AS number, NULL::timestamptz AS team_created
    FROM classroom.students s
    WHERE exhibition_id IS NULL AND s.classroom_id = room_id AND s.archived_at IS NULL
    UNION ALL
    SELECT g.id, g.name, NULL::integer, g.created_at
    FROM classroom.gallery_exhibition_assignments a JOIN classroom.student_groups g ON g.group_set_id = a.group_set_id
    WHERE a.id = exhibition_id AND a.classroom_id = room_id
      AND EXISTS (
        SELECT 1 FROM classroom.group_memberships m JOIN classroom.students s ON s.id = m.student_id
        WHERE m.group_set_id = g.group_set_id AND m.group_id = g.id AND s.archived_at IS NULL
      )
  ) spaces
  ORDER BY spaces.team_created, spaces.number NULLS LAST,
    CASE WHEN exhibition_id IS NULL THEN spaces.name END, spaces.id;
$$;

CREATE VIEW classroom.gallery_display_models AS
SELECT f.*, s.display_name, s.student_number, a.title AS assignment_title,
       COALESCE(m.group_id, f.student_id) AS space_id, (h.file_id IS NOT NULL) AS hidden
FROM classroom.files f
JOIN classroom.gallery_worlds w ON w.classroom_id = f.classroom_id
JOIN classroom.students s ON s.id = f.student_id
JOIN classroom.assignments a ON a.id = f.assignment_id
LEFT JOIN classroom.gallery_exhibition_assignments e ON e.id = w.displayed_assignment_id AND e.id = a.id
LEFT JOIN classroom.group_memberships m ON m.group_set_id = e.group_set_id AND m.student_id = s.id
LEFT JOIN classroom.gallery_hidden_models h ON h.classroom_id = f.classroom_id AND h.file_id = f.id
WHERE f.kind IN ('model', 'submission') AND lower(f.original_name) ~ '\.(stl|obj|glb|gltf)$'
  AND s.archived_at IS NULL AND a.archived_at IS NULL
  AND (w.displayed_assignment_id IS NULL OR m.group_id IS NOT NULL);
