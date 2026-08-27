#!/usr/bin/env node
// Basic Memory spool drain. Ships each spooled capture to a remote memory CLI (any provider implementing the capability contract; the reference implementation is the `cortex` binary, which is the default):
//
//   <REMOTE_MEMORY_CLI_BIN or 'cortex'> memory write --file <spoolfile> --permalink <key> --json
//
// WHERE <key> COMES FROM, and why it is no longer just the filename:
//
//   1. `<spoolfile minus .md>.notepath`, the identity sidecar the capture hook
//      writes beside each capture, holding the VAULT-RELATIVE PATH of the note
//      the capture is a copy of. This drain derives the permalink from that
//      path with `permalinkForRelPath` from ./lib/memory-vault.mjs - THE SAME
//      MODULE compare-backends.mjs uses - so the note the shadow ships and the
//      note the comparator looks for are one note BY CONSTRUCTION, rather than
//      by two implementations of one mapping happening to agree.
//
//      Before this the drain shipped `capture-<sid>-<ts>-<pid>` - a QUEUE KEY,
//      not a note identity - while the comparator listed one folder of
//      `<folder>/<slug>` permalinks. The two never met: a perfectly working
//      shadow could not show parity, a broken drain looked identical to a
//      working one, and a re-import stored the same bytes twice under two
//      identities (the G4 review's F1).
//   2. Only when no usable sidecar is present - a capture spooled by an older
//      hook - the filename minus `.md`, the historical behaviour and still a
//      stable idempotency key. That fallback is LOGGED, because such a note
//      lands outside every folder the comparator lists and is never reconciled.
//
// Either way the key is stable for a given spool file, so retrying the same
// file always presents the same permalink and the backend overwrites rather
// than duplicating. EVERY flush logs the permalink it used: nothing binds a
// sidecar to the capture beside it, so the log is the only trail of where a
// given capture actually went.
//
// Contract (deliberately boring - the next scheduled run is the retry loop):
//   - empty/missing spool ........ log one line, exit 0
//   - CLI binary missing ...... log one line, leave the spool intact, exit 0
//     (the OSS-default safe path: no CLI, no drain, no error)
//   - per-file success ........... delete that spool file, continue
//   - per-file failure ........... nonzero exit / 30s timeout: leave the file,
//     stop immediately, exit 1 (next scheduled run retries oldest-first)
//   - --dry-run .................. list what would flush, invoke nothing, exit 0
// Never throws unhandled. Never logs file contents (captures are redacted at
// write time, but they still never belong in a scheduler log).
//
// Stdlib only - no new deps. The one local import is the shared permalink
// mapping, so that mapping exists exactly once.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PREFIX = "[basic-memory] flush:";
const log = (msg) => console.log(`${PREFIX} ${msg}`);

/**
 * The shared mapping module, loaded dynamically so a stale install that has the
 * drain but not the lib degrades to the queue-key fallback (loudly) instead of
 * dying at module load and never draining anything. setup.sh stages both
 * together, so this is belt-and-braces.
 */
async function loadMapping() {
  let m;
  try {
    m = await import(new URL("./lib/memory-vault.mjs", import.meta.url).href);
  } catch {
    return null; // absent or un-importable: degrade to the queue-key fallback
  }
  // A STALE lib is the dangerous shape: it imports cleanly and then throws on a
  // function it does not export yet, so the drain dies instead of degrading and
  // captures pile up until the cap evicts them. Shape-check so stale routes
  // exactly like missing - which is what this function already claimed to do.
  const usable =
    typeof m?.permalinkForRelPath === "function" &&
    typeof m?.resolveRemoteFolder === "function";
  return usable ? m : null;
}

// 30s per file; env override exists for tests only. Timeout kills with
// SIGKILL - a CLI that traps/ignores SIGTERM (spawnSync's default) would
// otherwise block the drain until it felt like exiting.
const FLUSH_TIMEOUT_MS =
  Number(process.env.BASIC_MEMORY_FLUSH_TIMEOUT_MS || "") || 30_000;

const SIDECAR_SUFFIX = ".notepath";
/** A vault-relative markdown path - the only sidecar content this drain acts on. */
const NOTE_PATH_RE = /^[^/\\][^\r\n]*\.md$/i;

/**
 * How recent a sidecar has to be before the orphan sweep leaves it alone.
 *
 * The hook writes the sidecar and THEN the capture, so between those two
 * renames a sidecar legitimately has no `.md` beside it. A drain firing in that
 * window used to sweep the in-flight sidecar, and the capture then shipped
 * under the bare queue key - permanently unreconcilable, and with the daily job
 * running --fail-on-diff, a permanently red gate. Drains are spawned detached
 * by EVERY hook and every 15 minutes, so two near-simultaneous session ends were
 * enough. Nothing is lost by waiting: an orphan is a few dozen bytes.
 */
const SIDECAR_GRACE_MS =
  Number(process.env.BASIC_MEMORY_SIDECAR_GRACE_MS || "") || 120_000;

const sidecarPath = (spoolDir, name) =>
  path.join(spoolDir, name.replace(/\.md$/, SIDECAR_SUFFIX));

/**
 * The note identity for a spool file: derived from the sidecar's vault path
 * through the SHARED mapping when both are available, otherwise the historical
 * queue key. Returns the reason too, so the caller can say out loud when a
 * capture is going out under a key nothing will reconcile.
 */
