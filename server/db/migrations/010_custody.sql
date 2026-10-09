-- Police and EFCC cases, and who is in custody. Times are epoch milliseconds.
CREATE TABLE IF NOT EXISTS cases (
  id            SERIAL PRIMARY KEY,
  kind          TEXT NOT NULL,              -- police | efcc
  reason        TEXT NOT NULL,              -- loitering | disturbance | assault | harassment | scam | fraud
  reporter      TEXT NOT NULL,
  accused       TEXT NOT NULL,
  pair          TEXT NOT NULL,              -- the two pids sorted and joined with '|' (one open case per pair)
  reporter_name TEXT NOT NULL,
  accused_name  TEXT NOT NULL,
  status        TEXT NOT NULL,              -- filed | held | bailed | served | settled | withdrawn | expired | merged | dismissed
  via           TEXT NOT NULL DEFAULT 'player',   -- player | chat | counter | bank | poke
  filed_at      DOUBLE PRECISION NOT NULL,
  confirm_by    DOUBLE PRECISION NOT NULL,        -- a filed case lapses after this
  held_at       DOUBLE PRECISION,
  release_at    DOUBLE PRECISION,                 -- the stay can never run past this
  closed_at     DOUBLE PRECISION,
  bail          INTEGER NOT NULL,
  fine          INTEGER NOT NULL DEFAULT 0,
  fee           INTEGER NOT NULL,
  fee_state     TEXT NOT NULL DEFAULT 'paid',     -- paid | refunded | kept
  prior         INTEGER NOT NULL DEFAULT 0,       -- accused's holds in the previous 24 h when filed
  disputed      INTEGER NOT NULL DEFAULT 0,       -- EFCC: naira in dispute
  retaliation   INTEGER NOT NULL DEFAULT 0,
  cell          INTEGER,
  paid_by       TEXT,
  paid_amount   INTEGER,
  asked_at      DOUBLE PRECISION,
  asks          INTEGER NOT NULL DEFAULT 0,
  merged_into   INTEGER,
  evidence_json TEXT,                              -- server-derived; shown only to the reporter and moderators
  note          TEXT
);
CREATE INDEX IF NOT EXISTS cases_accused  ON cases (accused, status);
CREATE INDEX IF NOT EXISTS cases_reporter ON cases (reporter, filed_at);
CREATE INDEX IF NOT EXISTS cases_open     ON cases (status, release_at);
-- database-level guarantees (race-safe): one held case per accused, one open case per pair
CREATE UNIQUE INDEX IF NOT EXISTS cases_one_held      ON cases (accused) WHERE status = 'held';
CREATE UNIQUE INDEX IF NOT EXISTS cases_one_open_pair ON cases (pair)    WHERE status IN ('filed', 'held');

ALTER TABLE players ADD COLUMN IF NOT EXISTS police_ban_until DOUBLE PRECISION;  -- reporting suspended until
ALTER TABLE players ADD COLUMN IF NOT EXISTS watch_until      DOUBLE PRECISION;  -- EFCC account watch until
