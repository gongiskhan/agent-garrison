// DB open + pragmas + migration runner for the Garrison state service.
//
// The DB lives at ~/.garrison-state/garrison.db — deliberately NOT under
// ~/.garrison, which is a per-profile home that instances rotate and tests
// redirect via GARRISON_HOME. The mesh's single source of truth must not be
// reachable through an env var half the codebase overrides. Tests point
// GARRISON_STATE_DB at a temp file instead.

import Database from "better-sqlite3";
import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, "..", "migrations");

export function defaultDbPath() {
  return path.join(os.homedir(), ".garrison-state", "garrison.db");
}

export function resolveDbPath() {
  return process.env.GARRISON_STATE_DB?.trim() || defaultDbPath();
}

export function listMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}-.*\.sql$/.test(f))
    .sort();
}

// The binary's schema version IS the number of migration files it ships.
export function binarySchemaVersion() {
  return listMigrations().length;
}

export function openDb(dbPath = resolveDbPath()) {
  mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function appliedVersion(db) {
  const hasMeta = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'")
    .get();
  if (!hasMeta) return 0;
  const row = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get();
  return row ? Number(row.value) : 0;
}

export function migrate(db) {
  const migrations = listMigrations();
  const target = migrations.length;
  const current = appliedVersion(db);

  // A DB written by a NEWER binary is a data-loss cliff for this one. Refuse
  // loudly; never best-effort read a schema we do not understand.
  if (current > target) {
    throw new Error(
      `state db schema version ${current} is newer than this binary's ${target} — ` +
        `deploy a matching or newer service build; refusing to start`
    );
  }

  for (let v = current; v < target; v++) {
    const file = migrations[v];
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare(
        "INSERT INTO schema_meta(key, value) VALUES ('schema_version', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(String(v + 1));
    });
    apply();
  }

  // Stamp mesh identity once.
  db.prepare(
    "INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('mesh_id', ?)"
  ).run(`mesh-${Math.random().toString(36).slice(2, 10)}`);
  db.prepare(
    "INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('created_at', ?)"
  ).run(new Date().toISOString());
}

export function schemaMeta(db) {
  const rows = db.prepare("SELECT key, value FROM schema_meta").all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
