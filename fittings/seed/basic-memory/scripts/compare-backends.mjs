#!/usr/bin/env node
// The dual-write comparator. Lists BOTH sides of the shadow, diffs them by
// permalink, samples N notes and compares their content, and files a DATED
// markdown report in the composition's data dir.
//
//   node compare-backends.mjs [--sample <n>] [--folder <f>] [--out-dir <d>]
//                             [--limit <n>] [--fail-on-diff] [--quiet]
//
// It runs daily while `shadow_write` is on, and it exists for ONE purpose: to
// make the dated review of rule 10 decidable with evidence instead of vibes.
// Every report therefore carries the first dual-write timestamp, the review
// date derived from it, and the three outcomes the review must choose between.
//
// HONESTY RULES THIS SCRIPT IS BUILT AROUND:
//   - counts, set differences, and content mismatches are reported SEPARATELY;
//     a clean set difference is not parity, and a clean sample is not parity
//     either.
//   - the sample size is printed next to every content verdict, so no reader
//     can mistake "5 of 400 matched" for "the stores agree".
//   - a listing it cannot parse, or a body it cannot find, is INCONCLUSIVE and
//     says so; it is never quietly folded into "match".
//   - the report states, in its own words, what it did NOT check.
//   - it prints and writes IDENTITIES ONLY - permalinks, counts, digests. A
//     note body never reaches a log or a report file.
//
// Stdlib only - no new deps. Read-only with respect to the local vault.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REVIEW_OUTCOMES,
  REVIEW_WINDOW_DAYS,
  digest,
  extractNoteBody,
  extractPermalinks,
  findCollisions,
  isoDate,
  listVaultNotes,
  normalizeBody,
  parseJsonDocument,
  pickSample,
  probeCli,
  readShadowMarker,
  resolveRemoteCli,
  reviewSchedule,
  runCli,
  shortDigest
} from "./lib/memory-vault.mjs";

const PREFIX = "[basic-memory] compare:";
const log = (msg) => console.log(`${PREFIX} ${msg}`);
const loud = (msg) => console.error(`${PREFIX} ${msg}`);

const USAGE = `usage: compare-backends.mjs [--sample <n>] [--folder <f>] [--out-dir <d>] [--limit <n>] [--fail-on-diff] [--quiet]

  --sample <n>     how many shared notes to read back and compare (default 5)
  --folder <f>     remote permalink folder (default $BASIC_MEMORY_REMOTE_FOLDER or "vault")
  --out-dir <d>    where the dated report is filed (default the composition's data dir)
  --limit <n>      page size for the remote listing (default 1000)
  --fail-on-diff   exit 1 when the two sides differ (default: differences are REPORTED, exit 0)
  --quiet          only the summary lines on stdout`;

function parseArgs(argv) {
  const opts = { sample: null, folder: "", outDir: "", limit: null, failOnDiff: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    if (arg === "--sample") opts.sample = Number(next());
    else if (arg === "--folder") opts.folder = String(next() || "");
    else if (arg === "--out-dir") opts.outDir = String(next() || "");
    else if (arg === "--limit") opts.limit = Number(next());
    else if (arg === "--fail-on-diff") opts.failOnDiff = true;
    else if (arg === "--quiet") opts.quiet = true;
    else if (arg === "--help" || arg === "-h") return { help: true, ...opts };
    else return { bad: arg, ...opts };
  }
  return opts;
}

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Where the dated report is filed, in order:
 *   1. --out-dir / BASIC_MEMORY_COMPARE_REPORT_DIR (what setup.sh bakes into
 *      the scheduled job, because the daemon has no idea which composition
 *      registered the job),
 *   2. <composition>/data/memory-backend-compare when this script is running
 *      from an installed composition,
 *   3. $GARRISON_HOME/basic-memory/backend-compare as the last resort, so a
 *      report is never silently dropped.
 */
