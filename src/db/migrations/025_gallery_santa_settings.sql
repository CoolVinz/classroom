ALTER TABLE classroom.gallery_worlds
  ADD COLUMN santa_bomb_fuse_seconds INTEGER NOT NULL DEFAULT 5 CHECK (santa_bomb_fuse_seconds BETWEEN 2 AND 15),
  ADD COLUMN santa_respawn_seconds INTEGER NOT NULL DEFAULT 10 CHECK (santa_respawn_seconds BETWEEN 3 AND 60);