function permalinkFor(spoolDir, name, mapping, folder) {
  const fallback = name.replace(/\.md$/, "");
  let raw;
  try {
    raw = fs.readFileSync(sidecarPath(spoolDir, name), "utf8").trim();
  } catch {
    return { key: fallback, source: "queue-key" };
  }
  if (!NOTE_PATH_RE.test(raw)) return { key: fallback, source: "malformed-sidecar" };
  if (!mapping) return { key: fallback, source: "mapping-module-missing" };
  return { key: mapping.permalinkForRelPath(raw, folder), source: "sidecar", relPath: raw };
}

/**
 * Sidecars whose capture is gone (a partial write, an out-of-band delete) AND
 * which are old enough that no hook can still be mid-write. Tiny, ours by name,
 * and meaningless without the capture they describe.
 */
function sweepOrphanSidecars(spoolDir, names, notAfterMs) {
  let swept = 0;
  for (const name of names) {
    if (!new RegExp(`^capture-.+\\${SIDECAR_SUFFIX}$`).test(name)) continue;
    const full = path.join(spoolDir, name);
    const capture = path.join(spoolDir, name.replace(new RegExp(`\\${SIDECAR_SUFFIX}$`), ".md"));
    if (fs.existsSync(capture)) continue;
    try {
      if (fs.statSync(full).mtimeMs > notAfterMs) continue; // still possibly in flight
      fs.unlinkSync(full);
      swept += 1;
    } catch {
      // not ours to worry about
    }
  }
  return swept;
}

async function main() {
  // Captured BEFORE any work: a sidecar that appeared after this drain started
  // belongs to a hook that is still running, whatever the wall clock says.
  const startedAtMs = Date.now();
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const spoolDir = (process.env.BASIC_MEMORY_SPOOL_DIR || "").trim() ||
    path.join(os.homedir(), ".garrison", "memory-spool");
  const bin = (process.env.REMOTE_MEMORY_CLI_BIN || "").trim() ||
    (process.env.BASIC_MEMORY_REMOTE_CLI_BIN || "").trim() || "cortex";
  const mapping = await loadMapping();
  // Resolved at DRAIN time, not capture time: the comparator lists whatever
  // folder is configured now, so that is the folder a capture must land in.
  const folderRaw = (process.env.BASIC_MEMORY_REMOTE_FOLDER || "").trim() || "vault";
  const folder = mapping?.resolveRemoteFolder(folderRaw)?.folder || "vault";

  let names;
  try {
    names = fs.readdirSync(spoolDir);
  } catch {
    log(`spool empty (${spoolDir} not present); nothing to do`);
    return 0;
  }

  // Only the hook's finished captures - write-then-rename means a `.tmp` (or
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
      // raced away - someone else's problem
    }
  }
  files.sort((a, b) => a.mtime - b.mtime || (a.name < b.name ? -1 : 1));

  if (files.length === 0) {
    log("spool empty; nothing to do");
    return 0;
  }

  if (dryRun) {
    for (const f of files) {
      log(`would flush ${f.name} -> permalink ${permalinkFor(spoolDir, f.name, mapping, folder).key}`);
    }
    log(`dry run: ${files.length} capture(s) pending`);
    return 0;
  }

  let flushed = 0;
  for (const f of files) {
    const { key, source } = permalinkFor(spoolDir, f.name, mapping, folder);
    if (source !== "sidecar") {
      // Loud, because the consequence is invisible otherwise: this note lands
      // under a bare queue key, outside every folder the comparator lists, and
      // will show up forever as "missing on the remote".
      log(`${f.name}: no usable identity sidecar (${source}); shipping under the queue key '${key}' - it will NOT be reconciled by compare-backends.mjs`);
    }
    // EVERY flush, not just the odd ones. A sidecar is an unauthenticated file
    // in a user-owned directory: nothing binds it to the capture beside it, so
    // if one ever names the wrong note, this line is the only record of where
    // the capture actually went.
    log(`${f.name} -> ${key}`);
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
      // No remote memory CLI on this machine: not an error, just nothing to drain
      // into yet. Leave everything for a future run.
      log(`remote memory CLI not found ('${bin}'); leaving ${files.length - flushed} capture(s) spooled`);
      return 0;
    }
    if (res.error || res.status !== 0) {
      const why = res.error?.code === "ETIMEDOUT"
        ? `timeout after ${FLUSH_TIMEOUT_MS}ms`
        : res.error
          ? `spawn error ${res.error.code || res.error.message}`
          : `exit ${res.status}`;
      log(`write failed for ${f.name} (${why}); stopping - next scheduled run retries`);
      return 1;
    }
    try {
      fs.unlinkSync(f.full);
    } catch {
      // Deletion failing after a successful write is survivable: the stable
      // permalink makes the inevitable re-flush idempotent.
    }
    try {
      fs.unlinkSync(sidecarPath(spoolDir, f.name));
    } catch {
      // Swept on the next run if it survived its capture.
    }
    flushed += 1;
  }
  let after = [];
  try {
    after = fs.readdirSync(spoolDir);
  } catch {
    after = [];
  }
  // Only sidecars older than BOTH this drain's start and the grace window: any
  // newer one may belong to a hook still between its two renames.
  const swept = sweepOrphanSidecars(
    spoolDir,
    after,
    Math.min(startedAtMs, Date.now() - SIDECAR_GRACE_MS)
  );
  log(`flushed ${flushed} capture(s)${swept ? ` (swept ${swept} orphan sidecar(s))` : ""}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`${PREFIX} unexpected error: ${err?.message || err}`);
    process.exit(1);
  });
