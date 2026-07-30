#!/usr/bin/env node
// Basic Memory spool drain. Ships each spooled capture to the cortex CLI:
//
//   <CORTEX_CLI_BIN or 'cortex'> memory write --file <spoolfile> --permalink <key> --json
//
// where <key> is the spool filename minus `.md` — the stable idempotency key
// the capture hook embedded (`capture-<session_id>-<ts>`), so retrying the
// same file always presents the same permalink and the backend can dedupe.
//
// Contract (deliberately boring — the next scheduled run is the retry loop):
//   - empty/missing spool ........ log one line, exit 0
//   - cortex binary missing ...... log one line, leave the spool intact, exit 0
//     (the OSS-default safe path: no CLI, no drain, no error)
//   - per-file success ........... delete that spool file, continue
//   - per-file failure ........... nonzero exit / 30s timeout: leave the file,
//     stop immediately, exit 1 (next scheduled run retries oldest-first)
//   - --dry-run .................. list what would flush, invoke nothing, exit 0
// Never throws unhandled. Never logs file contents (captures are redacted at
// write time, but they still never belong in a scheduler log).
//
// Stdlib only — no new deps.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PREFIX = "[basic-memory] flush:";
const log = (msg) => console.log(`${PREFIX} ${msg}`);

// 30s per file; env override exists for tests only. Timeout kills with
// SIGKILL — a CLI that traps/ignores SIGTERM (spawnSync's default) would
// otherwise block the drain until it felt like exiting.
const FLUSH_TIMEOUT_MS =
  Number(process.env.BASIC_MEMORY_FLUSH_TIMEOUT_MS || "") || 30_000;

function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const spoolDir = (process.env.BASIC_MEMORY_SPOOL_DIR || "").trim() ||
    path.join(os.homedir(), ".garrison", "cortex-memory", "spool");
  const bin = (process.env.CORTEX_CLI_BIN || "").trim() ||
    (process.env.BASIC_MEMORY_CORTEX_CLI_BIN || "").trim() || "cortex";

  let names;
  try {
    names = fs.readdirSync(spoolDir);
  } catch {
    log(`spool empty (${spoolDir} not present); nothing to do`);
    return 0;
  }

  // Only the hook's finished captures — write-then-rename means a `.tmp` (or
  // any foreign file) is never a drain candidate. Oldest first (mtime, then
  // name) so the backlog drains in capture order.
  const files = [];
  for (const name of names) {
    if (!/^capture-.+\.md$/.test(name)) continue;
    const full = path.join(spoolDir, name);
    try {
      const st = fs.statSync(full);
      if (st.isFile()) files.push({ name, full, mtime: st.mtimeMs });
    } catch {
      // raced away — someone else's problem
    }
  }
  files.sort((a, b) => a.mtime - b.mtime || (a.name < b.name ? -1 : 1));

  if (files.length === 0) {
    log("spool empty; nothing to do");
    return 0;
  }

  if (dryRun) {
    for (const f of files) {
      log(`would flush ${f.name} -> permalink ${f.name.replace(/\.md$/, "")}`);
    }
    log(`dry run: ${files.length} capture(s) pending`);
    return 0;
  }

  let flushed = 0;
  for (const f of files) {
    const key = f.name.replace(/\.md$/, "");
    const res = spawnSync(
      bin,
      ["memory", "write", "--file", f.full, "--permalink", key, "--json"],
      {
        timeout: FLUSH_TIMEOUT_MS,
        killSignal: "SIGKILL",
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    if (res.error && res.error.code === "ENOENT") {
      // No cortex CLI on this machine: not an error, just nothing to drain
      // into yet. Leave everything for a future run.
      log(`cortex CLI not found ('${bin}'); leaving ${files.length - flushed} capture(s) spooled`);
      return 0;
    }
    if (res.error || res.status !== 0) {
      const why = res.error?.code === "ETIMEDOUT"
        ? `timeout after ${FLUSH_TIMEOUT_MS}ms`
        : res.error
          ? `spawn error ${res.error.code || res.error.message}`
          : `exit ${res.status}`;
      log(`write failed for ${f.name} (${why}); stopping — next scheduled run retries`);
      return 1;
    }
    try {
      fs.unlinkSync(f.full);
    } catch {
      // Deletion failing after a successful write is survivable: the stable
      // permalink makes the inevitable re-flush idempotent.
    }
    flushed += 1;
  }
  log(`flushed ${flushed} capture(s)`);
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  console.error(`${PREFIX} unexpected error: ${err?.message || err}`);
  process.exit(1);
}
