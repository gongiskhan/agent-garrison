// Assembles the full preflight report: runs every collector, feeds the pure
// checks, and returns {findings, summary, degraded, generatedAt}. Shared by
// the HTTP server and the CLI so both always agree.

import {
  crossCheckLibrary,
  buildPortClaims,
  findPortCollisions,
  assessVerifyResults,
  serveCoverage,
  classifyOrphans,
  assessDrift,
  scanKinds,
  summarize,
  mk
} from "./preflight-core.mjs";
import {
  findRepoRoot,
  readSeedManifests,
  readCuratedLibrary,
  readCompositions,
  readLiveListeners,
  readStatusFiles,
  readSpawnRecords,
  readTailscaleServeMap,
  pidAlive
} from "./collect.mjs";
import { isAppUp, fetchViews, fetchRunnerState, appUrl } from "./app-client.mjs";

export async function buildReport({ startDir = process.cwd(), checks = null } = {}) {
  const wanted = checks && checks.length ? new Set(checks) : null;
  const run = (name) => !wanted || wanted.has(name);
  const findings = [];

  const root = findRepoRoot(startDir);
  if (!root) {
    findings.push(mk("repo-root", "preflight", "fail",
      `Could not locate the Garrison repo root walking up from ${startDir} (needs data/library.json + fittings/seed/).`,
      { fix: "Set the repo_root config key (GARRISON_PREFLIGHT_REPO_ROOT) to the repo checkout." }));
    return { findings, summary: summarize(findings), degraded: true, appUp: false, root: null, generatedAt: new Date().toISOString() };
  }

  const appUp = await isAppUp();
  if (!appUp) {
    findings.push(mk("app-reachable", "garrison-app", "warn",
      `Garrison app not reachable at ${appUrl()} — running in degraded mode (verify sweep unavailable; serve coverage checked directly against tailscale).`,
      { fix: "Start the app (npm run dev / the launchd agent) for the enriched checks. Everything below still ran from the filesystem." }));
  }

  const manifests = readSeedManifests(root);
  const compositions = await readCompositions(root);

  if (run("verify-results")) {
    // Live runner state first: last-up.json only records SUCCESSFUL ups, so a
    // failed attempt would otherwise be invisible right when it matters most.
    const records = [];
    for (const c of compositions) {
      const runnerState = appUp ? await fetchRunnerState(c.compositionId) : null;
      records.push({ compositionId: c.compositionId, lastUp: c.lastUp, runnerState });
    }
    findings.push(...assessVerifyResults(records));
  }

  if (run("library-crosscheck")) {
    findings.push(...crossCheckLibrary(manifests.map((m) => m.id), readCuratedLibrary(root)));
  }

  if (run("port-collisions")) {
    const claims = buildPortClaims(manifests, compositions);
    const listeners = await readLiveListeners();
    findings.push(...findPortCollisions(claims, listeners, readStatusFiles()));
  }

  if (run("serve-coverage")) {
    const views = appUp ? await fetchViews() : null;
    if (views) {
      findings.push(...serveCoverage({ views: views.map((v) => ({ fittingId: v.fittingId ?? v.id, port: v.port, tailnetUrl: v.tailnetUrl ?? null, healthy: v.healthy })) }));
    } else {
      const serveMap = await readTailscaleServeMap();
      if (serveMap === null) {
        findings.push(mk("serve-coverage", "tailscale", "warn",
          "tailscale binary not found or `serve status --json` failed — serve coverage could not be checked.",
          { fix: "Install tailscale or run with the app up (which checks via /api/fittings/views)." }));
      } else {
        findings.push(...serveCoverage({ statusFiles: readStatusFiles(), serveMap }));
      }
    }
  }

  if (run("orphans")) {
    findings.push(...classifyOrphans(readStatusFiles(), readSpawnRecords(), pidAlive));
  }

  if (run("drift")) {
    for (const c of compositions) findings.push(...assessDrift(c));
  }

  if (run("kind-vocabulary")) {
    findings.push(...scanKinds(manifests));
  }

  return {
    findings,
    summary: summarize(findings),
    degraded: !appUp,
    appUp,
    root,
    compositions: compositions.map((c) => c.compositionId),
    generatedAt: new Date().toISOString()
  };
}
