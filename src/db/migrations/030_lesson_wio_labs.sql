ALTER TABLE classroom.lesson_pages
  ADD COLUMN draft_wio_lab jsonb,
  ADD COLUMN published_wio_lab jsonb;

ALTER TABLE classroom.classroom_lessons
  ADD COLUMN wio_assignment_id uuid,
  ADD CONSTRAINT classroom_lessons_wio_assignment_fk
    FOREIGN KEY (wio_assignment_id, classroom_id)
    REFERENCES classroom.assignments (id, classroom_id)
    ON DELETE SET NULL (wio_assignment_id);

CREATE INDEX classroom_lessons_wio_assignment_idx
  ON classroom.classroom_lessons (wio_assignment_id, classroom_id)
  WHERE wio_assignment_id IS NOT NULL;
