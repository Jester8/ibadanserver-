-- Omo Ibadan schema (PostgreSQL). Epoch times are milliseconds stored as DOUBLE PRECISION.

CREATE TABLE IF NOT EXISTS players (
  pid            TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  created_at     DOUBLE PRECISION NOT NULL,
  last_seen      DOUBLE PRECISION NOT NULL,
  state_json     TEXT,
  state_updated  DOUBLE PRECISION,
  email          TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  profile_json   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS players_email ON players (email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS plots (
  plot_id      TEXT PRIMARY KEY,
  owner_pid    TEXT NOT NULL,
  owner_name   TEXT NOT NULL,
  tier         INTEGER NOT NULL DEFAULT 0,
  collected_at DOUBLE PRECISION NOT NULL,
  decor_json   TEXT
);
CREATE INDEX IF NOT EXISTS plots_owner ON plots (owner_pid);

CREATE TABLE IF NOT EXISTS reports (
  id       SERIAL PRIMARY KEY,
  at       DOUBLE PRECISION NOT NULL,
  reporter TEXT NOT NULL,
  target   TEXT NOT NULL,
  reason   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS elections (
  term        INTEGER PRIMARY KEY,
  winner_pid  TEXT,
  winner_name TEXT,
  slogan      TEXT,
  votes       INTEGER NOT NULL DEFAULT 0,
  ended_at    DOUBLE PRECISION NOT NULL
);

-- Artist music. The artist keeps the copyright; the game only streams it with their permission.
CREATE TABLE IF NOT EXISTS tracks (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  artist           TEXT NOT NULL,
  owner_pid        TEXT NOT NULL,
  rights_holder    TEXT NOT NULL,
  rights_statement TEXT NOT NULL,
  license          TEXT NOT NULL DEFAULT 'artist-retains-copyright',
  status           TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  mime             TEXT,
  size             INTEGER,
  file             TEXT,
  created_at       DOUBLE PRECISION NOT NULL,
  reviewed_at      DOUBLE PRECISION,
  review_note      TEXT
);
CREATE INDEX IF NOT EXISTS tracks_status ON tracks (status);
CREATE INDEX IF NOT EXISTS tracks_owner ON tracks (owner_pid);

-- Emailed one-time codes.
CREATE TABLE IF NOT EXISTS auth_codes (
  email        TEXT PRIMARY KEY,
  code_hash    TEXT NOT NULL,
  expires_at   DOUBLE PRECISION NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  sent_at      DOUBLE PRECISION NOT NULL,
  sends_window INTEGER NOT NULL DEFAULT 1,
  window_start DOUBLE PRECISION NOT NULL
);

-- a < b always, so a pair has exactly one row
CREATE TABLE IF NOT EXISTS friendships (
  a          TEXT NOT NULL,
  b          TEXT NOT NULL,
  requester  TEXT NOT NULL,
  status     TEXT NOT NULL,            -- pending | accepted
  created_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (a, b)
);
CREATE INDEX IF NOT EXISTS friendships_b ON friendships (b);

CREATE TABLE IF NOT EXISTS blocks (
  blocker TEXT NOT NULL,
  blocked TEXT NOT NULL,
  at      DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (blocker, blocked)
);

CREATE TABLE IF NOT EXISTS dms (
  id       SERIAL PRIMARY KEY,
  from_pid TEXT NOT NULL,
  to_pid   TEXT NOT NULL,
  text     TEXT NOT NULL,
  at       DOUBLE PRECISION NOT NULL,
  read_at  DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS dms_pair ON dms (from_pid, to_pid, at);
CREATE INDEX IF NOT EXISTS dms_unread ON dms (to_pid, read_at);

CREATE TABLE IF NOT EXISTS room_messages (
  id        SERIAL PRIMARY KEY,
  room      TEXT NOT NULL,
  from_pid  TEXT NOT NULL,
  from_name TEXT NOT NULL,
  text      TEXT NOT NULL,
  at        DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS room_messages_room ON room_messages (room, at);
