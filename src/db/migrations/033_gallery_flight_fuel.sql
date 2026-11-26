ALTER TABLE classroom.gallery_worlds
  DROP CONSTRAINT gallery_worlds_santa_bomb_fuse_seconds_check,
  ADD CONSTRAINT gallery_worlds_santa_bomb_fuse_seconds_check CHECK (santa_bomb_fuse_seconds BETWEEN 1 AND 15),
  ADD COLUMN helicopter_fuel_seconds SMALLINT NOT NULL DEFAULT 30 CHECK (helicopter_fuel_seconds BETWEEN 5 AND 180),
  ADD COLUMN broom_fuel_seconds SMALLINT NOT NULL DEFAULT 30 CHECK (broom_fuel_seconds BETWEEN 5 AND 180);
