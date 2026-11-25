ALTER TABLE classroom.gallery_worlds
  ADD COLUMN patrol_car_hits SMALLINT NOT NULL DEFAULT 5 CHECK (patrol_car_hits BETWEEN 1 AND 20),
  ADD COLUMN patrol_bike_hits SMALLINT NOT NULL DEFAULT 5 CHECK (patrol_bike_hits BETWEEN 1 AND 20),
  ADD COLUMN patrol_helicopter_hits SMALLINT NOT NULL DEFAULT 5 CHECK (patrol_helicopter_hits BETWEEN 1 AND 20),
  ADD COLUMN patrol_broom_hits SMALLINT NOT NULL DEFAULT 5 CHECK (patrol_broom_hits BETWEEN 1 AND 20),
  ADD COLUMN jail_base_seconds SMALLINT NOT NULL DEFAULT 15 CHECK (jail_base_seconds BETWEEN 5 AND 120),
  ADD COLUMN jail_extra_seconds SMALLINT NOT NULL DEFAULT 5 CHECK (jail_extra_seconds BETWEEN 1 AND 30),
  ADD COLUMN jail_max_seconds SMALLINT NOT NULL DEFAULT 60 CHECK (jail_max_seconds BETWEEN jail_base_seconds AND 180);
