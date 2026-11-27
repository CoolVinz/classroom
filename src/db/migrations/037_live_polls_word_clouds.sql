ALTER TABLE classroom.live_activities
  DROP CONSTRAINT live_activities_kind_check,
  DROP CONSTRAINT live_activities_check,
  ADD COLUMN poll_snapshot jsonb,
  ADD COLUMN poll_counts integer[],
  ADD CONSTRAINT live_activities_kind_check CHECK (kind IN ('quiz', 'discussion', 'poll', 'word-cloud')),
  ADD CONSTRAINT live_activities_payload_check CHECK (
    (kind = 'quiz' AND quiz_id IS NOT NULL AND content_snapshot IS NOT NULL)
    OR (kind IN ('discussion', 'poll', 'word-cloud') AND quiz_id IS NULL AND prompt IS NOT NULL)
  ),
  ADD CONSTRAINT live_activities_poll_check CHECK (
    (kind = 'poll') = (poll_snapshot IS NOT NULL)
    AND (kind = 'poll' AND phase = 'finished') = (poll_counts IS NOT NULL)
  );
