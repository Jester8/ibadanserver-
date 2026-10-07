CREATE TABLE IF NOT EXISTS transfers (
  id         SERIAL PRIMARY KEY,
  from_pid   TEXT NOT NULL,
  to_pid     TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  at         DOUBLE PRECISION NOT NULL,
  claimed    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS transfers_to ON transfers (to_pid, claimed);
CREATE INDEX IF NOT EXISTS transfers_from ON transfers (from_pid, at);
