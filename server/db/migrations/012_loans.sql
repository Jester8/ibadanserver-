-- Bank loans, selling land back to the city, and the bank's lien on a plot. Times are epoch milliseconds.
CREATE TABLE IF NOT EXISTS loans (
  id          SERIAL PRIMARY KEY,
  pid         TEXT NOT NULL,
  principal   INTEGER NOT NULL,                 -- what was borrowed
  unpaid      INTEGER NOT NULL,                 -- principal still unpaid
  interest    INTEGER NOT NULL DEFAULT 0,       -- interest and fees accrued and unpaid as of accrued_at
  accrued_at  DOUBLE PRECISION NOT NULL,        -- a whole minute
  taken_at    DOUBLE PRECISION NOT NULL,
  due_at      DOUBLE PRECISION NOT NULL,
  rate_bpm    INTEGER NOT NULL,
  late_fee    INTEGER NOT NULL DEFAULT 0,       -- 1 once the one-off late fee has been added
  status      TEXT NOT NULL DEFAULT 'active',   -- active | closed
  stage       TEXT NOT NULL DEFAULT 'active',   -- active | overdue | notice | seized
  notice_at   DOUBLE PRECISION,
  seized_plot TEXT,
  closed_at   DOUBLE PRECISION,
  closed_by   TEXT                              -- paid | sale | forgiven
);
CREATE UNIQUE INDEX IF NOT EXISTS loans_one_active ON loans (pid) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS loans_pid ON loans (pid, closed_at);

ALTER TABLE plots ADD COLUMN IF NOT EXISTS seized INTEGER NOT NULL DEFAULT 0;

-- A plot sold back to the city. Remembered so a device that still thinks it owns the plot cannot claim it again.
CREATE TABLE IF NOT EXISTS plot_releases (
  plot_id TEXT PRIMARY KEY,
  by_pid  TEXT NOT NULL,
  at      DOUBLE PRECISION NOT NULL
);
