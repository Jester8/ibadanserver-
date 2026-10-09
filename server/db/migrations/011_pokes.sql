-- Pokes and hits. Who may poke me is saved with the player; only hits are written down (they are the evidence for an "assault" report).
ALTER TABLE players ADD COLUMN IF NOT EXISTS poke_mode TEXT;              -- all | friends | off  (null = all)
CREATE TABLE IF NOT EXISTS pokes (
  id       SERIAL PRIMARY KEY,
  at       DOUBLE PRECISION NOT NULL,
  from_pid TEXT NOT NULL,
  to_pid   TEXT NOT NULL,
  kind     TEXT NOT NULL,                                                 -- hit (pokes are kept in memory only)
  room     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pokes_pair ON pokes (to_pid, from_pid, at);
