ALTER TABLE classroom.gallery_worlds
  ADD COLUMN train_mode TEXT NOT NULL DEFAULT 'auto' CHECK (train_mode IN ('auto', 'manual')),
  ADD COLUMN train_interval_seconds INTEGER NOT NULL DEFAULT 120 CHECK (train_interval_seconds IN (60, 120)),
  ADD COLUMN train_start_student_id UUID REFERENCES classroom.students(id) ON DELETE SET NULL;
