ALTER TABLE classroom.assignments DROP CONSTRAINT assignments_wio_lab_check;
ALTER TABLE classroom.assignments ADD CONSTRAINT assignments_wio_lab_check
  CHECK (wio_lab IN ('blink', 'buttons', 'lcd', 'light', 'counter', 'light-meter', 'switch-menu', 'buzzer'));
