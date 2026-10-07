ALTER TABLE players ADD COLUMN IF NOT EXISTS username TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS players_username ON players (LOWER(username)) WHERE username IS NOT NULL;
