// Assembles the full preflight report: runs every collector, feeds the pure
// checks, and returns {findings, summary, degraded, generatedAt}. Shared by
// the HTTP server and the CLI so both always agree.

import {
  crossCheckLibrary,
  findOrphanServeMappings,
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
  FITTING_DIR,
  findRepoRoot,
  readSeedManifests,
  readCuratedLibrary,
  readCompositions,
  readLiveListeners,
  readStatusFiles,
  readGatewayRecords,
  readProcessCommands,
  readSpawnRecords,
  readTailscaleServeMap,
  readActiveComposition,
  readTetheredPorts,
  pidAlive
} from "./collect.mjs";
import { isAppUp, fetchViews, fetchRunnerState, appUrl } from "./app-client.mjs";
import { readFixJournal, libraryChange } from "./fixers.mjs";

// Every side effect this module performs, in one injectable bag. The fitting
// already does this twice — createRequestHandler(deps) and createFixRunner({..})
// — and without it the assembly layer is the one layer no test can drive, which
// is exactly where the report's ranking and deduplication decisions now live.
const DEFAULT_COLLECTORS = {
  findRepoRoot, readSeedManifests, readCuratedLibrary, readCompositions,
  readLiveListeners, readStatusFiles, readGatewayRecords, readProcessCommands,
  readSpawnRecords, readTailscaleServeMap, readActiveComposition,
  readTetheredPorts, pidAlive, isAppUp, fetchViews, fetchRunnerState, appUrl,
  readFixJournal, libraryChange
};

// Re-check each journaled fix against CURRENT reality. "resolved" here means
// the thing the fix targeted is now in the state the fix aimed for — measured
// fresh, not taken from the fixer's own success claim. null = cannot re-check
// cheaply (e.g. serve mappings when tailscale was not consulted this report).
function annotateResolution(entries, ctx) {
  const compById = new Map(ctx.compositions.map((c) => [c.compositionId, c]));
  return entries.map((e) => {
    let resolved = null;
    if (e.actionId === "library-add-entry") resolved = ctx.libraryIds.has(e.params?.fittingId);
    else if (e.actionId === "library-remove-entry") resolved = !ctx.libraryIds.has(e.params?.entryId);
    else if (e.actionId === "unstation-fitting") {
      const comp = compById.get(e.params?.compositionId);
      if (comp) resolved = !comp.diskSelections.includes(e.params?.fittingId);
    } else if (e.actionId === "git-commit-library") resolved = null;
    return { ...e, resolved };
  });
}