function resolveReportDir(explicit) {
  if (explicit) return expandHome(explicit);
  const fromEnv = (process.env.BASIC_MEMORY_COMPARE_REPORT_DIR || "").trim();
  if (fromEnv) return expandHome(fromEnv);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const modules = path.resolve(here, "..", "..", "..");
  if (path.basename(modules) === "apm_modules") {
    return path.join(path.resolve(modules, ".."), "data", "memory-backend-compare");
  }
  const garrison = (process.env.GARRISON_HOME || "").trim() || path.join(os.homedir(), ".garrison");
  return path.join(garrison, "basic-memory", "backend-compare");
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

  const now = new Date();
  const vaultDir = expandHome(
    (process.env.BASIC_MEMORY_VAULT_DIR || "").trim() || path.join(os.homedir(), "ObsidianVault")
  );
  const memoryDir = (process.env.BASIC_MEMORY_MEMORY_DIR || "").trim() || "Memory";
  const folder = opts.folder || (process.env.BASIC_MEMORY_REMOTE_FOLDER || "").trim() || "vault";
  const sampleSize = Number.isFinite(opts.sample)
    ? opts.sample
    : Number(process.env.BASIC_MEMORY_COMPARE_SAMPLE_SIZE || "") || 5;
  const listLimit = Number.isFinite(opts.limit)
    ? opts.limit
    : Number(process.env.BASIC_MEMORY_LIST_LIMIT || "") || 1000;
  const timeoutMs = Number(process.env.BASIC_MEMORY_COMPARE_TIMEOUT_MS || "") || 30_000;
  const reportDir = resolveReportDir(opts.outDir);

  const review = reviewSchedule(readShadowMarker(), now);
  const { root, notes, skipped } = listVaultNotes(vaultDir, memoryDir, folder);
  const collisions = findCollisions(notes);

  const result = {
    generatedAt: now.toISOString(),
    vaultRoot: root,
    folder,
    sampleSize,
    listLimit,
    review,
    localCount: notes.length,
    localSkipped: skipped.length,
    collisions,
    status: "inconclusive",
    statusWhy: "",
    // False until the remote side has actually been listed AND understood. It
    // gates the diff sections: "none missing" and "never looked" are very
    // different facts and must never render the same way.
    compared: false,
    remoteCount: null,
    listTruncated: false,
    onBoth: [],
    missingOnRemote: [],
    missingLocally: [],
    sampled: [],
    cli: null
  };

  const cli = resolveRemoteCli();
  result.cli = cli;
  const probe = probeCli(cli.bin);
  if (!probe.installed) {
    result.statusWhy = `the remote memory CLI ('${cli.bin}', resolved from ${cli.source}) is not installed on this machine, so the remote side could not be listed at all`;
    const written = writeReport(reportDir, now, result);
    log(`remote memory CLI not found ('${cli.bin}'); nothing compared`);
    log(`report: ${written}`);
    return 0;
  }

  const listed = runCli(
    cli.bin,
    ["memory", "list", "--folder", folder, "--limit", String(listLimit), "--json"],
    { timeoutMs }
  );
  if (listed.status !== 0) {
    result.statusWhy = `listing the remote folder '${folder}' failed (${listed.why}); no comparison was performed`;
    const written = writeReport(reportDir, now, result);
    loud(`could not list remote folder '${folder}' (${listed.why})`);
    log(`report: ${written}`);
    return 1;
  }
  const remote = extractPermalinks(parseJsonDocument(listed.stdout));
  if (remote === null) {
    result.statusWhy = `the remote listing for '${folder}' was not in a shape this comparator understands; it refuses to read an unparsed listing as an empty store`;
    const written = writeReport(reportDir, now, result);
    loud(`remote listing for '${folder}' not understood; comparison INCONCLUSIVE`);
    log(`report: ${written}`);
    return 1;
  }

  result.compared = true;
  const remoteSet = new Set(remote);
  const localByPermalink = new Map();
  for (const note of notes) if (!localByPermalink.has(note.permalink)) localByPermalink.set(note.permalink, note);

  result.remoteCount = remoteSet.size;
  result.listTruncated = remoteSet.size >= listLimit;
  result.onBoth = [...localByPermalink.keys()].filter((permalink) => remoteSet.has(permalink)).sort();
  result.missingOnRemote = [...localByPermalink.keys()].filter((permalink) => !remoteSet.has(permalink)).sort();
  result.missingLocally = [...remoteSet].filter((permalink) => !localByPermalink.has(permalink)).sort();

  const sample = pickSample(result.onBoth, sampleSize);
  for (const permalink of sample) {
    const note = localByPermalink.get(permalink);
    const read = runCli(cli.bin, ["memory", "read", permalink, "--json"], { timeoutMs });
    if (read.status !== 0) {
      result.sampled.push({ permalink, verdict: "read-error", detail: read.why });
      continue;
    }
    const body = extractNoteBody(parseJsonDocument(read.stdout));
    if (body === null) {
      result.sampled.push({
        permalink,
        verdict: "inconclusive",
        detail: "no note body found in the read response"
      });
      continue;
    }
    let localBody;
    try {
      localBody = fs.readFileSync(note.absPath, "utf8");
    } catch {
      result.sampled.push({ permalink, verdict: "read-error", detail: "local note unreadable" });
      continue;
    }
    const localNorm = normalizeBody(localBody);
    const remoteNorm = normalizeBody(body);
    result.sampled.push({
      permalink,
      verdict: digest(localNorm) === digest(remoteNorm) ? "match" : "mismatch",
      localDigest: shortDigest(localNorm),
      remoteDigest: shortDigest(remoteNorm),
      localChars: localNorm.length,
      remoteChars: remoteNorm.length
    });
  }

  const mismatches = result.sampled.filter((entry) => entry.verdict === "mismatch");
  const unresolved = result.sampled.filter(
    (entry) => entry.verdict === "inconclusive" || entry.verdict === "read-error"
  );
  const diverged =
    result.missingOnRemote.length > 0 || result.missingLocally.length > 0 || mismatches.length > 0;
  result.status = diverged ? "diverged" : unresolved.length > 0 ? "inconclusive" : "parity-on-sample";
  if (result.status === "inconclusive" && !result.statusWhy) {
    result.statusWhy = `the sets matched, but ${unresolved.length} of ${result.sampled.length} sampled note(s) could not be compared`;
  }

  const written = writeReport(reportDir, now, result);

  if (!opts.quiet) {
    log(`local ${result.localCount} note(s) under ${root}`);
    log(`remote ${result.remoteCount} note(s) in folder '${folder}'`);
    log(
      `on both ${result.onBoth.length} | missing on remote ${result.missingOnRemote.length} | missing locally ${result.missingLocally.length}`
    );
    log(
      `content sample: ${result.sampled.length} of ${result.onBoth.length} shared note(s) - ${result.sampled.filter((e) => e.verdict === "match").length} match, ${mismatches.length} mismatch, ${unresolved.length} inconclusive`
    );
  }
  log(`status ${result.status}`);
  if (review.known) log(`dual-write since ${review.firstDualWriteAt}; review due ${review.reviewDueAt}`);
  else loud("dual-write marker absent: the review date is UNKNOWN (shadow_write may never have been enabled by setup)");
  log(`report: ${written}`);

  if (opts.failOnDiff && diverged) return 1;
  return 0;
}

