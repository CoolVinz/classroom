DROP INDEX classroom.files_gallery_submission_access_idx;

CREATE INDEX files_gallery_submission_access_idx
  ON classroom.files (assignment_id, student_id, submitted_by_account_id)
  WHERE kind IN ('model', 'submission') AND submitted_by_account_id IS NOT NULL;

CREATE OR REPLACE VIEW classroom.gallery_student_entry AS
SELECT s.classroom_id,
       s.id AS student_id,
       s.account_id,
       s.display_name,
       s.student_number,
       w.student_entry_mode,
       a.id AS required_assignment_id,
       a.title AS required_assignment_title,
       COALESCE(work.has_submission, FALSE) AS has_submission,
       (approval.student_id IS NOT NULL) AS approved,
       (a.id IS NOT NULL
        AND COALESCE(work.has_submission, FALSE)
        AND (w.student_entry_mode = 'submission' OR approval.student_id IS NOT NULL)) AS entry_allowed
FROM classroom.students s
JOIN classroom.classrooms c ON c.id = s.classroom_id AND c.archived_at IS NULL
JOIN classroom.gallery_worlds w ON w.classroom_id = s.classroom_id
LEFT JOIN LATERAL (
  SELECT a.id, a.title
  FROM classroom.assignments a
  WHERE a.classroom_id = s.classroom_id AND a.archived_at IS NULL
  ORDER BY a.created_at DESC, a.id DESC
  LIMIT 1
) a ON TRUE
LEFT JOIN LATERAL (
  SELECT TRUE AS has_submission
  FROM classroom.files f
  WHERE f.classroom_id = s.classroom_id
    AND f.assignment_id = a.id
    AND f.student_id = s.id
    AND f.submitted_by_account_id = s.account_id
    AND f.kind IN ('model', 'submission')
  LIMIT 1
) work ON TRUE
LEFT JOIN classroom.gallery_entry_approvals approval
  ON approval.classroom_id = s.classroom_id
 AND approval.assignment_id = a.id
 AND approval.student_id = s.id
 AND approval.account_id = s.account_id
WHERE s.archived_at IS NULL;
