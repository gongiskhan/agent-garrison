-- Cards: promoted columns for what is queried/ordered/constrained; everything
-- else rides verbatim in body_json (card.json has ~50 fields and gains more
-- most months — a column per field would be a migration per cosmetic change).
--
-- Invariants enforced server-side, not by discipline:
--   * rev bumps on every write (the CAS); a stale If-Match is a 409.
--   * coordination_seq is a monotonic floor (MAX(current, requested)) — a
--     stale client can never rewind a lifecycle generation.
--   * No resurrection: PATCH never upserts; a deleted row is 404 for writes.
--   * occurrence_key UNIQUE — "scheduled work runs exactly once" as a DB
--     constraint, not a convention.
--   * Unparseable scheduled_for is a 422 at write (fail closed at the door).

CREATE TABLE cards (
  id                   TEXT PRIMARY KEY,
  list                 TEXT NOT NULL,
  position             REAL,
  status               TEXT NOT NULL DEFAULT '',
  title                TEXT NOT NULL DEFAULT '',
  project              TEXT,
  scope                TEXT NOT NULL DEFAULT 'default',
  rev                  INTEGER NOT NULL DEFAULT 0,
  coordination_seq     INTEGER NOT NULL DEFAULT 0,
  placement_target     TEXT,
  placement_not_before TEXT,
  scheduled_for        TEXT,
  schedule_json        TEXT,
  occurrence_key       TEXT,
  system_key           TEXT,
  origin_id            TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  updated_by           TEXT NOT NULL,
  deleted_at           TEXT,
  body_json            TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_cards_list ON cards(list, position) WHERE deleted_at IS NULL;
CREATE INDEX idx_cards_sched ON cards(scheduled_for)
  WHERE scheduled_for IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_cards_placement ON cards(placement_target)
  WHERE placement_target IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX idx_cards_occurrence ON cards(occurrence_key)
  WHERE occurrence_key IS NOT NULL;
CREATE INDEX idx_cards_system ON cards(system_key) WHERE system_key IS NOT NULL;

-- Card side documents. brief.md (authored input), handoff.json (read by the
-- successor card, possibly elsewhere), and the FINAL text of each log-N.md.
-- The LIVE log stream stays a node-local file (the board rewrites the whole
-- file per chunk — a write storm over HTTP); watch-on-a-peer proxies to the
-- home node.
CREATE TABLE card_docs (
  card_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  body       TEXT NOT NULL,
  rev        INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (card_id, name)
);

-- Attachments: metadata rows only. The bytes stay on the home node's disk
-- (arbitrary binaries would balloon the DB and every hourly backup).
CREATE TABLE card_attachments (
  card_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  bytes      INTEGER NOT NULL DEFAULT 0,
  sha256     TEXT,
  home_node  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (card_id, name)
);
