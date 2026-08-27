#!/usr/bin/env node
// ONE-TIME import of the local markdown vault into a remote memory store.
//
//   node import-vault.mjs [--dry-run] [--folder <f>] [--sample <n>] [--no-verify]
//
// This is the first half of a rule-10 state migration: import once, shadow
// dual-write, compare daily, then cut over or remove on the dated review. It is
// NOT a sync loop and not a scheduled job - it exists to seed the remote store
// with what the vault already holds, and after cutover it has no further job.
//
// The permalink is the note's identity on the remote store, and this script
// derives it deterministically from the note's PATH (see `permalinkForRelPath`
// in lib/memory-vault.mjs). Same path -> same permalink -> a re-run OVERWRITES
// the same note instead of adding a second one. That is what makes running
// this twice safe, and it is the only reason it is safe.
//
// Contract:
//   - remote CLI missing ......... one line, nothing sent, exit 0 (the shipped
//     default is that no capability CLI is installed; that is not an error)
//   - --dry-run .................. prints the full path -> permalink mapping,
//     invokes the CLI zero times, exit 0
//   - after importing ............ VERIFIES: re-lists the remote folder and
//     compares the set, then reads a sample of notes back and compares content
//   - any failure, any missing note, any content mismatch -> loud lines + exit 1
//   - the local vault is NEVER written, moved or deleted. Read-only, always.
//
// It prints identities (paths, permalinks, digests) and counts. It NEVER prints
// a note body: the vault is the operative's memory, not log material.
//
// Stdlib only - no new deps.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  digest,
  extractNoteBody,
  extractPermalinks,
  findCollisions,
  listVaultNotes,
  normalizeBody,
  parseJsonDocument,
  pickSample,
  probeCli,
  resolveRemoteCli,
  resolveRemoteFolder,
  runCli,
  shortDigest
} from "./lib/memory-vault.mjs";

const PREFIX = "[basic-memory] import:";
const log = (msg) => console.log(`${PREFIX} ${msg}`);
const loud = (msg) => console.error(`${PREFIX} ${msg}`);

const USAGE = `usage: import-vault.mjs [--dry-run] [--folder <f>] [--sample <n>] [--limit <n>] [--no-verify]

  --dry-run     print the path -> permalink mapping and exit; nothing is sent
  --folder <f>  remote permalink folder (default $BASIC_MEMORY_REMOTE_FOLDER or "vault")
  --sample <n>  how many imported notes to read back and compare (default 3)
  --limit <n>   page size for the verification listing (default 1000)
  --no-verify   skip the post-import verification (NOT recommended)`;

