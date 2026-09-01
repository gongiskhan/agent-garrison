// The one database handle for this service.
//
// Anything that persists goes through here: openDb() for the connection and
// withTx() for anything that writes more than one row. A second handle opened
// elsewhere gets its own WAL view and its own idea of what a transaction is,
// which is how a service starts losing writes under concurrency.

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { load } from "./settings.js";

let handle = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit (
  id         TEXT PRIMARY KEY,
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);
`;

export function openDb() {
  if (handle) return handle;
  const { dbFile } = load();
  fs.mkdirSync(path.dirname(path.resolve(dbFile)), { recursive: true });
  handle = new Database(dbFile);
  handle.pragma("journal_mode = WAL");
  handle.pragma("foreign_keys = ON");
  handle.exec(SCHEMA);
  return handle;
}

/** Run fn inside a transaction. Rolls back whole if fn throws. */
export function withTx(fn) {
  const db = openDb();
  return db.transaction(fn)();
}

/** Test seam: drop the memoised handle so the next openDb() reopens. */
export function closeDb() {
  if (handle) handle.close();
  handle = null;
}
