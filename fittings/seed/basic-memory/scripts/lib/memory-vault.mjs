// Shared helpers for the basic-memory migration scripts (import-vault.mjs and
// compare-backends.mjs). Stdlib only - no new deps, and nothing here talks to
// the network by itself: every remote call goes through the capability CLI.
//
// TWO RULES THIS MODULE EXISTS TO KEEP:
//
// 1. ONE permalink mapping. The import and the comparator must agree on which
//    remote note a local file corresponds to, or the comparator measures its
//    own disagreement instead of the backends'. `permalinkForRelPath` is that
//    single definition.
// 2. Identities only. A note body is confidential. Nothing here returns a body
//    for logging; content is compared through `digest`, and callers print the
//    permalink and the digest, never the note.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

/**
 * The dual-write review window, in days. DELIBERATELY NOT CONFIGURABLE: a
 * knob that moves the deadline is exactly the "flag that becomes furniture"
 * this whole migration shape exists to prevent. Extending the window is a
 * REVIEW OUTCOME with a written reason in docs/DECISIONS.md, not a config
 * value someone bumps.
 */
export const REVIEW_WINDOW_DAYS = 14;

/** The three outcomes the dated review must choose between. Rule 10. */
export const REVIEW_OUTCOMES = [
  "**Cut reads over** - the remote store becomes the memory of record: flip `backend` to the remote value, stop the shadow (`shadow_write: false`), and let the spool be the only writer.",
  "**Extend ONCE**, with a written reason appended to `docs/DECISIONS.md`. Once. A second extension is the same as never reviewing.",
  "**Remove** - the remote backend is not earning its keep: set `shadow_write: false`, leave `backend: local`, and delete the dual-write marker so no parallel path survives."
];

export function garrisonHome() {
  return (process.env.GARRISON_HOME || "").trim() || path.join(os.homedir(), ".garrison");
}

/** Machine-global state for this fitting (the dual-write marker lives here). */
export function stateDir() {
  return path.join(garrisonHome(), "basic-memory");
}

export function shadowMarkerPath() {
  return path.join(stateDir(), "shadow-write.json");
}

/**
 * The dual-write marker setup.sh writes the first time shadow resolves ON:
 * { first_dual_write_at, review_window_days, review_due_at }. Absent means we
 * do not know when dual-write started - which the report says plainly rather
 * than inventing a date.
 */
