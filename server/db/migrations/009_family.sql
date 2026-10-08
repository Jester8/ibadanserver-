-- Family links between two players. A new player has none: one asks a friend to be their dad, mum or sibling and the friend has to accept.
CREATE TABLE IF NOT EXISTS family (
  a          TEXT NOT NULL,
  b          TEXT NOT NULL,
  requester  TEXT NOT NULL,
  role       TEXT NOT NULL,            -- what the person asked is to the requester: dad | mum | sibling
  status     TEXT NOT NULL,            -- pending | accepted
  created_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (a, b)
);
CREATE INDEX IF NOT EXISTS family_b ON family (b);
