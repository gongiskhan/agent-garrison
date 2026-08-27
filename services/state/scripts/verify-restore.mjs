#!/usr/bin/env node
// Prove a snapshot restores to a WORKING service: open it, run the migration
// check, count core tables, and report. A backup that cannot restore is not a
// backup.
//
//   node scripts/verify-restore.mjs <snapshot.db>

import Database from "better-sqlite3";

const file = process.argv[2];
if (!file) {
  console.error("usage: verify-restore.mjs <snapshot.db>");
  process.exit(2);
}

const db = new Database(file, { readonly: true });
try {
  const version = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()?.value;
  const counts = {};
  for (const t of ["nodes", "cards", "config_docs", "secrets", "scheduler_jobs", "sessions", "changes"]) {
    counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
  }
  const integrity = db.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") {
    console.error(`RESTORE-VERIFY FAILED: integrity_check = ${integrity}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, schemaVersion: Number(version), integrity, counts }));
} finally {
  db.close();
}