function bullets(list, empty) {
  if (list.length === 0) return [`_${empty}_`, ""];
  return [...list.map((item) => `- \`${item}\``), ""];
}

function writeReport(reportDir, now, result) {
  const file = path.join(reportDir, `${isoDate(now)}-memory-backend-compare.md`);
  const review = result.review;
  const matched = result.sampled.filter((entry) => entry.verdict === "match").length;
  const mismatched = result.sampled.filter((entry) => entry.verdict === "mismatch").length;
  const unresolved = result.sampled.length - matched - mismatched;

  const lines = [];
  lines.push(`# Memory backend comparison - ${isoDate(now)}`);
  lines.push("");
  lines.push(
    "<!-- Written by fittings/seed/basic-memory/scripts/compare-backends.mjs. Identities, counts and digests only: note bodies are confidential and never appear in this file. -->"
  );
  lines.push("");
  lines.push("| field | value |");
  lines.push("|---|---|");
  lines.push(`| generated at | ${result.generatedAt} |`);
  lines.push(`| first dual-write | ${review.known ? review.firstDualWriteAt : "UNKNOWN - no dual-write marker on this machine"} |`);
  lines.push(
    `| review due (first dual-write + ${review.known ? review.windowDays : REVIEW_WINDOW_DAYS} days) | ${review.known ? review.reviewDueAt : "UNKNOWN"} |`
  );
  lines.push(
    `| days remaining | ${review.known ? String(review.daysRemaining) : "UNKNOWN"}${review.known && review.daysRemaining <= 0 ? " - **OVERDUE**" : ""} |`
  );
  lines.push(`| local vault | \`${result.vaultRoot}\` |`);
  lines.push(`| remote folder | \`${result.folder}\` |`);
  lines.push(`| remote CLI | \`${result.cli?.bin ?? "(unresolved)"}\` (resolved from ${result.cli?.source ?? "n/a"}) |`);
  lines.push(
    `| sample size | ${result.sampled.length} of ${result.onBoth.length} note(s) present on both sides |`
  );
  lines.push(`| status | **${result.status}** |`);
  lines.push("");
  if (result.statusWhy) {
    lines.push(`> ${result.statusWhy}`);
    lines.push("");
  }

  lines.push("## The review this report exists for");
  lines.push("");
  lines.push(
    "Shadow dual-write is a MIGRATION, not a mode. It runs shadow -> compare -> cutover-or-remove, and it ends. On or before the review date above, choose exactly ONE of:"
  );
  lines.push("");
  REVIEW_OUTCOMES.forEach((outcome, index) => lines.push(`${index + 1}. ${outcome}`));
  lines.push("");
  lines.push(
    "Record the choice as a dated entry in `docs/DECISIONS.md`. A dual-write that outlives its review without one of those three entries is the permanent parallel implementation this process exists to prevent."
  );
  lines.push("");

  lines.push("## Counts");
  lines.push("");
  lines.push("| side | notes |");
  lines.push("|---|---|");
  lines.push(`| local (vault) | ${result.localCount} |`);
  lines.push(`| remote (folder \`${result.folder}\`) | ${result.remoteCount === null ? "not listed" : result.remoteCount} |`);
  lines.push(`| present on both | ${result.compared ? result.onBoth.length : "not determined"} |`);
  lines.push(`| missing on the remote | ${result.compared ? result.missingOnRemote.length : "not determined"} |`);
  lines.push(`| missing locally | ${result.compared ? result.missingLocally.length : "not determined"} |`);
  lines.push(`| local files skipped (not notes) | ${result.localSkipped} |`);
  lines.push("");
  if (result.listTruncated) {
    lines.push(
      `> **The remote listing hit the \`--limit\` of ${result.listLimit}.** It may be truncated, so "missing locally" is a floor, not a count. Re-run with a higher limit.`
    );
    lines.push("");
  }
  if (result.collisions.size > 0) {
    lines.push(
      `> **${result.collisions.size} permalink collision(s):** more than one local path maps to the same permalink, so those notes cannot be told apart on the remote side and are excluded from the import.`
    );
    for (const [permalink, paths] of result.collisions) {
      lines.push(`> - \`${permalink}\` <- ${paths.map((p) => `\`${p}\``).join(", ")}`);
    }
    lines.push("");
  }

  lines.push("## Missing on the remote");
  lines.push("");
  lines.push(
    "_Local notes with no counterpart on the remote store. Captures still sitting in the spool land here until the drain runs._"
  );
  lines.push("");
  lines.push(
    ...bullets(
      result.missingOnRemote,
      result.compared ? "none" : "NOT DETERMINED - the remote side was never listed, so this is not a claim that nothing is missing"
    )
  );

  lines.push("## Missing locally");
  lines.push("");
  lines.push(
    "_Remote notes with no local file. Expected after a local delete (nothing here deletes remotely), suspicious otherwise._"
  );
  lines.push("");
  lines.push(
    ...bullets(
      result.missingLocally,
      result.compared ? "none" : "NOT DETERMINED - the remote side was never listed"
    )
  );

  lines.push(`## Content sample (${result.sampled.length} of ${result.onBoth.length})`);
  lines.push("");
  lines.push(
    `_${matched} match, ${mismatched} mismatch, ${unresolved} inconclusive. Bodies are compared after normalising a BOM, CRLF endings and leading/trailing whitespace - nothing else. Digests are sha256 of the normalised body, truncated; the bodies themselves are not recorded._`
  );
  lines.push("");
  if (result.sampled.length === 0) {
    lines.push("_no notes were sampled_");
    lines.push("");
  } else {
    lines.push("| permalink | local sha256 | remote sha256 | verdict |");
    lines.push("|---|---|---|---|");
    for (const entry of result.sampled) {
      const local = entry.localDigest ? `\`${entry.localDigest}\` (${entry.localChars} chars)` : "-";
      const remote = entry.remoteDigest ? `\`${entry.remoteDigest}\` (${entry.remoteChars} chars)` : "-";
      const verdict = entry.detail ? `**${entry.verdict}** - ${entry.detail}` : `**${entry.verdict}**`;
      lines.push(`| \`${entry.permalink}\` | ${local} | ${remote} | ${verdict} |`);
    }
    lines.push("");
  }

  lines.push("## What this report does NOT check");
  lines.push("");
  lines.push(
    `- **The content of the ${Math.max(0, result.onBoth.length - result.sampled.length)} shared note(s) outside the sample.** Set membership was checked for every shared note; content was checked on ${result.sampled.length} of them. A **parity-on-sample** status is therefore a statement about those ${result.sampled.length}, never about the store as a whole.`
  );
  lines.push(
    "- **Anything outside the compared namespaces**: only `<vault_dir>/<memory_dir>` on the local side, and only the one remote folder above. Notes elsewhere on either side are invisible here."
  );
  lines.push(
    "- **Metadata**: titles, tags, timestamps and any provider-side derived fields are not compared - only the note body."
  );
  lines.push(
    "- **Write ordering and latency**: a capture written seconds ago may legitimately still be in the spool. This is a snapshot, not a consistency proof."
  );
  lines.push("- **Deletions**: nothing here deletes on either side, and a local delete is not propagated.");
  lines.push(
    "- **That the remote store is reachable by anyone else**: it was reached with whatever credential this machine holds, once, at the time above."
  );
  lines.push("");

  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

try {
  process.exit(main());
} catch (err) {
  console.error(`${PREFIX} unexpected error: ${err?.message || err}`);
  process.exit(1);
}
