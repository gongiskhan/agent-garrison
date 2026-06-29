#!/usr/bin/env node
// Kanban Loop V1d walkthrough harness — drives the live vision spec against
// the user's REAL running Garrison and reports the FINDINGS state. NEVER
// auto-passes a finding: the brief is explicit that each FINDING must be
// vision-verified by an operative READING the screenshot. This script:
//
//   1. Preflight: pings 127.0.0.1:7777 + the gateway /health endpoint.
//   2. Runs the playwright spec with KANBAN_V1D_RUN_DIR=<runDir>.
//   3. Reads <runDir>/FINDINGS.md, counts OK vs TODO.
//   4. Exits NON-ZERO unless every finding is OK (the operative flips TODO→OK
//      manually after reading the screenshots; this script never does it).
//
// Dry-run mode (--dry-run) prints the recipe + exits 0 without touching the
// live composition — used by the implement-side acceptance check.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function usage(code = 1) {
  process.stderr.write(
    [
      "usage: node scripts/kanban-v1d-walkthrough.mjs <runId> [--dry-run]",
      "",
      "  <runId>     ULID under docs/autothing/runs/ — vision screenshots and",
      "              FINDINGS.md are written under this run's dir.",
      "  --dry-run   print the recipe + exit 0; do NOT call playwright or",
      "              touch the live composition.",
      "",
      "env:",
      "  GARRISON_BASE_URL      default http://127.0.0.1:7777",
      "  GARRISON_GATEWAY_URL   default http://127.0.0.1:4777",
      "  KANBAN_V1D_TURN_BUDGET_MS  per-Plan-turn budget (default 25 min)",
      ""
    ].join("\n")
  );
  process.exit(code);
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) usage(0);
const dryRun = args.includes("--dry-run");
const runId = args.find((a) => !a.startsWith("--"));
if (!runId) usage(1);

const baseUrl = process.env.GARRISON_BASE_URL || "http://127.0.0.1:7777";
const gatewayUrl = process.env.GARRISON_GATEWAY_URL || "http://127.0.0.1:4777";
const runDir = `docs/autothing/runs/${runId}`;
const visionDir = path.resolve(REPO_ROOT, runDir, "vision");
const findingsPath = path.resolve(REPO_ROOT, runDir, "FINDINGS.md");

if (dryRun) {
  process.stdout.write(
    [
      "[kanban-v1d-walkthrough] DRY RUN",
      `  run dir: ${runDir}`,
      `  vision dir (will be created): ${visionDir}`,
      `  findings file (will be written): ${findingsPath}`,
      `  base url: ${baseUrl}`,
      `  gateway url: ${gatewayUrl}`,
      "",
      "  recipe:",
      "    1. preflight GET / and GET <gateway>/health",
      "    2. KANBAN_V1D_RUN_DIR=<runDir> npx playwright test --config tests/live-vision/kanban-loop-v1d.config.ts",
      "    3. read FINDINGS.md, count OK vs TODO",
      "    4. exit 0 only when every FINDING is OK (operative-driven, no auto-OK)",
      ""
    ].join("\n")
  );
  process.exit(0);
}

async function preflight() {
  const tryFetch = async (url) => {
    try {
      const r = await fetch(url, { method: "GET" });
      return r.ok;
    } catch {
      return false;
    }
  };
  const garrisonOk = await tryFetch(baseUrl);
  if (!garrisonOk) {
    process.stderr.write(`[kanban-v1d-walkthrough] FAIL: Garrison not reachable at ${baseUrl} — run \`npm start\` first.\n`);
    process.exit(2);
  }
  const gatewayOk = await tryFetch(`${gatewayUrl}/health`);
  if (!gatewayOk) {
    process.stderr.write(
      `[kanban-v1d-walkthrough] FAIL: gateway not reachable at ${gatewayUrl}/health — bring \`default\` up first.\n`
    );
    process.exit(2);
  }
}

function runSpec() {
  process.stdout.write(`[kanban-v1d-walkthrough] running spec, screenshots → ${visionDir}\n`);
  const result = spawnSync(
    "npx",
    ["playwright", "test", "--config", "tests/live-vision/kanban-loop-v1d.config.ts"],
    {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        KANBAN_V1D_RUN_DIR: runDir,
        GARRISON_BASE_URL: baseUrl,
        GARRISON_GATEWAY_URL: gatewayUrl
      }
    }
  );
  return result.status ?? 1;
}

function summariseFindings() {
  if (!existsSync(findingsPath)) {
    process.stderr.write(`[kanban-v1d-walkthrough] FAIL: ${findingsPath} not written by spec.\n`);
    return { ok: 0, todo: 0, fail: 0, missing: true };
  }
  const body = readFileSync(findingsPath, "utf8");
  // Count FINDING headers ending in OK / TODO. The spec writes each one as
  // "## FINDING <n>: <label> — <status>"; a human flips TODO to OK after reading
  // the PNG. Anything not OK is treated as still-open (no auto-pass).
  const lines = body.split("\n").filter((l) => /^##\s+FINDING\s/i.test(l));
  let ok = 0;
  let todo = 0;
  let other = 0;
  for (const line of lines) {
    if (/—\s*OK\s*$/i.test(line)) ok++;
    else if (/—\s*TODO\s*$/i.test(line)) todo++;
    else other++;
  }
  return { ok, todo, fail: other, total: lines.length, missing: false };
}

(async () => {
  await preflight();
  const status = runSpec();
  const sum = summariseFindings();
  process.stdout.write(
    [
      "",
      "[kanban-v1d-walkthrough] FINDINGS summary:",
      `  total: ${sum.total ?? 0}`,
      `  OK:    ${sum.ok}`,
      `  TODO:  ${sum.todo}`,
      `  other: ${sum.fail}`,
      `  file:  ${findingsPath}`,
      ""
    ].join("\n")
  );
  // Spec failure is fatal regardless of FINDINGS state.
  if (status !== 0) {
    process.stderr.write(`[kanban-v1d-walkthrough] FAIL: playwright spec exited ${status}.\n`);
    process.exit(status);
  }
  if (sum.missing || sum.todo > 0 || sum.fail > 0 || (sum.total ?? 0) < 10) {
    process.stderr.write(
      "[kanban-v1d-walkthrough] FAIL: not every FINDING is OK. Read each screenshot and edit FINDINGS.md to mark them OK before re-running, OR fix the underlying issue.\n"
    );
    process.exit(3);
  }
  process.stdout.write("KANBAN-LOOP-V1D OK\n");
  process.exit(0);
})().catch((err) => {
  process.stderr.write(`[kanban-v1d-walkthrough] error: ${err?.stack || err}\n`);
  process.exit(1);
});
