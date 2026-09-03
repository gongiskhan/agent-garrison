// Preflight core — every check as a pure function over already-parsed inputs.
// No fs, no network, no exec: collectors live in collect.mjs, and this module
// is what tests/preflight-fitting.test.ts exercises with plain fixtures.
//
// Finding shape (mirrors scripts/integration-check.mjs, plus `fix`):
//   { check, id, status: "pass" | "warn" | "fail", detail, evidence?, fix? }
// A check that finds nothing wrong emits a single pass row so the report
// always shows all seven sections, never a silent absence.

const STATUS_RANK = { pass: 0, warn: 1, fail: 2 };

export function mk(check, id, status, detail, extra = {}) {
  const finding = { check, id, status, detail };
  if (extra.evidence) finding.evidence = String(extra.evidence);
  if (extra.fix) finding.fix = String(extra.fix);
  // Optional executable fix: {id: <whitelisted action>, params, command} —
  // `command` is the human-readable description the UI shows in its confirm
  // dialog. The server only runs actions in the fixers.mjs registry.
  if (extra.action) finding.action = extra.action;
  return finding;
}

// ---------------------------------------------------------------------------
// Manifest / composition text parsing (pure text -> data, YAML-shaped but
// line-based on purpose: tests/mesh-serve-ports.test.ts sets the precedent of
// regex-scanning apm.yml, and a full YAML dependency is not available to a
// fitting that must also run from apm_modules/_local on a cold machine).
// ---------------------------------------------------------------------------

const PORT_KEY = /(^|_)port$/i;

// Extract what preflight needs from one fitting apm.yml.
export function parseManifest(text, id = "") {
  const ownPort = /^\s*own_port:\s*true\b/m.test(text);
  const dp = text.match(/^\s*default_port:\s*(\d+)\b/m);
  const defaultPort = dp ? Number(dp[1]) : null;

  // config_schema entries: `- key: X` ... `default: Y` until the next `- key:`.
  const portKeys = [];
  const schema = text.match(/^\s*config_schema:\s*$([\s\S]*?)(?=^\s{0,2}\S|\n?$(?![\s\S]))/m);
  if (schema) {
    const items = schema[1].split(/^\s*-\s+key:/m).slice(1);
    for (const item of items) {
      const key = (item.match(/^\s*([\w.-]+)/) || [])[1];
      const def = item.match(/^\s*default:\s*(\d+)\s*$/m);
      if (key && PORT_KEY.test(key) && def) portKeys.push({ key, default: Number(def[1]) });
    }
  }

  const kinds = [...text.matchAll(/^\s*-\s*kind:\s*([\w-]+)/gm)].map((m) => m[1]);
  return { id, ownPort, defaultPort, portKeys, kinds };
}

// Extract selections + unfitted from a composition apm.yml. Returns
// { selections: [{faculty, id, pins: [{key, value}]}], unfitted: [] }.
// pins are port-like numeric config keys only.
export function parseComposition(text) {
  const lines = text.split(/\r?\n/);
  const selections = [];
  const unfitted = [];
  let mode = null; // "selections" | "unfitted" | null
  let modeIndent = -1;
  let faculty = null;
  let facultyIndent = -1;
  let current = null;
  let inConfig = false;
  let configIndent = -1;

  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    if (/^selections:\s*$/.test(line)) { mode = "selections"; modeIndent = indent; faculty = null; current = null; continue; }
    if (/^unfitted:\s*$/.test(line)) { mode = "unfitted"; modeIndent = indent; faculty = null; current = null; continue; }
    if (mode && indent <= modeIndent) { mode = null; faculty = null; current = null; continue; }

    if (mode === "unfitted") {
      const m = line.match(/^-\s*([\w.-]+)\s*$/);
      if (m) unfitted.push(m[1]);
      continue;
    }
    if (mode !== "selections") continue;

    const fac = line.match(/^([\w-]+):\s*$/);
    if (fac && (faculty === null || indent <= facultyIndent)) {
      faculty = fac[1];
      facultyIndent = indent;
      current = null;
      continue;
    }
    const item = line.match(/^-\s*id:\s*([\w.-]+)\s*$/);
    if (item && faculty) {
      current = { faculty, id: item[1], pins: [] };
      selections.push(current);
      inConfig = false;
      continue;
    }
    if (/^config:\s*$/.test(line) && current) { inConfig = true; configIndent = indent; continue; }
    if (inConfig && current) {
      if (indent <= configIndent) { inConfig = false; continue; }
      const kv = line.match(/^([\w.-]+):\s*(\d+)\s*$/);
      if (kv && PORT_KEY.test(kv[1])) current.pins.push({ key: kv[1], value: Number(kv[2]) });
    }
  }
  return { selections, unfitted };
}