function parseArgs(argv) {
  const opts = { dryRun: false, verify: true, folder: "", sample: null, limit: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--no-verify") opts.verify = false;
    else if (arg === "--folder") opts.folder = String(next() || "");
    else if (arg === "--sample") opts.sample = Number(next());
    else if (arg === "--limit") opts.limit = Number(next());
    else if (arg === "--help" || arg === "-h") return { help: true, ...opts };
    else return { bad: arg, ...opts };
  }
  return opts;
}

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.bad) {
    loud(`unknown argument '${opts.bad}'`);
    console.error(USAGE);
    return 2;
  }

  const vaultDir = expandHome(
    (process.env.BASIC_MEMORY_VAULT_DIR || "").trim() || path.join(os.homedir(), "ObsidianVault")
  );
  const memoryDir = (process.env.BASIC_MEMORY_MEMORY_DIR || "").trim() || "Memory";
  // ONE normalised folder for BOTH the permalink prefix and every `--folder`
  // argument. They used to be able to disagree, and the import then reported a
  // note missing that was sitting right there under the slugified name.
  const resolvedFolder = resolveRemoteFolder(
    opts.folder || (process.env.BASIC_MEMORY_REMOTE_FOLDER || "").trim() || "vault"
  );
  if (!resolvedFolder) {
    loud("remote folder is empty once slugified; refusing to guess a namespace for your vault");
    return 2;
  }
  const folder = resolvedFolder.folder;
  if (resolvedFolder.normalised) {
    log(`remote folder '${resolvedFolder.raw}' normalised to '${folder}' (a permalink segment is lowercase [a-z0-9-])`);
  }
  const sampleSize = Number.isFinite(opts.sample)
    ? opts.sample
    : Number(process.env.BASIC_MEMORY_IMPORT_SAMPLE_SIZE || "") || 3;
  const listLimit = Number.isFinite(opts.limit)
    ? opts.limit
    : Number(process.env.BASIC_MEMORY_LIST_LIMIT || "") || 1000;
  const timeoutMs = Number(process.env.BASIC_MEMORY_IMPORT_TIMEOUT_MS || "") || 30_000;

  const { root, rootExists, notes, skipped, unreadableDirs } = listVaultNotes(
    vaultDir,
    memoryDir,
    folder
  );
  const scanned = notes.length + skipped.length;

  if (!rootExists) {
    log(`vault folder ${root} does not exist; nothing to import`);
    return 0;
  }

  // A directory this process cannot read holds an unknown number of notes, so
  // no run that hits one may report success: "scanned 1, sent 1, complete" over
  // a chmod-000 subtree is a lie about the only thing the import was asked.
  for (const dir of unreadableDirs) {
    loud(`cannot read ${dir}/ - an unknown number of notes under it were NEITHER scanned NOR imported`);
  }

  // Two notes whose paths slugify to the same permalink would silently
  // overwrite one another on the remote store. Refuse BOTH - "which one won"
  // is not a question an import should answer by accident.
  const collisions = findCollisions(notes);
  const refused = new Set();
  for (const [permalink, paths] of collisions) {
    loud(`permalink collision: ${paths.length} notes map to ${permalink} - refusing all of them`);
    for (const relPath of paths) {
      loud(`  collides: ${relPath}`);
      refused.add(relPath);
    }
  }
  const importable = notes.filter((note) => !refused.has(note.relPath));

  log(`vault ${root}`);
  log(`remote folder '${folder}'  |  mapping: <path relative to the vault, minus .md> slugified into ${folder}/<slug>`);

  if (opts.dryRun) {
    for (const note of importable) log(`would import ${note.relPath} -> ${note.permalink}`);
    for (const entry of skipped) log(`would skip ${entry.relPath} (${entry.reason})`);
    log(
      `dry run: scanned ${scanned} | would send ${importable.length} | skipped ${skipped.length} | failed ${refused.size}`
    );
    log("dry run: the remote CLI was not invoked and nothing was sent");
    return refused.size > 0 || unreadableDirs.length > 0 ? 1 : 0;
  }

  const cli = resolveRemoteCli();
  const probe = probeCli(cli.bin);
  if (!probe.installed) {
    log(
      `remote memory CLI not found ('${cli.bin}', resolved from ${cli.source}); nothing imported, vault untouched`
    );
    return 0;
  }
  log(`remote memory CLI '${cli.bin}' (resolved from ${cli.source})`);

  let sent = 0;
  const failures = [];
  let consecutiveFailures = 0;
  for (const note of importable) {
    const res = runCli(
      cli.bin,
      ["memory", "write", "--file", note.absPath, "--permalink", note.permalink, "--json"],
      { timeoutMs }
    );
    if (res.enoent) {
      // The binary vanished mid-run. Stop; nothing here deletes or mutates.
      loud(`remote memory CLI disappeared ('${cli.bin}'); stopping after ${sent} note(s)`);
      failures.push({ permalink: note.permalink, why: res.why });
      break;
    }
    if (res.status !== 0) {
      failures.push({ permalink: note.permalink, why: res.why });
      loud(`write failed for ${note.permalink} (${res.why})`);
      consecutiveFailures += 1;
      if (consecutiveFailures >= 5) {
        loud("5 consecutive failures; aborting the import - fix the remote side and re-run (re-runs overwrite, never duplicate)");
        break;
      }
      continue;
    }
    consecutiveFailures = 0;
    sent += 1;
  }

  for (const relPath of refused) failures.push({ permalink: `(refused) ${relPath}`, why: "permalink-collision" });

  const skipReasons = new Map();
  for (const entry of skipped) skipReasons.set(entry.reason, (skipReasons.get(entry.reason) || 0) + 1);
  const skipSummary = [...skipReasons].map(([reason, count]) => `${reason}=${count}`).join(", ");

  log(`scanned ${scanned} | sent ${sent} | skipped ${skipped.length} | failed ${failures.length}`);
  if (skipSummary) log(`skipped breakdown: ${skipSummary}`);

  let verifyFailed = false;
  let sampled = 0;
  if (!opts.verify) {
    loud("verification SKIPPED (--no-verify): this run makes NO claim that the remote store matches the vault");
  } else {
    const outcome = verify({
      cli,
      folder,
      importable,
      listLimit,
      sampleSize,
      timeoutMs
    });
    verifyFailed = outcome.failed;
    sampled = outcome.sampled;
  }

  if (failures.length > 0 || verifyFailed || unreadableDirs.length > 0) {
    loud(
      `import did NOT complete cleanly (${failures.length} failed, ${unreadableDirs.length} unreadable director(ies), verification ${opts.verify ? (verifyFailed ? "FAILED" : "ok") : "SKIPPED"})`
    );
    return 1;
  }
  // The LAST line is the one a log skim reads, so it states exactly what was
  // established - never "verified" for a run that verified nothing.
  if (!opts.verify) log("import complete; NOT verified (--no-verify) - no claim is made about the remote store");
  else if (sampled === 0) {
    log(
      `import complete; the note SET was verified against the remote folder, but content was compared on ZERO notes (sample size ${sampleSize})`
    );
  } else {
    log(`import complete and verified (set + content on ${sampled} sampled note(s))`);
  }
  return 0;
}

