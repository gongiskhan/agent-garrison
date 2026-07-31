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
  resolveRemoteFolder,
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
  --fail-on-diff   exit 1 unless the status is parity-on-sample - i.e. on a divergence AND on an
                   inconclusive run (default: findings are REPORTED and the exit stays 0).
                   An overdue review exits 1 with or without this flag.
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
  // ONE normalised folder for the permalink prefix AND the `--folder` argument
  // - they could disagree before, which made the comparator hunt in a folder no
  // permalink ever used.
  const resolvedFolder = resolveRemoteFolder(
    opts.folder || (process.env.BASIC_MEMORY_REMOTE_FOLDER || "").trim() || "vault"
  );
  if (!resolvedFolder) {
    loud("remote folder is empty once slugified; refusing to compare against a namespace that cannot exist");
    return 2;
  }
  const folder = resolvedFolder.folder;
  const sampleSize = Number.isFinite(opts.sample)
    ? opts.sample
    : Number(process.env.BASIC_MEMORY_COMPARE_SAMPLE_SIZE || "") || 5;
  const listLimit = Number.isFinite(opts.limit)
    ? opts.limit
    : Number(process.env.BASIC_MEMORY_LIST_LIMIT || "") || 1000;
  const timeoutMs = Number(process.env.BASIC_MEMORY_COMPARE_TIMEOUT_MS || "") || 30_000;
  const reportDir = resolveReportDir(opts.outDir);

  const review = reviewSchedule(readShadowMarker(), now);
  const { root, rootExists, notes, skipped, unreadableDirs } = listVaultNotes(
    vaultDir,
    memoryDir,
    folder
  );
  // Both members of a colliding pair are excluded from the comparison, exactly
  // as the import refuses to send them: keeping the first and dropping the rest
  // made the counts table fail to add up and compared content against whichever
  // member sorted first. They are counted in their own row instead.
  const collisions = findCollisions(notes);
  const collided = new Set();
  for (const paths of collisions.values()) for (const relPath of paths) collided.add(relPath);
  const comparableNotes = notes.filter((note) => !collided.has(note.relPath));

  const result = {
    generatedAt: now.toISOString(),
    vaultRoot: root,
    rootExists,
    unreadableDirs,
    folder,
    folderRaw: resolvedFolder.raw,
    folderNormalised: resolvedFolder.normalised,
    sampleSize,
    listLimit,
    review,
    localCount: notes.length,
    localComparable: comparableNotes.length,
    localCollided: collided.size,
    localSkipped: skipped.length,
    collisions,
    status: "inconclusive",
    statusWhy: "",
    // False until the remote side has actually been listed AND understood. It
    // gates the diff sections: "none missing" and "never looked" are very
    // different facts and must never render the same way.
    compared: false,
    remoteCount: null,
    remoteRows: null,
    remoteDuplicates: 0,
    listTruncated: false,
    onBoth: [],
    missingOnRemote: [],
    missingLocally: [],
    sampled: [],
    cli: null
  };

  // A vault root that is not there is NOT an empty vault. The daily job bakes
  // the vault path in at setup time, so an unmounted volume at 04:27 would
  // otherwise file a clean-looking parity report every single day for the whole
  // window - and outcome 1, cut reads over, would then be chosen against a
  // remote store nothing was ever compared to.
  if (!rootExists) {
    result.statusWhy = `the local vault folder ${root} does not exist (unmounted volume? wrong BASIC_MEMORY_VAULT_DIR?), so there was nothing to compare the remote store against - this is NOT a report that the two agree`;
    const written = writeReport(reportDir, now, result);
    loud(`local vault folder ${root} does not exist; comparison INCONCLUSIVE`);
    log(`report: ${written}`);
    return 1;
  }
  for (const dir of unreadableDirs) {
    loud(`cannot read ${dir}/ - an unknown number of local notes under it were not compared`);
  }

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
  for (const note of comparableNotes) localByPermalink.set(note.permalink, note);

  result.remoteCount = remoteSet.size;
  result.remoteRows = remote.length;
  result.remoteDuplicates = remote.length - remoteSet.size;
  // Measured on the RAW ROW COUNT, not the deduped set: a listing that returns
  // `limit` rows of which one is a duplicate is still a listing that hit the
  // cap, and deduping first hid exactly that case.
  result.listTruncated = remote.length >= listLimit;
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

  // A truncated listing poisons the diff in BOTH directions of claim: every
  // note past the cut reads as "missing on the remote" whether or not it is
  // there, so neither "they agree" nor "they diverge" is supportable. It is the
  // one condition that overrides a divergence rather than merely blocking
  // parity.
  const untrustworthy = result.listTruncated;

  // PARITY IS THE HARDEST CLAIM THIS TOOL MAKES, so it is the one with the most
  // ways to be refused. Every reason below is a case where the tool did not
  // actually look at something it would need to have looked at - and an empty
  // sample satisfying "no mismatches" was how a run that compared NOTHING used
  // to print parity.
  const cannotClaimParity = [];
  if (result.unreadableDirs.length > 0) {
    cannotClaimParity.push(
      `${result.unreadableDirs.length} local director(ies) could not be read, so an unknown number of notes were never compared`
    );
  }
  if (result.localCollided > 0) {
    cannotClaimParity.push(
      `${result.localCollided} local note(s) share a permalink with another and are not addressable remotely, so they were excluded from both sides`
    );
  }
  if (result.listTruncated) {
    cannotClaimParity.push(
      `the remote listing returned ${result.remoteRows} row(s), at or above the --limit of ${listLimit}, so it may be truncated - every note past the cut reads as "missing on the remote" whether it is there or not, which makes the ${result.missingOnRemote.length} entr(ies) in that column unproven rather than a finding`
    );
  }
  if (result.sampled.length === 0) {
    cannotClaimParity.push(
      sampleSize <= 0
        ? `the sample size is ${sampleSize}, so no note content was compared at all`
        : "no note was present on both sides, so no content was compared at all"
    );
  }
  if (unresolved.length > 0) {
    cannotClaimParity.push(
      `${unresolved.length} of ${result.sampled.length} sampled note(s) could not be compared`
    );
  }

  result.status = untrustworthy
    ? "inconclusive"
    : diverged
      ? "diverged"
      : cannotClaimParity.length > 0
        ? "inconclusive"
        : "parity-on-sample";
  if (result.status === "inconclusive" && !result.statusWhy) {
    result.statusWhy = untrustworthy
      ? `neither agreement nor divergence can be claimed from this run: ${cannotClaimParity.join("; ")}`
      : `no difference was found, but this is NOT parity: ${cannotClaimParity.join("; ")}`;
  }
  result.cannotClaimParity = cannotClaimParity;

  const written = writeReport(reportDir, now, result);

  if (!opts.quiet) {
    log(`local ${result.localCount} note(s) under ${root} (${result.localComparable} comparable)`);
    log(`remote ${result.remoteCount} note(s) in folder '${folder}'`);
    log(
      `on both ${result.onBoth.length} | missing on remote ${result.missingOnRemote.length} | missing locally ${result.missingLocally.length}`
    );
    log(
      `content sample: ${result.sampled.length} of ${result.onBoth.length} shared note(s) - ${result.sampled.filter((e) => e.verdict === "match").length} match, ${mismatches.length} mismatch, ${unresolved.length} inconclusive`
    );
  }
  log(`status ${result.status}`);
  for (const why of cannotClaimParity) loud(`not parity: ${why}`);

  // The deadline has to be able to go RED somewhere other than inside a
  // markdown file nobody is obliged to open. An overdue review is the failure
  // this whole slice exists to make impossible to ignore, so it fails the job.
  let overdue = false;
  if (!review.known) {
    loud("dual-write marker absent: the review date is UNKNOWN (shadow_write may never have been enabled by setup)");
  } else if (review.overdue) {
    overdue = true;
    loud(
      `REVIEW OVERDUE by ${Math.abs(review.daysRemaining)} day(s): dual-write started ${review.firstDualWriteAt} and was due for review ${review.reviewDueAt}. Choose ONE - cut reads over, extend ONCE with a written reason, or remove - and record it in docs/DECISIONS.md.`
    );
  } else {
    log(`dual-write since ${review.firstDualWriteAt}; review due ${review.reviewDueAt} (${review.daysRemaining} day(s) left)`);
  }
  if (review.tampered) {
    loud(
      `the dual-write marker records a LONGER window than the standing ${REVIEW_WINDOW_DAYS} days (recorded due ${review.recordedDueAt || "n/a"}); the standing deadline ${review.reviewDueAt} is the one in force`
    );
  }
  log(`report: ${written}`);

  if (overdue) return 1;
  // Not just `diverged`: an INCONCLUSIVE daily run is a comparator that could
  // not do its job, and letting that exit 0 is the same failure as letting a
  // divergence exit 0 - the gate would pass while nothing was being checked.
  if (opts.failOnDiff && result.status !== "parity-on-sample") return 1;
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
    `| days remaining | ${review.known ? String(review.daysRemaining) : "UNKNOWN"}${review.known && review.overdue ? " - **OVERDUE**" : ""} |`
  );
  if (review.tampered) {
    lines.push(
      `| marker window | **HAND-EXTENDED** - the marker records ${review.recordedWindowDays ?? "?"} days / due ${review.recordedDueAt || "n/a"}; the standing ${REVIEW_WINDOW_DAYS}-day deadline above is the one in force |`
    );
  }
  lines.push(`| local vault | \`${result.vaultRoot}\`${result.rootExists ? "" : " - **MISSING**"} |`);
  lines.push(
    `| remote folder | \`${result.folder}\`${result.folderNormalised ? ` (normalised from \`${result.folderRaw}\`)` : ""} |`
  );
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
  lines.push(`| local notes found | ${result.localCount} |`);
  lines.push(`| local notes compared | ${result.localComparable} |`);
  lines.push(`| local notes excluded (permalink collision) | ${result.localCollided} |`);
  lines.push(`| remote (folder \`${result.folder}\`) | ${result.remoteCount === null ? "not listed" : result.remoteCount} |`);
  lines.push(`| present on both | ${result.compared ? result.onBoth.length : "not determined"} |`);
  lines.push(`| missing on the remote | ${result.compared ? result.missingOnRemote.length : "not determined"} |`);
  lines.push(`| missing locally | ${result.compared ? result.missingLocally.length : "not determined"} |`);
  lines.push(`| local files skipped (not notes) | ${result.localSkipped} |`);
  lines.push(`| local directories unreadable | ${result.unreadableDirs.length} |`);
  lines.push("");
  lines.push(
    `_The first three rows add up: ${result.localComparable} compared + ${result.localCollided} excluded = ${result.localCount} found._`
  );
  lines.push("");
  if (result.unreadableDirs.length > 0) {
    lines.push(
      "> **Part of the vault could not be read**, so an unknown number of local notes were never compared and could not appear in any row above:"
    );
    for (const dir of result.unreadableDirs) lines.push(`> - \`${dir}\``);
    lines.push("");
  }
  if (result.listTruncated) {
    lines.push(
      `> **The remote listing returned ${result.remoteRows} row(s), at or above the \`--limit\` of ${result.listLimit}, so it may be truncated.** What truncation does here is inflate **missing on the remote** with notes that are present but past the cut - false positives that force a \`diverged\` status; it can only ever SHRINK "missing locally". Re-run with a higher \`--limit\` before believing either column.`
    );
    lines.push("");
  }
  if (result.remoteDuplicates > 0) {
    lines.push(
      `> The remote listing contained ${result.remoteDuplicates} duplicate permalink row(s); counts above use the deduplicated set.`
    );
    lines.push("");
  }
  if (result.collisions.size > 0) {
    lines.push(
      `> **${result.collisions.size} permalink collision(s):** more than one local path maps to the same permalink, so those notes cannot be told apart on the remote side. ALL members are excluded from the import and from both sides of this comparison - never silently resolved in favour of one.`
    );
    for (const [permalink, paths] of result.collisions) {
      lines.push(`> - \`${permalink}\` <- ${paths.map((p) => `\`${p}\``).join(", ")}`);
    }
    lines.push("");
  }

  lines.push("## Missing on the remote");
  lines.push("");
  lines.push(
    "_Local notes with no counterpart on the remote store. A capture still sitting in the spool lands here and LEAVES once the drain ships it, because the drain writes each capture under the same `<folder>/<slug>` permalink this comparator derives from the note's vault path. An entry that never clears is a real gap - a drain that is not running, a remote write that is failing, or a capture spooled by a pre-sidecar hook (see the last section)._"
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
    "- **Notes written under a bare queue key.** A capture spooled before this fitting shipped identity sidecars drains to `capture-<session>-<ts>-<pid>` - no folder, so it is outside every folder a `memory list --folder` call can reach, and it is neither counted nor reconciled here. The drain logs a line whenever it ships one; after that, the only way to see them is `memory list` on the provider side."
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