// ---------------------------------------------------------------------------
// Check 2 — library cross-check
// ---------------------------------------------------------------------------

export function crossCheckLibrary(seedIds, libraryEntries) {
  const findings = [];
  const libIds = new Set(libraryEntries.map((e) => e.id));
  const seedSet = new Set(seedIds);
  for (const id of [...seedIds].sort()) {
    if (!libIds.has(id)) {
      findings.push(mk("library-crosscheck", id, "fail",
        `fittings/seed/${id} has no entry in data/library.json — the resolver silently drops it and blames whatever consumed its capability.`,
        {
          fix: `Add {"id": "${id}", "name": ..., "repo": "local:fittings/seed/${id}", "localPath": "fittings/seed/${id}", "summary": ..., "platforms": ["claude-code"]} to data/library.json.`,
          action: { id: "library-add-entry", params: { fittingId: id }, command: `append a minimal entry for ${id} to data/library.json (summary from its manifest; uncommitted — review then commit)` }
        }));
    }
  }
  for (const entry of libraryEntries) {
    const local = entry.localPath || "";
    if (local.startsWith("fittings/seed/")) {
      const dir = local.slice("fittings/seed/".length).split("/")[0];
      if (!seedSet.has(dir)) {
        findings.push(mk("library-crosscheck", entry.id, "warn",
          `data/library.json entry "${entry.id}" points at ${local}, which does not exist on disk.`,
          {
            fix: `Remove the entry or restore ${local}.`,
            action: { id: "library-remove-entry", params: { entryId: entry.id }, command: `remove the "${entry.id}" entry from data/library.json (uncommitted — restore ${local} instead if it should exist)` }
          }));
      }
    }
  }
  if (!findings.length) {
    findings.push(mk("library-crosscheck", "all", "pass",
      `${seedIds.length} seed fittings and ${libraryEntries.length} library entries agree in both directions.`));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Check 3 — ports, two axes
// ---------------------------------------------------------------------------

export function servePort(localPort) {
  return 8400 + (localPort % 1000);
}

// Serve ports tailscale/mesh reserve for itself; a fitting whose derived serve
// port lands here collides with infrastructure, not another fitting.
const RESERVED_SERVE = new Set([8443, 8444, 8445]);

// manifests: parseManifest() outputs; compositions: [{compositionId, parsed}]
// where parsed is parseComposition() output.
export function buildPortClaims(manifests, compositions = []) {
  const claims = [];
  for (const m of manifests) {
    if (m.defaultPort != null) {
      claims.push({ port: m.defaultPort, claimant: m.id, source: "default_port" });
    }
    for (const pk of m.portKeys) {
      // default_port and a config_schema `port` default that agree are ONE
      // claim; when they disagree, or the schema adds health_port etc., each
      // distinct number is its own claim (the improver-hides-8093 lesson).
      if (pk.default !== m.defaultPort) {
        claims.push({ port: pk.default, claimant: m.id, source: `config_schema ${pk.key}` });
      }
    }
  }
  for (const c of compositions) {
    for (const sel of c.parsed.selections) {
      for (const pin of sel.pins) {
        claims.push({ port: pin.value, claimant: sel.id, source: `${c.compositionId} pin ${pin.key}` });
      }
    }
  }
  return claims;
}

export function findPortCollisions(claims, liveListeners = [], statusFiles = []) {
  const findings = [];
  const byPort = new Map();
  for (const c of claims) {
    if (!byPort.has(c.port)) byPort.set(c.port, []);
    byPort.get(c.port).push(c);
  }
  // Canonical axis.
  for (const [port, list] of [...byPort].sort((a, b) => a[0] - b[0])) {
    const names = new Set(list.map((c) => c.claimant));
    if (names.size > 1) {
      findings.push(mk("port-collisions", `canonical:${port}`, "fail",
        `Port ${port} is claimed by ${[...names].join(" and ")} (${list.map((c) => `${c.claimant} via ${c.source}`).join("; ")}).`,
        { fix: "Move one claimant to a free base port (8070-8075 were free at authoring time); remember the canonical port counts config_schema defaults too." }));
    }
  }
  // Serve axis: distinct canonical ports mapping to the same serve port.
  const byServe = new Map();
  for (const [port, list] of byPort) {
    const sp = servePort(port);
    if (!byServe.has(sp)) byServe.set(sp, new Map());
    byServe.get(sp).set(port, list);
  }
  for (const [sp, ports] of [...byServe].sort((a, b) => a[0] - b[0])) {
    if (ports.size > 1) {
      const desc = [...ports].map(([p, list]) => `${p} (${[...new Set(list.map((c) => c.claimant))].join(", ")})`).join(" and ");
      findings.push(mk("port-collisions", `serve:${sp}`, "fail",
        `Canonical ports ${desc} both derive serve port ${sp} (8400 + port % 1000).`,
        { fix: "A port must be free on BOTH axes: pick a canonical port whose serve derivation is also unclaimed." }));
    }
    if (RESERVED_SERVE.has(sp)) {
      const desc = [...ports].map(([p, list]) => `${p} (${[...new Set(list.map((c) => c.claimant))].join(", ")})`).join(", ");
      findings.push(mk("port-collisions", `serve-reserved:${sp}`, "fail",
        `Serve port ${sp} derived from ${desc} is reserved by tailscale serve itself.`,
        { fix: "Pick a canonical port whose 8400 + port % 1000 avoids 8443-8445." }));
    }
  }
  // Live axis: a listener on a claimed port owned by a different pid than the
  // fitting's own status file says.
  const statusByPort = new Map(statusFiles.map((s) => [s.port, s]));
  for (const l of liveListeners) {
    const claimsHere = byPort.get(l.port);
    if (!claimsHere) continue;
    const status = statusByPort.get(l.port);
    if (status && status.pid !== l.pid) {
      findings.push(mk("port-collisions", `live:${l.port}`, "warn",
        `Port ${l.port} is held by pid ${l.pid} (${l.command || "?"}) but ${status.fittingId}'s status file records pid ${status.pid}.`,
        { fix: `Check whether ${status.fittingId} crashed and something else took its port, or the status file is stale.` }));
    }
  }
  if (!findings.length) {
    findings.push(mk("port-collisions", "all", "pass",
      `${claims.length} port claims, no collisions on either axis.`));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Check 1 — verify results (passive from last-up.json, active from a sweep)
// ---------------------------------------------------------------------------

export function assessVerifyResults(records) {
  // records: [{compositionId, lastUp: {ok, at, verifyResults[]} | null,
  //            runnerState: {status, verifyResults[], lastError} | null}]
  //
  // Source priority: the LIVE runner state first — last-up.json is written only
  // after a SUCCESSFUL up, so a failed attempt leaves no record and the check
  // would go blind at exactly the moment it matters most. The runner keeps the
  // failed attempt's full VerifyResult[] in memory; when the app is up we read
  // it and report from there, falling back to last-up.json otherwise.
  const findings = [];
  for (const r of records) {
    const live = r.runnerState && Array.isArray(r.runnerState.verifyResults) && r.runnerState.verifyResults.length
      ? r.runnerState : null;
    const source = live
      ? { results: live.verifyResults, label: `the last attempt (runner status: ${live.status || "unknown"})` }
      : r.lastUp
        ? { results: r.lastUp.verifyResults || [], label: `the last up (${r.lastUp.at})` }
        : null;
    if (!source) {
      findings.push(mk("verify-results", r.compositionId, "warn",
        `${r.compositionId} has no verify record — no .garrison/last-up.json and no live runner state (it has never been brought up, or the app restarted since).`,
        {
          fix: "Run the verify sweep to get a first complete picture without attempting a full up().",
          // Not a fixers.mjs action: the UI routes this one to the existing
          // sweep flow (own endpoint, own confirm, own busy-guard).
          action: { id: "verify-sweep", params: { compositionId: r.compositionId }, command: `run EVERY fitting's verify for ${r.compositionId} via the app's own verify endpoint (heavy: flips runner status, may run apm install, runs setup hooks)` }
        }));
      continue;
    }
    const failed = source.results.filter((v) => !v.ok);
    for (const v of failed) {
      findings.push(mk("verify-results", `${r.compositionId}:${v.fittingId}`, "fail",
        `${v.fittingId} failed verify at ${source.label}: exit ${v.exitCode}, expected "${v.expect}" from \`${v.command}\`.`,
        {
          evidence: [v.stderr, v.stdout].filter(Boolean).join("\n").slice(0, 2000),
          fix: `Fix ${v.fittingId}'s verify and re-run the sweep — or unstation it so up() can proceed without it (one failing fitting blocks the whole composition). Unlike up(), this list is complete.`,
          // The clickable half: parking the broken fitting. Repairing the
          // fitting itself (a missing repo, binary, credential) stays human.
          action: { id: "unstation-fitting", params: { compositionId: r.compositionId, fittingId: v.fittingId }, command: `UNSTATION ${v.fittingId} from ${r.compositionId} (PUT without it + state-service push) — the composition runs without this fitting until you re-add it via Muster` }
        }));
    }
    if (!failed.length) {
      findings.push(mk("verify-results", r.compositionId, "pass",
        `${source.results.length} fittings verified ok at ${source.label}.`));
    }
  }
  if (!records.length) {
    findings.push(mk("verify-results", "none", "warn", "No compositions found."));
  }
  return findings;
}

export function assessSweepResults(compositionId, results) {
  const findings = [];
  for (const v of results) {
    findings.push(mk("verify-sweep", `${compositionId}:${v.fittingId}`, v.ok ? "pass" : "fail",
      v.ok
        ? `${v.fittingId} ok in ${v.durationMs}ms.`
        : `${v.fittingId} failed: exit ${v.exitCode}, expected "${v.expect}" from \`${v.command}\`.`,
      v.ok ? {} : {
        evidence: [v.error, v.stderr, v.stdout].filter(Boolean).join("\n").slice(0, 2000),
        fix: `Fix ${v.fittingId}'s verify — or unstation it so up() can proceed. This sweep ran EVERY fitting; nothing is hidden behind the first failure.`,
        action: { id: "unstation-fitting", params: { compositionId, fittingId: v.fittingId }, command: `UNSTATION ${v.fittingId} from ${compositionId} (PUT without it + state-service push) — the composition runs without this fitting until you re-add it via Muster` }
      }));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Check 4 — tailscale serve coverage
// ---------------------------------------------------------------------------

export function serveCoverage(input) {
  const findings = [];
  if (input.views) {
    // App-enriched mode: /api/fittings/views rows with tailnetUrl + health.
    for (const v of input.views) {
      if (!v.tailnetUrl) {
        findings.push(mk("serve-coverage", v.fittingId, "fail",
          `${v.fittingId} (port ${v.port}) has no tailscale serve mapping — remote viewers get tailnetUrl null, the UI falls back to the VIEWER's 127.0.0.1, and the view renders blank.`,
          {
            fix: "Run scripts/tailnet-serve-views.mjs (or tailnet-publish) to map it; expected serve port " + servePort(v.port) + ".",
            action: { id: "tailscale-serve-map", params: { port: v.port }, command: `tailscale serve --bg --https=${servePort(v.port)} http://127.0.0.1:${v.port}` }
          }));
      } else if (v.healthy === false) {
        findings.push(mk("serve-coverage", v.fittingId, "warn",
          `${v.fittingId} is serve-mapped at ${v.tailnetUrl} but its /health probe failed.`,
          { fix: `Check ~/.garrison/ui-fittings/${v.fittingId}.log.` }));
      }
    }
    if (!findings.length) {
      findings.push(mk("serve-coverage", "all", "pass",
        `${input.views.length} own-port views all mapped and healthy.`));
    }
    return findings;
  }
  // Degraded mode: status files + tailscale serve map parsed directly.
  const mapped = new Set(Object.keys(input.serveMap || {}).map(Number));
  for (const s of input.statusFiles || []) {
    if (!mapped.has(s.port)) {
      findings.push(mk("serve-coverage", s.fittingId, "fail",
        `${s.fittingId} (port ${s.port}) has no tailscale serve mapping (checked directly; app down).`,
        {
          fix: "Run scripts/tailnet-serve-views.mjs; expected serve port " + servePort(s.port) + ".",
          action: { id: "tailscale-serve-map", params: { port: s.port }, command: `tailscale serve --bg --https=${servePort(s.port)} http://127.0.0.1:${s.port}` }
        }));
    }
  }
  if (!findings.length) {
    findings.push(mk("serve-coverage", "all", "pass",
      `${(input.statusFiles || []).length} running own-port fittings all serve-mapped.`));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Check 5 — orphan processes (report only, never kill)
// ---------------------------------------------------------------------------

export function classifyOrphans(statusFiles, spawnRecords, isAlive) {
  const findings = [];
  const statusIds = new Set(statusFiles.map((s) => s.fittingId));
  for (const s of statusFiles) {
    if (s.pid && !isAlive(s.pid)) {
      findings.push(mk("orphans", s.fittingId, "warn",
        `Status file ~/.garrison/ui-fittings/${s.fittingId}.json records pid ${s.pid}, which is dead — the view row is stale.`,
        { fix: "The fitting exited without cleanup (crash or SIGKILL); the next up() rewrites it. Check its .log for why it died." }));
    }
  }
  for (const r of spawnRecords) {
    if (r.pid && isAlive(r.pid) && !statusIds.has(r.fittingId)) {
      findings.push(mk("orphans", r.fittingId, "fail",
        `Spawn ledger records ${r.fittingId} pid ${r.pid} STILL RUNNING with no status file — an orphan process (the local-voice server.py class of leak).`,
        { fix: `Inspect \`ps -p ${r.pid}\`; the runner's reconciler reaps it on the next up(), or kill it manually. Preflight never kills.` }));
    }
  }
  if (!findings.length) {
    findings.push(mk("orphans", "all", "pass",
      `${statusFiles.length} status files and ${spawnRecords.length} spawn records, all consistent with live processes.`));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Check 6 — composition drift + unfitted re-station
// ---------------------------------------------------------------------------

export function assessDrift(input) {
  // input: {compositionId, lastUp: {at, ok}|null, manifestMtimesMs: {}|null,
  //         diskSelections: string[]|null, headSelections: string[]|null,
  //         unfitted: string[], diffStat: string|null}
  const findings = [];
  const cid = input.compositionId;
  const unfit = new Set(input.unfitted || []);

  if (input.lastUp && input.manifestMtimesMs) {
    const upAt = Date.parse(input.lastUp.at);
    const stale = Object.entries(input.manifestMtimesMs)
      .filter(([, ms]) => ms != null && Number.isFinite(upAt) && ms > upAt)
      .map(([f]) => f);
    if (stale.length) {
      findings.push(mk("drift", `${cid}:stale`, "warn",
        `${cid} changed since its last verified up (${input.lastUp.at}): ${stale.join(", ")} newer than the last-up record — the fast path will NOT apply and a full install/setup/verify will run.`,
        { fix: "Expected after edits; run the verify sweep before up() to see what the changes broke." }));
    }
  }

  if (input.diskSelections && input.headSelections) {
    const disk = new Set(input.diskSelections);
    const head = new Set(input.headSelections);
    for (const id of [...disk].sort()) {
      if (!head.has(id) && !unfit.has(id)) {
        findings.push(mk("drift", `${cid}:${id}`, "fail",
          `${id} is selected on disk but not at git HEAD and not recorded in \`unfitted\` — it appears to have RE-STATIONED ITSELF (a fitting removed from selections without an unfitted record re-adds itself on the next read; compositions.ts writeComposition).`,
          {
            fix: `PUT the composition WITHOUT ${id} in selections — writeComposition derives \`unfitted\` from the sent selections and records the opt-out. Editing apm.yml by hand does not stick.`,
            action: { id: "unstation-fitting", params: { compositionId: cid, fittingId: id }, command: `PUT ${cid} without ${id} in selections (records the opt-out), then push the manifest to the state service so the next up() cannot revert it` }
          }));
      }
    }
    for (const id of [...head].sort()) {
      if (!disk.has(id) && !unfit.has(id)) {
        findings.push(mk("drift", `${cid}:${id}`, "warn",
          `${id} was removed from ${cid}'s selections but is NOT in \`unfitted\` — the next read will re-add it and silently undo the removal.`,
          {
            fix: `PUT the composition without ${id} in selections so it lands in \`unfitted\`, or accept that it will come back.`,
            action: { id: "unstation-fitting", params: { compositionId: cid, fittingId: id }, command: `PUT ${cid} without ${id} in selections (records the opt-out), then push the manifest to the state service` }
          }));
      }
    }
  }

  if (input.diffStat && input.diffStat.trim()) {
    findings.push(mk("drift", `${cid}:uncommitted`, "warn",
      `${cid}/apm.yml differs from git HEAD (the runner re-authors this file; a diff here may be legitimate or may be an unwanted rewrite).`,
      { evidence: input.diffStat.trim().slice(0, 2000), fix: "Review the diff; commit deliberate changes, restore unwanted ones." }));
  }

  if (!input.lastUp) {
    findings.push(mk("drift", `${cid}:no-record`, "warn",
      `${cid} has no last-up record — drift against the last verified state cannot be assessed.`));
  }

  if (!findings.length) {
    findings.push(mk("drift", cid, "pass", `${cid} matches its last verified up and git HEAD.`));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Check 7 — retired capability kinds
// ---------------------------------------------------------------------------

export const RETIRED_KINDS = ["agent-skill", "soul"];

export function scanKinds(manifests, retired = RETIRED_KINDS) {
  const findings = [];
  const bad = new Set(retired);
  for (const m of manifests) {
    const hits = [...new Set((m.kinds || []).filter((k) => bad.has(k)))];
    for (const k of hits) {
      findings.push(mk("kind-vocabulary", m.id, "fail",
        `${m.id} declares retired capability kind "${k}" — registering it 500s /api/compositions and takes the whole Muster UI down.`,
        { fix: `Replace "${k}" with the current kind for this shape (it was dropped in the Quarters pivot).` }));
    }
  }
  if (!findings.length) {
    findings.push(mk("kind-vocabulary", "all", "pass",
      `${manifests.length} manifests, no retired kinds (${retired.join(", ")}).`));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export function summarize(findings) {
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const f of findings) counts[f.status] = (counts[f.status] || 0) + 1;
  const overall = counts.fail ? "fail" : counts.warn ? "warn" : "pass";
  return { overall, counts };
}

export function worstOf(a, b) {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}
