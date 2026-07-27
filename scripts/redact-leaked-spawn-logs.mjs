#!/usr/bin/env node
// One-shot remediation for the spawn-log leak fixed in src/lib/spawn.ts.
//
// redactEnv masked by NAME pattern only, so account-registry keys
// (ANTHROPIC_ACCOUNT__<name>, ACCOUNT__<platform>__<name>) — whose keys end in an
// account name and match no suffix — persisted their OAuth tokens in cleartext
// into ~/.garrison/logs/<pid>/meta.json. The code now redacts by VALUE too; this
// scrubs the records already on disk.
//
// Conservative by design:
//   • only rewrites a file that actually contains a match
//   • replaces the SECRET SUBSTRING, never the whole field — pid, command, cwd,
//     spawnedAt and every non-secret env var survive verbatim
//   • atomic temp+rename, preserving the original file mode
//   • --dry-run reports without writing
//
// Usage: node scripts/redact-leaked-spawn-logs.mjs [--dry-run] [--home <dir>]

import { readdirSync, readFileSync, writeFileSync, renameSync, statSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REDACTED = "***REDACTED***";

// Token shapes that must never sit on disk in the clear. Anchored on the
// provider prefixes so an ordinary string can't match by accident.
const TOKEN_PATTERNS = [
  /sk-ant-oat01-[A-Za-z0-9_-]+/g,   // Anthropic OAuth setup-token
  /sk-ant-api\d{2}-[A-Za-z0-9_-]+/g, // Anthropic API key
  /sk-proj-[A-Za-z0-9_-]+/g,         // OpenAI project key
  /xox[baprs]-[A-Za-z0-9-]+/g        // Slack
];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const homeIdx = args.indexOf("--home");
const garrisonHome =
  homeIdx >= 0 ? args[homeIdx + 1] : process.env.GARRISON_HOME || join(homedir(), ".garrison");
const logsRoot = join(garrisonHome, "logs");

let scanned = 0;
let rewritten = 0;
let occurrences = 0;
const distinct = new Set();

let dirs;
try {
  dirs = readdirSync(logsRoot);
} catch (err) {
  console.error(`cannot read ${logsRoot}: ${err.message}`);
  process.exit(1);
}

for (const dir of dirs) {
  const metaPath = join(logsRoot, dir, "meta.json");
  let text;
  try {
    text = readFileSync(metaPath, "utf8");
  } catch {
    continue; // no meta.json in this dir
  }
  scanned += 1;

  let out = text;
  let hits = 0;
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, (match) => {
      hits += 1;
      distinct.add(`${match.slice(0, 22)}…`);
      return REDACTED;
    });
  }
  if (!hits) continue;

  occurrences += hits;
  rewritten += 1;
  if (dryRun) continue;

  // Atomic replace, preserving the original mode.
  const mode = statSync(metaPath).mode & 0o777;
  const tmp = `${metaPath}.redact.tmp`;
  writeFileSync(tmp, out, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, metaPath);
}

console.log(`root:        ${logsRoot}`);
console.log(`meta.json:   ${scanned} scanned`);
console.log(`${dryRun ? "would rewrite" : "rewrote"}:     ${rewritten} files, ${occurrences} occurrences`);
console.log(`distinct secrets: ${[...distinct].join(", ") || "(none)"}`);
