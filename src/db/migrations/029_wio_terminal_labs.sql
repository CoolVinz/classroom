ALTER TABLE classroom.assignments
  ADD COLUMN wio_lab text CHECK (wio_lab IN ('blink', 'buttons', 'lcd', 'light'));