export function readShadowMarker() {
  try {
    const parsed = JSON.parse(fs.readFileSync(shadowMarkerPath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The cortex-client install receipt. ABSENT IS THE SHIPPED DEFAULT and means
 * the CLI is not installed - callers take their no-op path, they do not error.
 */
export function readInstallReceipt() {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(garrisonHome(), "cortex-client", "install.json"), "utf8")
    );
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Binary resolution contract (docs: cortex-client `for_consumers`):
 *   1. an explicit env override (what setup.sh bakes into a scheduled job),
 *   2. `bin` from the install receipt,
 *   3. only then the bin name on PATH.
 * Never errors: `probeCli` decides whether the resolved name actually exists.
 */
export function resolveRemoteCli() {
  const explicit =
    (process.env.REMOTE_MEMORY_CLI_BIN || "").trim() ||
    (process.env.BASIC_MEMORY_REMOTE_CLI_BIN || "").trim();
  if (explicit) return { bin: explicit, source: "env", baseUrl: "" };

  const receipt = readInstallReceipt();
  if (receipt && typeof receipt.bin === "string" && receipt.bin.trim()) {
    return {
      bin: receipt.bin.trim(),
      source: "receipt",
      baseUrl: typeof receipt.base_url === "string" ? receipt.base_url : ""
    };
  }
  return { bin: "cortex", source: receipt ? "receipt-without-bin" : "path", baseUrl: "" };
}

/** Spawn the CLI once. SIGKILL on timeout: a CLI that traps SIGTERM must not wedge us. */
export function runCli(bin, args, { timeoutMs = 30_000 } = {}) {
  const res = spawnSync(bin, args, {
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const enoent = Boolean(res.error && res.error.code === "ENOENT");
  const timedOut = Boolean(res.error && res.error.code === "ETIMEDOUT");
  return {
    enoent,
    timedOut,
    status: typeof res.status === "number" ? res.status : null,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    why: enoent
      ? "not installed"
      : timedOut
        ? `timeout after ${timeoutMs}ms`
        : res.error
          ? `spawn error ${res.error.code || res.error.message}`
          : `exit ${res.status}`
  };
}

/** Does this binary exist at all? `--version` needs neither an origin nor a key. */
export function probeCli(bin, timeoutMs = 20_000) {
  const res = runCli(bin, ["--version"], { timeoutMs });
  return { installed: !res.enoent, why: res.why };
}

export function parseJsonDocument(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * ONE path segment of a permalink: lowercase, every run of characters outside
 * [a-z0-9] collapsed to a single `-`, ends trimmed. Accents are folded through
 * NFKD first so `Notas/Reunião.md` and `Notas/Reuniao.md` do not become two
 * unrelated identities.
 */
export function slugSegment(text) {
  return String(text)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * THE PERMALINK MAPPING (documented once, used by import AND compare):
 *
 *   <vault_dir>/Memory/2026/Session Notes.md   ->   <folder>/memory-2026-session-notes
 *
 * The path RELATIVE TO THE VAULT ROOT, minus the `.md` extension, is slugified
 * whole - `/` included - into ONE slug segment, and hung under ONE folder
 * segment (`remote_folder`, default `vault`).
 *
 * Why flat rather than mirroring the folder tree: the contract's listing
 * operation is `memory list --folder <f>`, one folder at a time. A two-segment
 * permalink means ONE list call enumerates exactly the imported set, which is
 * what makes the comparator's set difference honest; a mirrored tree would
 * need a folder crawl the contract does not offer.
 *
 * It is stable (same path -> same permalink, forever), which is what makes a
 * re-import an overwrite instead of a duplicate. It is NOT injective: two
 * different paths can slugify to the same permalink, so callers must run
 * `findCollisions` and refuse the colliding notes rather than silently
 * overwriting one with the other.
 */
export function permalinkForRelPath(relPath, folder) {
  const withoutExt = String(relPath).replace(/\.md$/i, "");
  const slug = slugSegment(withoutExt.split(path.sep).join("/")) || "note";
  return `${slugSegment(folder) || "vault"}/${slug}`;
}

/**
 * Every note under <vault_dir>/<memory_dir>, plus everything deliberately
 * skipped and why. READ ONLY - nothing in this module writes to the vault.
 *
 * A "note" is a regular markdown file with something in it. Skipped: anything
 * not `.md`, dot-files and dot-directories (`.obsidian/`, editor droppings),
 * whitespace-only files, and anything unreadable. Symlinked directories are
 * not followed (a vault with a loop must not hang a scheduled job).
 */
export function listVaultNotes(vaultDir, memoryDir, folder) {
  const root = path.join(vaultDir, memoryDir);
  const notes = [];
  const skipped = [];

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relPath = path.relative(vaultDir, full);
      if (entry.name.startsWith(".")) {
        skipped.push({ relPath, reason: "hidden" });
        continue;
      }
      if (entry.isSymbolicLink()) {
        let stat;
        try {
          stat = fs.statSync(full);
        } catch {
          skipped.push({ relPath, reason: "unreadable" });
          continue;
        }
        if (stat.isDirectory()) {
          skipped.push({ relPath, reason: "symlinked-directory" });
          continue;
        }
      } else if (entry.isDirectory()) {
        walk(full);
        continue;
      } else if (!entry.isFile()) {
        skipped.push({ relPath, reason: "not-a-regular-file" });
        continue;
      }
      if (!/\.md$/i.test(entry.name)) {
        skipped.push({ relPath, reason: "not-markdown" });
        continue;
      }
      let body;
      try {
        body = fs.readFileSync(full, "utf8");
      } catch {
        skipped.push({ relPath, reason: "unreadable" });
        continue;
      }
      if (body.trim().length === 0) {
        skipped.push({ relPath, reason: "empty" });
        continue;
      }
      notes.push({
        relPath,
        absPath: full,
        permalink: permalinkForRelPath(relPath, folder),
        bytes: Buffer.byteLength(body, "utf8"),
        digest: digest(normalizeBody(body))
      });
    }
  };

  walk(root);
  notes.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  skipped.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { root, notes, skipped };
}

/** permalink -> [relPath, ...] for every permalink claimed by more than one note. */
export function findCollisions(notes) {
  const byPermalink = new Map();
  for (const note of notes) {
    const list = byPermalink.get(note.permalink) || [];
    list.push(note.relPath);
    byPermalink.set(note.permalink, list);
  }
  const collisions = new Map();
  for (const [permalink, paths] of byPermalink) {
    if (paths.length > 1) collisions.set(permalink, paths);
  }
  return collisions;
}

/**
 * The ONLY normalisation applied before comparing two note bodies: a leading
 * BOM, CRLF line endings, and leading/trailing whitespace of the whole
 * document. Trailing spaces INSIDE a line are left alone - in markdown two of
 * them are a hard line break, i.e. content, and a comparator that silently
 * eats content is a comparator that reports parity it did not observe.
 */
export function normalizeBody(text) {
  return String(text).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
}

export function digest(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

export function shortDigest(text) {
  return digest(text).slice(0, 12);
}

/** Deterministic, evenly spread sample of a SORTED list - same input, same sample. */
export function pickSample(items, size) {
  if (!Array.isArray(items) || items.length === 0 || size <= 0) return [];
  if (items.length <= size) return [...items];
  const out = [];
  for (let i = 0; i < size; i += 1) out.push(items[Math.floor((i * items.length) / size)]);
  return out;
}

const LIST_KEYS = ["notes", "items", "results", "hits", "entries", "data"];

/**
 * Pull the permalinks out of a `memory list --json` document. The contract
 * fixes the envelope (`{ ok, command, status, data }`) but the shape INSIDE
 * `data` is the provider's, so this looks for the well-known keys and then for
 * any array of objects carrying a `permalink`. Returns null when it cannot
 * tell - the caller reports INCONCLUSIVE rather than guessing an empty set,
 * because "no permalinks found" and "listing not understood" are the same
 * bytes and very different facts.
 */
export function extractPermalinks(document) {
  const data = document && typeof document === "object" && "data" in document ? document.data : document;
  const array = findPermalinkArray(data);
  if (!array) return null;
  const out = [];
  for (const element of array) {
    if (typeof element === "string") out.push(element);
    else if (element && typeof element === "object" && typeof element.permalink === "string") {
      out.push(element.permalink);
    } else return null;
  }
  return out;
}

function findPermalinkArray(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return null;
  for (const key of LIST_KEYS) {
    const value = data[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = findPermalinkArray(value);
      if (nested) return nested;
    }
  }
  for (const value of Object.values(data)) {
    if (Array.isArray(value)) return value;
  }
  return null;
}

const BODY_PATHS = [
  ["content"],
  ["body"],
  ["markdown"],
  ["text"],
  ["note", "content"],
  ["note", "body"],
  ["note", "markdown"],
  ["data", "content"],
  ["data", "body"]
];

/**
 * Pull the note body out of a `memory read --json` document, or null when the
 * body is not where any known field says it is. Null is reported as
 * INCONCLUSIVE, never as a match.
 */
export function extractNoteBody(document) {
  const data = document && typeof document === "object" && "data" in document ? document.data : document;
  if (typeof data === "string") return data;
  if (!data || typeof data !== "object") return null;
  for (const keys of BODY_PATHS) {
    let cursor = data;
    let ok = true;
    for (const key of keys) {
      if (cursor && typeof cursor === "object" && key in cursor) cursor = cursor[key];
      else {
        ok = false;
        break;
      }
    }
    if (ok && typeof cursor === "string") return cursor;
  }
  return null;
}

/** UTC `YYYY-MM-DD` - the date a dated report is filed under. */
export function isoDate(when = new Date()) {
  return when.toISOString().slice(0, 10);
}

/** The review deadline derived from the marker, plus how much of it is left. */
export function reviewSchedule(marker, now = new Date()) {
  const firstAt = marker && typeof marker.first_dual_write_at === "string" ? marker.first_dual_write_at : "";
  const started = firstAt ? new Date(firstAt) : null;
  if (!started || Number.isNaN(started.getTime())) {
    return { known: false, firstDualWriteAt: "", reviewDueAt: "", daysRemaining: null };
  }
  const windowDays =
    typeof marker.review_window_days === "number" && marker.review_window_days > 0
      ? marker.review_window_days
      : REVIEW_WINDOW_DAYS;
  const due =
    typeof marker.review_due_at === "string" && !Number.isNaN(new Date(marker.review_due_at).getTime())
      ? new Date(marker.review_due_at)
      : new Date(started.getTime() + windowDays * 86_400_000);
  return {
    known: true,
    firstDualWriteAt: started.toISOString(),
    reviewDueAt: due.toISOString(),
    windowDays,
    // FLOOR, not round or ceil: a deadline countdown must never read longer
    // than it is.
    daysRemaining: Math.floor((due.getTime() - now.getTime()) / 86_400_000)
  };
}
