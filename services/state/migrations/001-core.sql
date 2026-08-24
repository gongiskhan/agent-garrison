-- Garrison state service — core schema.
-- Conventions: rev INTEGER for CAS, timestamps ISO-8601 UTC text,
-- updated_by = node name. Every write appends to `changes` in the same
-- transaction (enforced in code; `changes` is the ordering spine, the change
-- feed, and the event substrate).

CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE changes (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  entity       TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  op           TEXT NOT NULL,
  node         TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_changes_entity ON changes(entity, seq);

-- Node registry. Replaces ~/.garrison/outpost-registry.json. The token alone
-- is the identity; a caller-supplied name is never trusted. Tokens stored as
-- sha256 hex, never cleartext. "host" is rejected as a name forever (it meant
-- "the box Garrison runs on", which has no referent on a mesh).
CREATE TABLE nodes (
  name             TEXT PRIMARY KEY,
  token_hash       TEXT NOT NULL UNIQUE,
  token_prefix     TEXT NOT NULL,
  accent_color     TEXT NOT NULL DEFAULT '#6b7f6e',
  tailnet_host     TEXT,
  tailnet_ip       TEXT,
  platform         TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  schema_version   INTEGER,
  client_version   TEXT,
  active_composition TEXT,
  status           TEXT NOT NULL DEFAULT 'active',
  health_json      TEXT NOT NULL DEFAULT '{}',
  registered_at    TEXT NOT NULL,
  last_seen_at     TEXT,
  rev              INTEGER NOT NULL DEFAULT 0
);

-- Config documents: JSON per namespace and scope.
-- scope: 'global' | 'node:<name>' | 'composition:<id>'
CREATE TABLE config_docs (
  namespace  TEXT NOT NULL,
  scope      TEXT NOT NULL,
  body_json  TEXT NOT NULL,
  body_sha   TEXT NOT NULL,
  rev        INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (namespace, scope)
);
CREATE TABLE config_doc_history (
  namespace  TEXT NOT NULL,
  scope      TEXT NOT NULL,
  rev        INTEGER NOT NULL,
  body_json  TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (namespace, scope, rev)
);

-- Leases: TTL + heartbeat + monotonic fence. NO pid liveness anywhere — a pid
-- means nothing on another host. The fence is the half a TTL cannot buy: a
-- stalled holder waking past expiry carries a lower fence and is refused.
CREATE TABLE leases (
  key          TEXT PRIMARY KEY,
  holder       TEXT NOT NULL,
  holder_token TEXT NOT NULL,
  acquired_at  TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  fence        INTEGER NOT NULL,
  meta_json    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_leases_expiry ON leases(expires_at);
-- Monotonic fence source shared across all lease keys.
CREATE TABLE lease_fence (id INTEGER PRIMARY KEY CHECK (id = 1), next INTEGER NOT NULL);
INSERT INTO lease_fence (id, next) VALUES (1, 1);

-- Events / origins / notifications. Append-only BY ABSENCE OF VERB: the API
-- exposes no UPDATE or DELETE for events. Retention is a bounded age-prune run
-- by the service itself.
CREATE TABLE events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  kind         TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  origin_id    TEXT,
  node         TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_events_origin ON events(origin_id, seq);
CREATE INDEX idx_events_kind ON events(kind, seq);

CREATE TABLE origins (
  origin_id  TEXT PRIMARY KEY,
  transport  TEXT NOT NULL,
  address    TEXT,
  home_node  TEXT NOT NULL,
  body_json  TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE notifications (
  id             TEXT PRIMARY KEY,
  event_seq      INTEGER REFERENCES events(seq),
  origin_id      TEXT,
  node           TEXT NOT NULL,          -- the node that must deliver (origin home node)
  kind           TEXT NOT NULL,
  body_json      TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  delivered_at   TEXT,
  delivered_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_notifications_pending ON notifications(node) WHERE delivered_at IS NULL;

-- Session registry: METADATA ONLY. Transcripts, session-log JSONL, and ring
-- buffers stay on the home node. control_url is what a peer UI proxies to.
-- Permission decisions are NEVER stored here (process-local by design).
CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  home_node      TEXT NOT NULL,
  card_id        TEXT,
  thread_id      TEXT,
  composition_id TEXT,
  runtime        TEXT,
  model          TEXT,
  account        TEXT,
  cwd            TEXT,
  status         TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  last_seen_at   TEXT NOT NULL,
  control_url    TEXT,
  body_json      TEXT NOT NULL DEFAULT '{}',
  rev            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sessions_home ON sessions(home_node, status);
CREATE INDEX idx_sessions_cwd ON sessions(cwd) WHERE ended_at IS NULL;

-- Secrets: dev-madrid is the authority. AES-256-GCM per row, key HKDF-derived
-- from the machine master key + per-row salt. Grants are fail-closed patterns.
-- A failed audit write FAILS THE READ.
CREATE TABLE secrets (
  key        TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,      -- JSON {salt, iv, tag, ct} base64
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  rev        INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE secret_grants (
  node    TEXT NOT NULL,
  pattern TEXT NOT NULL,
  PRIMARY KEY (node, pattern)
);
CREATE TABLE secret_reads (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL,
  node      TEXT NOT NULL,
  keys_json TEXT NOT NULL,
  action    TEXT NOT NULL,
  outcome   TEXT NOT NULL,
  detail    TEXT
);

-- Compositions: the DB is the source of truth; nodes materialise working
-- trees. Files are guarded by the composition-transfer allow-list predicate.
CREATE TABLE compositions (
  id            TEXT PRIMARY KEY,
  manifest_yaml TEXT NOT NULL,
  manifest_sha  TEXT NOT NULL,
  rev           INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  updated_by    TEXT NOT NULL,
  archived_at   TEXT
);
CREATE TABLE composition_files (
  composition_id TEXT NOT NULL,
  path           TEXT NOT NULL,
  body           TEXT NOT NULL,
  rev            INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL,
  updated_by     TEXT NOT NULL,
  PRIMARY KEY (composition_id, path)
);

-- Scheduler: structured jobs, never baked shell strings for shared targets.
-- target: 'node:<name>' | 'any' | 'all'. A {kind:"shell"} spec with a
-- non-node-local target is rejected at write.
CREATE TABLE scheduler_jobs (
  id            TEXT PRIMARY KEY,
  cron          TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'cron',
  enabled       INTEGER NOT NULL DEFAULT 1,
  target        TEXT NOT NULL,
  spec_json     TEXT NOT NULL,
  description   TEXT,
  registered_by TEXT NOT NULL,
  rev           INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  updated_by    TEXT NOT NULL
);
CREATE TABLE scheduler_runs (
  job_id     TEXT NOT NULL,
  occurrence TEXT NOT NULL,
  node       TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  exit       INTEGER,
  PRIMARY KEY (job_id, occurrence, node)
);

-- Coordination: plan ledger + intents (append + set-once release; no DELETE
-- verb). Planning locks are leases with key 'plan:<repoKey>'.
CREATE TABLE plans (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_key     TEXT NOT NULL,
  session      TEXT NOT NULL,
  at           TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_plans_repo ON plans(repo_key, seq);

CREATE TABLE intents (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_key    TEXT NOT NULL,
  session     TEXT NOT NULL,
  area        TEXT,
  files_json  TEXT NOT NULL DEFAULT '[]',
  reason      TEXT NOT NULL,
  at          TEXT NOT NULL,
  released_at TEXT
);
CREATE INDEX idx_intents_open ON intents(repo_key) WHERE released_at IS NULL;

-- Improver feedback: two append-only tables. No UPDATE or DELETE verb exists
-- in the API for either; the reader joins and drops tombstoned rows.
CREATE TABLE feedback_queue (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  at           TEXT NOT NULL,
  node         TEXT NOT NULL,
  kind         TEXT,
  area         TEXT,
  session_id   TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  legacy_key   TEXT
);
CREATE TABLE feedback_tombstones (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL,
  at     TEXT NOT NULL,
  node   TEXT NOT NULL,
  reason TEXT
);

-- Paymaster: append-heavy usage ledger, read as an aggregate. Rotation across
-- four nodes only means something when consumption lands in ONE ledger.
CREATE TABLE paymaster_usage (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  node         TEXT NOT NULL,
  account      TEXT NOT NULL,
  platform     TEXT,
  tokens_json  TEXT NOT NULL DEFAULT '{}',
  headers_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_paymaster_account ON paymaster_usage(account, seq);
