ALTER TABLE classroom.gallery_worlds
  ADD COLUMN train_station_wait_seconds JSONB NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(train_station_wait_seconds) = 'object');