export async function buildReport({ startDir = FITTING_DIR, checks = null, collectors = {} } = {}) {
  const c = { ...DEFAULT_COLLECTORS, ...collectors };
  const wanted = checks && checks.length ? new Set(checks) : null;
  const run = (name) => !wanted || wanted.has(name);
  const findings = [];

  const root = c.findRepoRoot(startDir);
  if (!root) {
    findings.push(mk("repo-root", "preflight", "fail",
      `Could not locate the Garrison repo root walking up from ${startDir} (needs data/library.json + fittings/seed/).`,
      { fix: "Set the repo_root config key (GARRISON_PREFLIGHT_REPO_ROOT) to the repo checkout." }));
    return { findings, summary: summarize(findings), degraded: true, appUp: false, root: null, generatedAt: new Date().toISOString() };
  }

  const appUp = await c.isAppUp();
  if (!appUp) {
    findings.push(mk("app-reachable", "garrison-app", "warn",
      `Garrison app not reachable at ${c.appUrl()} — running in degraded mode (verify sweep unavailable; serve coverage checked directly against tailscale).`,
      { fix: "Start the app (npm run dev / the launchd agent) for the enriched checks. Everything below still ran from the filesystem." }));
  }

  const manifests = c.readSeedManifests(root);
  const compositions = await c.readCompositions(root);
  // Which composition the operator actually means. Everything else is ranked
  // below it — never hidden, and never for correctness-class findings.
  const known = new Set(compositions.map((x) => x.compositionId));
  const pointer = c.readActiveComposition();
  const activeCompositionId = pointer && known.has(pointer) ? pointer : null;

  const records = await Promise.all(compositions.map(async (x) => ({
    compositionId: x.compositionId,
    lastUp: x.lastUp,
    runnerState: appUp ? await c.fetchRunnerState(x.compositionId) : null
  })));

  // One lsof for the whole report, shared by the port and serve checks.
  const listeners = run("port-collisions") || run("serve-coverage") ? await c.readLiveListeners() : [];

  if (run("verify-results")) {
    // Live runner state first: last-up.json only records SUCCESSFUL ups, so a
    // failed attempt would otherwise be invisible right when it matters most.
    findings.push(...assessVerifyResults(records, { activeCompositionId }));
  }

  if (run("library-crosscheck")) {
    findings.push(...crossCheckLibrary(manifests.map((m) => m.id), c.readCuratedLibrary(root)));
  }

  if (run("port-collisions")) {
    const claims = buildPortClaims(manifests, compositions);
    // Gateways own a port without a ui-fittings record; merging both registries
    // is what separates "Garrison's own process" from a genuine squatter.
    const registered = [...c.readStatusFiles(), ...c.readGatewayRecords()];
    const accounted = new Set(registered.map((s) => s.port));
    const claimed = new Set(claims.map((x) => x.port));
    // Only the listeners that would otherwise be reported need identifying.
    const suspects = listeners.filter((l) => claimed.has(l.port) && !accounted.has(l.port));
    const commands = await c.readProcessCommands(suspects.map((l) => l.pid));
    const enriched = listeners.map((l) => (commands.has(l.pid) ? { ...l, cmdline: commands.get(l.pid) } : l));
    findings.push(...findPortCollisions(claims, enriched, registered));
  }

  if (run("serve-coverage")) {
    const serveMap = await c.readTailscaleServeMap();
    if (serveMap === null) {
      // One missing prerequisite, told once — in either mode. Reporting it as
      // N unmapped views (which is what the app-up path used to do) says the
      // same thing as a pile of failures.
      findings.push(mk("serve-coverage", "tailscale", "warn",
        "tailscale binary not found or `serve status --json` failed — serve coverage could not be checked, so unmapped views are unknown rather than broken.",
        { fix: "Install tailscale, or ignore this check on a node deliberately off the tailnet." }));
    } else {
      const views = appUp ? await c.fetchViews() : null;
      if (views) {
        findings.push(...serveCoverage({ views: views.map((v) => ({ fittingId: v.fittingId ?? v.id, port: v.port, tailnetUrl: v.tailnetUrl ?? null, healthy: v.healthy })) }));
      } else {
        findings.push(...serveCoverage({ statusFiles: c.readStatusFiles(), serveMap }));
      }
      findings.push(...findOrphanServeMappings(serveMap, listeners, c.readTetheredPorts()));
    }
  }

  if (run("orphans")) {
    findings.push(...classifyOrphans(c.readStatusFiles(), c.readSpawnRecords(), c.pidAlive));
  }

  if (run("drift")) {
    for (const x of compositions) findings.push(...assessDrift({ ...x, activeCompositionId }));
  }

  if (run("kind-vocabulary")) {
    findings.push(...scanKinds(manifests));
  }

  const pendingLibrary = await c.libraryChange(root);
  return {
    findings,
    summary: summarize(findings),
    degraded: !appUp,
    appUp,
    root,
    activeComposition: activeCompositionId,
    compositions: compositions.map((x) => x.compositionId),
    sweepableCompositions: records.filter((r) => ["idle", "failed"].includes(r.runnerState?.status)).map((r) => r.compositionId),
    // What the doctor DID, newest first — so a fixed row that vanishes from
    // the checks still has a visible, persistent trace. Each entry carries a
    // `resolved` verdict RE-CHECKED against current reality (not the fixer's
    // own claim): the library re-read, the composition re-parse.
    recentFixes: annotateResolution(await c.readFixJournal(20), {
      libraryIds: new Set(c.readCuratedLibrary(root).map((e) => e.id)),
      compositions
    }),
    // Continuation state for the library fixers: the uncommitted diff, so the
    // UI can show it and offer the scoped commit action.
    libraryDiff: pendingLibrary.diff,
    libraryDiffHash: pendingLibrary.diffHash,
    generatedAt: new Date().toISOString()
  };
}