/**
 * Returns { failed, sampled }. Loud on every problem it finds, and it will not
 * call a listing it could not trust a clean result.
 */
function verify({ cli, folder, importable, listLimit, sampleSize, timeoutMs }) {
  let failed = false;

  const listed = runCli(
    cli.bin,
    ["memory", "list", "--folder", folder, "--limit", String(listLimit), "--json"],
    { timeoutMs }
  );
  if (listed.status !== 0) {
    loud(`verification INCONCLUSIVE: could not list remote folder '${folder}' (${listed.why})`);
    return { failed: true, sampled: 0 };
  }
  const remote = extractPermalinks(parseJsonDocument(listed.stdout));
  if (remote === null) {
    loud(`verification INCONCLUSIVE: the remote listing for '${folder}' was not in a shape this script understands`);
    return { failed: true, sampled: 0 };
  }
  // A listing that came back full is a listing that may have been cut short,
  // and every note past the cut would be reported "missing" - a false alarm
  // dressed as a data-loss report. Refuse to run the comparison at all.
  if (remote.length >= listLimit) {
    loud(
      `verification INCONCLUSIVE: the remote listing returned ${remote.length} row(s), at or above the --limit of ${listLimit}, so it may be truncated; re-run with a higher --limit rather than trusting a "missing" list computed from it`
    );
    return { failed: true, sampled: 0 };
  }

  const remoteSet = new Set(remote);
  const expected = importable.map((note) => note.permalink);
  const expectedSet = new Set(expected);
  const missing = expected.filter((permalink) => !remoteSet.has(permalink));
  const extra = [...remoteSet].filter((permalink) => !expectedSet.has(permalink)).sort();

  log(`verify counts: expected ${expectedSet.size} in '${folder}' | remote listed ${remoteSet.size}`);
  if (missing.length > 0) {
    failed = true;
    loud(`verify: ${missing.length} note(s) the import sent are NOT on the remote store:`);
    for (const permalink of missing) loud(`  missing: ${permalink}`);
  }
  if (extra.length > 0) {
    // Not a failure: a note deleted from the vault after an earlier import
    // legitimately survives on the remote store (nothing here deletes).
    log(`verify: ${extra.length} note(s) in '${folder}' were not part of this import (earlier imports, or deleted locally)`);
  }

  const comparable = importable.filter((note) => remoteSet.has(note.permalink));
  const sample = pickSample(comparable, sampleSize);
  log(`verify content: sampling ${sample.length} of ${comparable.length} note(s) present on both sides`);
  for (const note of sample) {
    const read = runCli(cli.bin, ["memory", "read", note.permalink, "--json"], { timeoutMs });
    if (read.status !== 0) {
      failed = true;
      loud(`verify: could not read back ${note.permalink} (${read.why})`);
      continue;
    }
    const body = extractNoteBody(parseJsonDocument(read.stdout));
    if (body === null) {
      failed = true;
      loud(`verify: INCONCLUSIVE for ${note.permalink} - no note body found in the read response; content NOT verified`);
      continue;
    }
    let local;
    try {
      local = fs.readFileSync(note.absPath, "utf8");
    } catch {
      failed = true;
      loud(`verify: could not re-read the local note ${note.relPath}`);
      continue;
    }
    const localDigest = digest(normalizeBody(local));
    const remoteDigest = digest(normalizeBody(body));
    if (localDigest !== remoteDigest) {
      failed = true;
      loud(
        `verify: CONTENT MISMATCH ${note.permalink} - local sha256 ${shortDigest(normalizeBody(local))} (${normalizeBody(local).length} chars) != remote ${shortDigest(normalizeBody(body))} (${normalizeBody(body).length} chars)`
      );
    }
  }
  if (!failed) log(`verify: ok on the sampled ${sample.length} note(s) - NOT a claim about the other ${Math.max(0, comparable.length - sample.length)}`);
  return { failed, sampled: sample.length };
}

try {
  process.exit(main());
} catch (err) {
  console.error(`${PREFIX} unexpected error: ${err?.message || err}`);
  process.exit(1);
}
