#!/usr/bin/env node
// State DB backups — S13. Two layers:
//   (a) service-local WAL-safe snapshots via VACUUM INTO (hourly keep 24,
//       daily keep 30), run from the unit's timer or --once;
//   (b) off-box shipping of the newest daily snapshot to a peer node
//       (scripts/ship-backup.sh) — durability never has a single home even
//       when state does.
// The snapshot is the encrypted-at-rest DB: the master key stays in this
// machine's keychain, so a shipped snapshot alone cannot decrypt secrets.

import Database from "better-sqlite3";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveDbPath } from "../src/db.mjs";

const stateHome = process.env.GARRISON_STATE_HOME?.trim() || path.join(os.homedir(), ".garrison-state");
const backupsDir = path.join(stateHome, "backups");
mkdirSync(backupsDir, { recursive: true, mode: 0o700 });

const nowIso = new Date().toISOString().replace(/[:.]/g, "-");
const kind = process.argv.includes("--daily") ? "daily" : "hourly";
const dest = path.join(backupsDir, `garrison-${kind}-${nowIso}.db`);

const db = new Database(resolveDbPath(), { readonly: false });
db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
db.close();
console.log(`[backup] ${dest}`);

// Prune: hourly keep 24, daily keep 30.
const keep = { hourly: 24, daily: 30 };
for (const k of Object.keys(keep)) {
  const files = readdirSync(backupsDir)
    .filter((f) => f.startsWith(`garrison-${k}-`) && f.endsWith(".db"))
    .map((f) => ({ f, t: statSync(path.join(backupsDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(keep[k])) {
    unlinkSync(path.join(backupsDir, f));
  }
}
