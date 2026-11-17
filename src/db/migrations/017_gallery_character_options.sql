UPDATE classroom.teachers SET avatar_settings=avatar_settings || '{"hatStyle":"none","glassesStyle":"none","shoeStyle":"sneakers","hatColor":"#b84d4d","glassesColor":"#302721","shoeColor":"#303a4a"}'::jsonb;
UPDATE classroom.student_accounts SET avatar_settings=avatar_settings || '{"hatStyle":"none","glassesStyle":"none","shoeStyle":"sneakers","hatColor":"#b84d4d","glassesColor":"#302721","shoeColor":"#303a4a"}'::jsonb;
ALTER TABLE classroom.teachers ALTER COLUMN avatar_settings SET DEFAULT '{"skinColor":"#f3c8a6","hairColor":"#3e2d27","shirtColor":"#4f9b86","trousersColor":"#435875","hairStyle":"short","hatStyle":"none","glassesStyle":"none","shoeStyle":"sneakers","hatColor":"#b84d4d","glassesColor":"#302721","shoeColor":"#303a4a"}'::jsonb;
ALTER TABLE classroom.student_accounts ALTER COLUMN avatar_settings SET DEFAULT '{"skinColor":"#f3c8a6","hairColor":"#3e2d27","shirtColor":"#4f9b86","trousersColor":"#435875","hairStyle":"short","hatStyle":"none","glassesStyle":"none","shoeStyle":"sneakers","hatColor":"#b84d4d","glassesColor":"#302721","shoeColor":"#303a4a"}'::jsonb;
ALTER TABLE classroom.teachers DROP CONSTRAINT teachers_avatar_settings_check;
ALTER TABLE classroom.student_accounts DROP CONSTRAINT student_accounts_avatar_settings_check;
ALTER TABLE classroom.teachers ADD CONSTRAINT teachers_avatar_settings_check CHECK (COALESCE(
  avatar_settings->>'hairStyle' IN ('none','short','long','ponytail','bun','spiky','bob') AND
  avatar_settings->>'hatStyle' IN ('none','cap','beanie','wizard') AND
  avatar_settings->>'glassesStyle' IN ('none','round','square') AND
  avatar_settings->>'shoeStyle' IN ('none','sneakers','boots') AND
  avatar_settings->>'skinColor' ~ '^#[0-9a-fA-F]{6}$' AND avatar_settings->>'hairColor' ~ '^#[0-9a-fA-F]{6}$' AND
  avatar_settings->>'shirtColor' ~ '^#[0-9a-fA-F]{6}$' AND avatar_settings->>'trousersColor' ~ '^#[0-9a-fA-F]{6}$' AND
  avatar_settings->>'hatColor' ~ '^#[0-9a-fA-F]{6}$' AND avatar_settings->>'glassesColor' ~ '^#[0-9a-fA-F]{6}$' AND avatar_settings->>'shoeColor' ~ '^#[0-9a-fA-F]{6}$', FALSE));
ALTER TABLE classroom.student_accounts ADD CONSTRAINT student_accounts_avatar_settings_check CHECK (COALESCE(
  avatar_settings->>'hairStyle' IN ('none','short','long','ponytail','bun','spiky','bob') AND
  avatar_settings->>'hatStyle' IN ('none','cap','beanie','wizard') AND
  avatar_settings->>'glassesStyle' IN ('none','round','square') AND
  avatar_settings->>'shoeStyle' IN ('none','sneakers','boots') AND
  avatar_settings->>'skinColor' ~ '^#[0-9a-fA-F]{6}$' AND avatar_settings->>'hairColor' ~ '^#[0-9a-fA-F]{6}$' AND
  avatar_settings->>'shirtColor' ~ '^#[0-9a-fA-F]{6}$' AND avatar_settings->>'trousersColor' ~ '^#[0-9a-fA-F]{6}$' AND
  avatar_settings->>'hatColor' ~ '^#[0-9a-fA-F]{6}$' AND avatar_settings->>'glassesColor' ~ '^#[0-9a-fA-F]{6}$' AND avatar_settings->>'shoeColor' ~ '^#[0-9a-fA-F]{6}$', FALSE));
