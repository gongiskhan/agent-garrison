// Preflight core — every check as a pure function over already-parsed inputs.
// No fs, no network, no exec: collectors live in collect.mjs, and this module
// is what tests/preflight-fitting.test.ts exercises with plain fixtures.
//
// Finding shape (mirrors scripts/integration-check.mjs, plus `fix`):
//   { check, id, status: "info" | "pass" | "warn" | "fail", detail, evidence?, fix? }
//
// `info` means "true, checked, and nothing to do about it right now". It exists
// so a fact can stay on the page without being counted against the machine —
// a doctor that reports FAIL every day for things nobody can act on trains you
// to stop reading it, which is the one failure mode it cannot afford.
// A check that finds nothing wrong emits a single pass row so the report
// always shows all seven sections, never a silent absence.

// Historical skeletons deliberately excluded from the registry after the
// faculties-as-roles pivot (tests/seed.test.ts). Registering them is not a repair.
export const RETIRED_SEED_IDS = new Set([
  "coding-subagent", "documents", "projects-index", "testing", "tier-classifier"
]);

// Demotion is NEVER suppression. The finding keeps its place in the report and
// its text, and gains the reason it was demoted. Only `warn` may be demoted, so
// a bug in a caller can never turn a real failure into a whisper.
// `reasonKey` names the reason in lib/messages.pt.mjs; the translation layer
// rebuilds the demoted sentence from its parts rather than editing this one.
export function demote(finding, reason, reasonKey = null) {
  if (finding.status !== "warn") return finding;
  const next = { ...finding, status: "info", detail: `${finding.detail} (${reason})` };
  if (finding.i18n && reasonKey) next.i18n = { ...finding.i18n, demote: reasonKey };
  return next;
}

// `extra.i18n` = { key, vars }: the message key this English sentence was
// written under, and the values it interpolated. English stays authored HERE,
// where the check is read; the key lets lib/i18n.mjs re-render the same finding
// in another language and is stripped before the finding leaves buildReport.
export function mk(check, id, status, detail, extra = {}) {
  const finding = { check, id, status, detail };
  if (extra.evidence) finding.evidence = String(extra.evidence);
  if (extra.fix) finding.fix = String(extra.fix);
  // Optional executable fix: {id: <whitelisted action>, params, command} —
  // `command` is the human-readable description the UI shows in its confirm
  // dialog. The server only runs actions in the fixers.mjs registry.
  if (extra.action) finding.action = extra.action;
  if (extra.i18n) finding.i18n = extra.i18n;
  return finding;
}

// ---------------------------------------------------------------------------
// Manifest / composition text parsing (pure text -> data, YAML-shaped but
// line-based on purpose: tests/mesh-serve-ports.test.ts sets the precedent of
// regex-scanning apm.yml, and a full YAML dependency is not available to a
// fitting that must also run from apm_modules/_local on a cold machine).
// ---------------------------------------------------------------------------

const PORT_KEY = /(^|_)port$/i;

// The lines under `config_schema:` — everything indented deeper than the key
// itself, whatever depth that key sits at.
function configSchemaBlock(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*config_schema:\s*$/.test(l));
  if (start < 0) return null;
  const indent = lines[start].length - lines[start].trimStart().length;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { out.push(line); continue; }
    if (line.length - line.trimStart().length <= indent) break;
    out.push(line);
  }
  return out.length ? out.join("\n") : null;
}

// Extract what preflight needs from one fitting apm.yml.
export function parseManifest(text, id = "") {
  const ownPort = /^\s*own_port:\s*true\b/m.test(text);
  const dp = text.match(/^\s*default_port:\s*(\d+)\b/m);
  const defaultPort = dp ? Number(dp[1]) : null;

  // config_schema entries: `- key: X` ... `default: Y` until the next `- key:`.
  // Scanned by indentation rather than matched by one regex: the old lookahead
  // assumed the block was nested under x-garrison and silently found NOTHING
  // for a top-level config_schema — a silent miss in the very check that exists
  // because improver hid a port claim in a config_schema default.
  const portKeys = [];
  const configKeys = [];
  const block = configSchemaBlock(text);
  if (block) {
    const items = block.split(/^\s*-\s+key:/m).slice(1);
    for (const item of items) {
      const key = (item.match(/^\s*([\w.-]+)/) || [])[1];
      if (!key) continue;
      const type = (item.match(/^\s*type:\s*([\w-]+)\s*$/m) || [])[1] || null;
      const rawDefault = (item.match(/^\s*default:\s*(.*?)\s*$/m) || [])[1] ?? null;
      configKeys.push({ key, type, default: rawDefault });
      const def = item.match(/^\s*default:\s*(\d+)\s*$/m);
      if (PORT_KEY.test(key) && def) portKeys.push({ key, default: Number(def[1]) });
    }
  }

  const kinds = [...text.matchAll(/^\s*-\s*kind:\s*([\w-]+)/gm)].map((m) => m[1]);
  return { id, ownPort, defaultPort, portKeys, configKeys, kinds };
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
    if (RETIRED_SEED_IDS.has(id)) continue;
    if (!libIds.has(id)) {
      findings.push(mk("library-crosscheck", id, "fail",
        `fittings/seed/${id} has no entry in data/library.json — the resolver silently drops it and blames whatever consumed its capability.`,
        {
          fix: `Add {"id": "${id}", "name": ..., "repo": "local:fittings/seed/${id}", "localPath": "fittings/seed/${id}", "summary": ..., "platforms": ["claude-code"]} to data/library.json.`,
          action: { id: "library-add-entry", params: { fittingId: id }, command: `append a minimal entry for ${id} to data/library.json (summary from its manifest; uncommitted — review then commit)` },
          i18n: { key: "library-crosscheck.unregistered", vars: { id } }
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
            action: { id: "library-remove-entry", params: { entryId: entry.id }, command: `remove the "${entry.id}" entry from data/library.json (uncommitted — restore ${local} instead if it should exist)` },
            i18n: { key: "library-crosscheck.dangling", vars: { id: entry.id, path: local } }
          }));
      }
    }
  }
  if (!findings.length) {
    findings.push(mk("library-crosscheck", "all", "pass",
      `${seedIds.length} seed fittings and ${libraryEntries.length} library entries agree in both directions.`,
      { i18n: { key: "library-crosscheck.ok", vars: { seeds: seedIds.length, entries: libraryEntries.length } } }));
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
// What the real publishers refuse: src/lib/tailnet-publish.ts:83 and
// scripts/tailnet-serve-views.mjs:60 both skip 8443/8444/8445 AND 443.
const RESERVED_SERVE = new Set([443, 8443, 8444, 8445]);

// manifests: parseManifest() outputs; compositions: [{compositionId, parsed}]
// where parsed is parseComposition() output.
export function buildPortClaims(manifests, compositions = []) {
  const claims = [];
  // Where each fitting is stationed, and which of its port keys each
  // composition overrides. A composition pin is an OVERRIDE of the manifest
  // default, not an extra claim beside it: treating it as an extra claim meant
  // that resolving a collision the supported way (pinning one side) left the
  // collision being reported as a failure forever.
  const stationedIn = new Map();
  const pinsByKey = new Map();
  for (const c of compositions) {
    for (const sel of c.parsed.selections) {
      if (!stationedIn.has(sel.id)) stationedIn.set(sel.id, []);
      stationedIn.get(sel.id).push(c.compositionId);
      for (const pin of sel.pins) {
        const k = `${sel.id}:${pin.key}`;
        if (!pinsByKey.has(k)) pinsByKey.set(k, []);
        pinsByKey.get(k).push({ compositionId: c.compositionId, port: pin.value });
      }
    }
  }
  const scoped = (claim, id, key) => ({
    ...claim, key,
    stationedIn: stationedIn.get(id) ?? [],
    pins: pinsByKey.get(`${id}:${key}`) ?? []
  });
  for (const m of manifests) {
    if (m.defaultPort != null) {
      claims.push(scoped({ port: m.defaultPort, claimant: m.id, source: "default_port" }, m.id, "port"));
    }
    for (const pk of m.portKeys) {
      // default_port and a config_schema `port` default that agree are ONE
      // claim; when they disagree, or the schema adds health_port etc., each
      // distinct number is its own claim (the improver-hides-8093 lesson).
      if (pk.default !== m.defaultPort) {
        claims.push(scoped({ port: pk.default, claimant: m.id, source: `config_schema ${pk.key}` }, m.id, pk.key));
      }
    }
  }
  for (const c of compositions) {
    for (const sel of c.parsed.selections) {
      for (const pin of sel.pins) {
        claims.push({ port: pin.value, claimant: sel.id, source: `${c.compositionId} pin ${pin.key}`, key: pin.key, pinned: true, stationedIn: [c.compositionId], pins: [] });
      }
    }
  }
  return claims;
}

// A manifest default that EVERY composition stationing the fitting overrides
// with a pin is a number the fitting never actually binds.
function bindsItsDeclaredPort(claim) {
  if (claim.pinned) return true;
  const stationed = claim.stationedIn ?? [];
  if (!stationed.length) return true;
  const pinnedAway = new Set((claim.pins ?? []).map((p) => p.compositionId));
  return stationed.some((cid) => !pinnedAway.has(cid));
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
    if (names.size <= 1) continue;
    const effective = list.filter(bindsItsDeclaredPort);
    const namesText = [...names].join(" and ");
    if (new Set(effective.map((c) => c.claimant)).size > 1) {
      const sources = list.map((c) => `${c.claimant} via ${c.source}`).join("; ");
      findings.push(mk("port-collisions", `canonical:${port}`, "fail",
        `Port ${port} is claimed by ${namesText} (${sources}).`,
        { fix: "Move one claimant to a free base port (8070-8075 were free at authoring time); remember the canonical port counts config_schema defaults too.",
          i18n: { key: "port-collisions.canonical", vars: { port, names: [...names].join(" e "), sources } } }));
    } else {
      const pinnedAway = list.filter((c) => !effective.includes(c));
      const pinned = [...new Set(pinnedAway.map((c) => c.claimant))].join(", ");
      const compositions = [...new Set(pinnedAway.flatMap((c) => (c.pins ?? []).map((p) => p.compositionId)))].join(", ");
      findings.push(mk("port-collisions", `canonical:${port}`, "warn",
        `Port ${port} is declared by ${namesText}, but ${pinned} is pinned to another port in every composition that stations it, so nothing binds ${port} twice today.`,
        { fix: `Nothing to do while those pins stand. Removing or changing the pin in ${compositions || "the composition"} makes this a real collision again.`,
          i18n: { key: "port-collisions.pinnedAway", vars: { port, names: [...names].join(" e "), pinned, compositions: compositions || "a composição" } } }));
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
    const describe = (sep) => [...ports].map(([p, list]) => `${p} (${[...new Set(list.map((c) => c.claimant))].join(", ")})`).join(sep);
    if (ports.size > 1) {
      findings.push(mk("port-collisions", `serve:${sp}`, "fail",
        `Canonical ports ${describe(" and ")} both derive serve port ${sp} (8400 + port % 1000). The publisher will NOT fail — it bumps the second past ${sp} — and that is the damage: the mesh assumes a peer's view URL is computable as 8400 + port % 1000 without asking the peer, so a bumped mapping becomes unreachable at the address other nodes compute for it.`,
        { fix: "Pick a canonical port whose serve derivation is also unclaimed, so no bump is needed (scripts/tailnet-serve-views.mjs:50-57; the invariant is pinned by tests/mesh-serve-ports.test.ts).",
          i18n: { key: "port-collisions.serve", vars: { desc: describe(" e "), sp } } }));
    }
    if (RESERVED_SERVE.has(sp)) {
      findings.push(mk("port-collisions", `serve-reserved:${sp}`, "fail",
        `Serve port ${sp} derived from ${describe(", ")} is reserved by tailscale serve itself.`,
        { fix: "Pick a canonical port whose 8400 + port % 1000 avoids 8443-8445.",
          i18n: { key: "port-collisions.serveReserved", vars: { sp, desc: describe(", ") } } }));
    }
  }
  // Live axis: a listener on a claimed port owned by a different pid than the
  // fitting's own status file says.
  const statusByPort = new Map(statusFiles.map((s) => [s.port, s]));
  const seenLive = new Set();
  for (const l of liveListeners) {
    const claimsHere = byPort.get(l.port);
    // lsof reports one row per socket, so a dual-stack listener appears twice.
    if (!claimsHere || seenLive.has(l.port)) continue;
    seenLive.add(l.port);
    const status = statusByPort.get(l.port);
    if (status && status.pid !== l.pid) {
      findings.push(mk("port-collisions", `live:${l.port}`, "warn",
        `Port ${l.port} is held by pid ${l.pid} (${l.command || "?"}) but ${status.fittingId}'s status file records pid ${status.pid}.`,
        { fix: `Check whether ${status.fittingId} crashed and something else took its port, or the status file is stale.`,
          i18n: { key: "port-collisions.livePidMismatch", vars: { port: l.port, pid: l.pid, command: l.command || "?", fittingId: status.fittingId, recordedPid: status.pid } } }));
    } else if (!status) {
      // The 8080-held-by-an-unrelated-Java-service incident this fitting's own
      // manifest cites. Requiring a status file to disagree meant the squatter
      // that registers NOTHING — the only kind that is never Garrison's — was
      // the one case the check could not see.
      const claimants = [...new Set(claimsHere.map((c) => c.claimant))];
      // Some Garrison processes register nowhere (the scheduler daemon writes
      // no status file and no pid record), so absence of a record is not proof
      // of a squatter. If the command line names the claimant, it IS the
      // claimant — reporting that every run would be exactly the permanent
      // noise this check is supposed to cut through.
      if (l.cmdline && claimants.some((id) => l.cmdline.includes(id))) continue;
      const cmd = `lsof -nP -iTCP:${l.port} -sTCP:LISTEN`;
      findings.push(mk("port-collisions", `live:${l.port}`, "warn",
        `Port ${l.port} is claimed by ${claimants.join(" and ")} but is already held by pid ${l.pid} (${l.command || "?"}), which registered no status file — the claimant cannot bind it.`,
        { fix: `Identify the holder with \`${cmd}\`, then stop it or move the claimant to a free port (both axes).`,
          i18n: { key: "port-collisions.squatter", vars: { port: l.port, claimants: claimants.join(" e "), pid: l.pid, command: l.command || "?", cmd } } }));
    }
  }
  if (!findings.length) {
    findings.push(mk("port-collisions", "all", "pass",
      `${claims.length} port claims, no collisions on either axis.`,
      { i18n: { key: "port-collisions.ok", vars: { n: claims.length } } }));
  }
  return findings;
}

// A listener on a claimed port SHIFTED by another profile's offset is that
// profile's sandbox, not a squatter — dev runs the same fittings at +10000.
// Reported so the ports page accounts for every listener it can explain, and
// deliberately informational: a running sandbox is not a problem.
export function attributeSandboxListeners(claims, liveListeners, { profile = "node", offsets = {} } = {}) {
  const findings = [];
  const byPort = new Map();
  for (const c of claims) if (!byPort.has(c.port)) byPort.set(c.port, c.claimant);
  const seen = new Set();
  for (const l of liveListeners) {
    if (byPort.has(l.port) || seen.has(l.port)) continue;
    for (const [name, offset] of Object.entries(offsets)) {
      if (name === profile || !offset) continue;
      const base = l.port - offset;
      if (!byPort.has(base)) continue;
      seen.add(l.port);
      findings.push(mk("port-collisions", `sandbox:${l.port}`, "info",
        `Port ${l.port} is ${byPort.get(base)}'s base port ${base} shifted by the ${name} profile (+${offset}) — the ${name} sandbox is running, which is expected and not a conflict.`,
        { i18n: { key: "port-collisions.sandbox", vars: { port: l.port, owner: byPort.get(base), base, profile: name, offset } } }));
      break;
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Check 1 — verify results (passive from last-up.json, active from a sweep)
// ---------------------------------------------------------------------------

export function assessVerifyResults(records, { activeCompositionId = null } = {}) {
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
      ? { results: live.verifyResults, label: `the last attempt (runner status: ${live.status || "unknown"})`,
          labelMsg: { key: "verify-results.label.attempt", vars: { status: live.status || "unknown" } } }
      : r.lastUp
        ? { results: r.lastUp.verifyResults || [], label: `the last up (${r.lastUp.at})`,
            labelMsg: { key: "verify-results.label.lastUp", vars: { at: r.lastUp.at } } }
        : null;
    if (!source) {
      // A composition nobody is running having never been brought up is not a
      // problem with the machine, and offering it an armed heavy-sweep button
      // is the same hazard as defaulting the sweep target to it.
      const isActive = !activeCompositionId || activeCompositionId === r.compositionId;
      const row = mk("verify-results", r.compositionId, "warn",
        `${r.compositionId} has no verify record — no .garrison/last-up.json and no live runner state (it has never been brought up, or the app restarted since).`,
        {
          fix: "Run the verify sweep to get a first complete picture without attempting a full up().",
          // Not a fixers.mjs action: the UI routes this one to the existing
          // sweep flow (own endpoint, own confirm, own busy-guard).
          ...(isActive ? { action: { id: "verify-sweep", params: { compositionId: r.compositionId }, command: `run EVERY fitting's verify for ${r.compositionId} via the app's own verify endpoint (heavy: flips runner status, may run apm install, runs setup hooks)` } } : {}),
          i18n: { key: "verify-results.noRecord", vars: { cid: r.compositionId } }
        });
      findings.push(isActive ? row : demote(row, `${r.compositionId} is not the active composition — nothing to assess until it is brought up`, "demote.notActive"));
      continue;
    }
    const failed = source.results.filter((v) => !v.ok);
    for (const v of failed) {
      findings.push(mk("verify-results", `${r.compositionId}:${v.fittingId}`, "fail",
        `${v.fittingId} failed verify at ${source.label}: exit ${v.exitCode}, expected "${v.expect}" from \`${v.command}\`.`,
        {
          evidence: [v.stderr, v.stdout].filter(Boolean).join("\n").slice(0, 2000),
          fix: `Fix ${v.fittingId}'s verify and re-run the sweep — or unstation it so up() can proceed without it (one failing fitting blocks the whole composition). Unlike up()'s error, which names only the first, this list is complete.`,
          // The clickable half: parking the broken fitting. Repairing the
          // fitting itself (a missing repo, binary, credential) stays human.
          action: { id: "unstation-fitting", params: { compositionId: r.compositionId, fittingId: v.fittingId }, command: `UNSTATION ${v.fittingId} from ${r.compositionId} (through Garrison's manifest writer) — the composition runs without this fitting until you re-add it via Muster` },
          i18n: { key: "verify-results.failed", vars: { fittingId: v.fittingId, cid: r.compositionId, label: source.labelMsg, exitCode: v.exitCode, expect: v.expect, command: v.command } }
        }));
    }
    if (!failed.length) {
      findings.push(mk("verify-results", r.compositionId, "pass",
        `${source.results.length} fittings verified ok at ${source.label}.`,
        { i18n: { key: "verify-results.ok", vars: { n: source.results.length, label: source.labelMsg } } }));
    }
  }
  if (!records.length) {
    findings.push(mk("verify-results", "none", "warn", "No compositions found.", { i18n: { key: "verify-results.none", vars: {} } }));
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
      v.ok ? { i18n: { key: "verify-sweep.ok", vars: { fittingId: v.fittingId, ms: v.durationMs } } } : {
        evidence: [v.error, v.stderr, v.stdout].filter(Boolean).join("\n").slice(0, 2000),
        fix: `Fix ${v.fittingId}'s verify — or unstation it so up() can proceed. This sweep ran EVERY fitting; nothing is hidden behind the first failure.`,
        action: { id: "unstation-fitting", params: { compositionId, fittingId: v.fittingId }, command: `UNSTATION ${v.fittingId} from ${compositionId} (through Garrison's manifest writer) — the composition runs without this fitting until you re-add it via Muster` },
        i18n: { key: "verify-sweep.failed", vars: { fittingId: v.fittingId, cid: compositionId, exitCode: v.exitCode, expect: v.expect, command: v.command } }
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
            action: { id: "tailscale-serve-map", params: { port: v.port }, command: "publish missing view mappings using this node's supported scripts/tailnet-serve-views.mjs publisher (node profile only)" },
            i18n: { key: "serve-coverage.unmapped", vars: { fittingId: v.fittingId, port: v.port, servePort: servePort(v.port) } }
          }));
      } else if (v.healthy === false) {
        findings.push(mk("serve-coverage", v.fittingId, "warn",
          `${v.fittingId} is serve-mapped at ${v.tailnetUrl} but its /health probe failed.`,
          { fix: `Check ~/.garrison/ui-fittings/${v.fittingId}.log.`,
            i18n: { key: "serve-coverage.unhealthy", vars: { fittingId: v.fittingId, url: v.tailnetUrl } } }));
      }
    }
    if (!findings.length) {
      findings.push(mk("serve-coverage", "all", "pass",
        `${input.views.length} own-port views all mapped and healthy.`,
        { i18n: { key: "serve-coverage.okViews", vars: { n: input.views.length } } }));
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
          action: { id: "tailscale-serve-map", params: { port: s.port }, command: "publish missing view mappings using this node's supported scripts/tailnet-serve-views.mjs publisher (node profile only)" },
          i18n: { key: "serve-coverage.unmappedDegraded", vars: { fittingId: s.fittingId, port: s.port, servePort: servePort(s.port) } }
        }));
    }
  }
  if (!findings.length) {
    findings.push(mk("serve-coverage", "all", "pass",
      `${(input.statusFiles || []).length} running own-port fittings all serve-mapped.`,
      { i18n: { key: "serve-coverage.okStatus", vars: { n: (input.statusFiles || []).length } } }));
  }
  return findings;
}

// A serve mapping whose local port has nothing listening is a reachable tailnet
// URL that renders nothing. Check 4 asks "does this running view have a
// mapping?"; this asks the converse, "does this mapping still lead anywhere?",
// and only the pair covers the blank-page failure in both directions.
export function findOrphanServeMappings(serveMap, liveListeners, tetheredPorts = new Set()) {
  const findings = [];
  const live = new Set(liveListeners.map((l) => l.port));
  const orphans = Object.keys(serveMap || {}).map(Number)
    .filter((p) => Number.isInteger(p) && !live.has(p) && !tetheredPorts.has(p))
    .sort((a, b) => a - b);
  if (orphans.length) {
    findings.push(mk("serve-coverage", "orphan-mappings", "warn",
      `${orphans.length} tailscale serve mapping(s) point at a local port with no listener: ${orphans.join(", ")}. Each is a reachable tailnet URL that renders nothing.`,
      { fix: "Remove the stale mappings with `tailscale serve --https=<servePort> off`, or start what should be behind them. Preflight never edits the tailnet.",
        i18n: { key: "serve-coverage.orphanMappings", vars: { n: orphans.length, list: orphans.join(", ") } } }));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Check 8 — setup/verify hook cwd asymmetry
//
// The runner runs a fitting's SETUP from the seed directory (runner.ts:1465)
// and its VERIFY from the composition directory (runner.ts:1625). Any path a
// script derives by walking up from its own location therefore resolves to two
// different places in the two hooks — and a script that BRANCHES on such a
// path will take opposite branches in setup and verify.
//
// This is not hypothetical: basic-memory computes the same
// MODULES_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)" in both scripts, so setup
// looks for the kanban fitting under fittings/ (never there) and tears its
// consumer down, while verify looks under <composition>/apm_modules (present)
// and demands that consumer exists. The composition has been unable to come up
// since.
// ---------------------------------------------------------------------------

// `NAME="$(cd "$SCRIPT_DIR/../.." && pwd)"` — an ancestor walk from the script.
const WALK_UP = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)="\$\(cd "\$([A-Za-z_][A-Za-z0-9_]*)((?:\/\.\.)+)"[ \t]*&&[ \t]*pwd\)"/gm;
// `NAME="$OTHER/suffix"` — a path derived from one of the above.
const DERIVED = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)="\$([A-Za-z_][A-Za-z0-9_]*)(\/[^"$]*)"/gm;

// The guard basic-memory already applies to ONE of its blocks (setup.sh:274):
// checking what the derived root actually is before trusting it.
const GUARD = /basename[ \t]+"\$([A-Za-z_][A-Za-z0-9_]*)"/;

// Resolve every ancestor-walk / derived variable in a script, given where that
// script's own directory is. Returns Map<name, {path, expr}>.
export function resolveScriptPaths(text, scriptDir, join) {
  const vars = new Map([["SCRIPT_DIR", { path: scriptDir, expr: "$SCRIPT_DIR" }]]);
  const walks = [...text.matchAll(WALK_UP)];
  const derived = [...text.matchAll(DERIVED)];
  for (const [, name, base, dots] of walks) {
    const from = vars.get(base);
    if (!from) continue;
    vars.set(name, { path: join(from.path, dots), expr: `$${base}${dots}` });
  }
  for (const [, name, base, suffix] of derived) {
    const from = vars.get(base);
    if (!from || vars.has(name)) continue;
    vars.set(name, { path: join(from.path, suffix), expr: `$${base}${suffix}` });
  }
  return vars;
}

// entries: [{ id, vars: [{name, expr, setupPath, verifyPath, setupExists,
//            verifyExists, guarded}] }]
export function findHookCwdAsymmetry(entries) {
  const findings = [];
  for (const entry of entries) {
    for (const v of entry.vars || []) {
      if (v.setupPath === v.verifyPath) continue;
      if (v.guarded) {
        findings.push(mk("hook-cwd", `${entry.id}:${v.name}`, "info",
          `${entry.id}'s ${v.name} resolves differently in setup and verify, but the script checks what it resolved to before trusting it.`,
          { i18n: { key: "hook-cwd.guarded", vars: { id: entry.id, name: v.name } } }));
        continue;
      }
      // Both hooks agreeing that the path is absent (or present) is a
      // divergence that no branch can currently act on differently.
      // A divergence both hooks currently agree about (both present, or both
      // missing) is true and unactionable — the informational band, not a
      // warning that would be there every single day.
      const decisive = v.setupExists !== v.verifyExists;
      const row = mk("hook-cwd", `${entry.id}:${v.name}`, decisive ? "fail" : "warn",
        decisive
          ? `${entry.id} derives ${v.name} as ${v.expr}, which EXISTS for one hook and not the other: setup sees ${v.setupPath} (${v.setupExists ? "present" : "missing"}), verify sees ${v.verifyPath} (${v.verifyExists ? "present" : "missing"}). Setup runs from the seed directory and verify from the composition directory, so any branch on ${v.name} takes opposite paths in the two hooks.`
          : `${entry.id} derives ${v.name} as ${v.expr}, which resolves differently in setup (${v.setupPath}) and verify (${v.verifyPath}). Both are currently ${v.setupExists ? "present" : "missing"}, so nothing diverges today.`,
        {
          fix: decisive
            ? `Guard the branch the way basic-memory guards its skill block — test \`basename "$${v.name}"\` (or the equivalent) before treating the path as authoritative — or derive the path from an env var the runner projects instead of from the script's own location.`
            : "Worth knowing before either root changes; no action needed while both agree.",
          i18n: {
            key: decisive ? "hook-cwd.decisive" : "hook-cwd.agree",
            vars: {
              id: entry.id, name: v.name, expr: v.expr, setupPath: v.setupPath, verifyPath: v.verifyPath,
              setupState: { key: v.setupExists ? "state.present" : "state.missing" },
              verifyState: { key: v.verifyExists ? "state.present" : "state.missing" },
              state: { key: v.setupExists ? "state.present" : "state.missing" }
            }
          }
        });
      findings.push(decisive ? row : demote(row, "both hooks agree on this path today", "demote.hooksAgree"));
    }
  }
  if (!findings.length) {
    findings.push(mk("hook-cwd", "all", "pass",
      `${entries.length} fittings with both hooks derive no path that differs between the seed and composition roots.`,
      { i18n: { key: "hook-cwd.ok", vars: { n: entries.length } } }));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Check 9 — declared config vs the env it will actually be projected as
//
// STATIC by necessity: the env a running fitting actually received is exposed
// by no API and persisted nowhere (only a one-way sha256 lands in the spawn
// record, src/lib/own-port-lifecycle.ts:103-127). So this compares the DECLARED
// config against the two projection rules and flags what will silently fail to
// arrive. It cannot and does not read a live process.
//
// Two different manglings exist, and confusing them is the whole point:
//   setup/verify hooks  runner.ts:1400  NORM(id)_NORM(key), no GARRISON_ prefix
//   runtime spawn       own-port-lifecycle.ts:73  GARRISON_ + id with separators
//                                                 REMOVED + _NORM(key)
// ---------------------------------------------------------------------------

const normKey = (key) => key.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
export const setupEnvName = (id, key) => `${normKey(id)}_${normKey(key)}`;
export const runtimeEnvName = (id, key) => `GARRISON_${id.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}_${normKey(key)}`;

const LOOPBACK = /^(?:127\.0\.0\.1|localhost|::1|\[::1\])$/i;

// entries: [{ id, ownPort, configKeys: [{key,type,default}], envNames: string[] }]
export function checkConfigProjection(entries) {
  const findings = [];
  for (const entry of entries) {
    for (const { key, type, default: value } of entry.configKeys || []) {
      const correct = runtimeEnvName(entry.id, key);
      const suffix = `_${normKey(key)}`;
      const bareId = entry.id.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      // The expensive mistake, and ONLY it: a name whose prefix is this
      // fitting's id spelled with separators kept (GARRISON_FILE_BROWSER_ROOT)
      // where the runner drops them (GARRISON_FILEBROWSER_ROOT). Matching on
      // the key suffix alone is far too broad — it flags GARRISON_BIND_HOST and
      // GARRISON_GATEWAY_PORT, which are instance-wide variables a fitting
      // reads on purpose, and GARRISON_<ID>_TRANSCRIBE_ENABLED, which is simply
      // a different setting that happens to end the same way.
      // A fitting that ALSO reads a correct name has a dead fallback, not a
      // silent failure: dev-env reads GARRISON_DEVENV_PORT first and only then
      // the mangled spelling, so the value does arrive.
      const readsCorrect = (entry.envNames || []).includes(correct) || (entry.envNames || []).includes(setupEnvName(entry.id, key));
      const wrong = (entry.envNames || []).filter((n) => {
        if (n === correct || !n.startsWith("GARRISON_") || !n.endsWith(suffix)) return false;
        const prefix = n.slice("GARRISON_".length, n.length - suffix.length);
        return prefix.replace(/_/g, "") === bareId && prefix !== bareId;
      });
      for (const name of wrong) {
        const row = mk("config-projection", `${entry.id}:${name}`, readsCorrect ? "warn" : "fail",
          `${entry.id} reads ${name}, but the runner projects its "${key}" config as ${correct} — the id is uppercased with separators REMOVED, not underscored, so ${name} is never set.`,
          { fix: readsCorrect
              ? `Harmless today because ${entry.id} also reads a correct name, but the dead fallback invites the next reader to copy it. Delete it.`
              : `Read ${correct} (runtime) or ${setupEnvName(entry.id, key)} (setup/verify hooks); today the declared default silently wins instead.`,
            i18n: { key: readsCorrect ? "config-projection.mangledFallback" : "config-projection.mangled",
              vars: { id: entry.id, name, key, correct, setupName: setupEnvName(entry.id, key) } } });
        findings.push(readsCorrect ? demote(row, "a correct name is read too, so the value still arrives", "demote.stillArrives") : row);
      }
      if (type === "object" || type === "array") {
        findings.push(mk("config-projection", `${entry.id}:${key}`, "warn",
          `${entry.id} declares "${key}" as ${type}, and neither projection carries non-scalar values — it will never reach the process.`,
          { fix: "Flatten it into scalar keys, or read it from a file the setup hook writes.",
            i18n: { key: "config-projection.nonScalar", vars: { id: entry.id, key, type } } }));
      }
      // Deliberately NOT reported: a loopback bind_host default (dropped on
      // purpose so the instance-wide GARRISON_BIND_HOST governs) and a
      // synthesised port. Both are true of nearly every fitting, so a row for
      // each is filler, not signal.
      void LOOPBACK;
      void value;
    }
  }
  if (!findings.length) {
    findings.push(mk("config-projection", "all", "pass",
      `${entries.length} fittings read their config under the names the runner actually projects.`,
      { i18n: { key: "config-projection.ok", vars: { n: entries.length } } }));
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
        { fix: "The fitting exited without cleanup (crash or SIGKILL); the next up() rewrites it. Check its .log for why it died.",
          i18n: { key: "orphans.staleStatus", vars: { fittingId: s.fittingId, pid: s.pid } } }));
    }
  }
  for (const r of spawnRecords) {
    if (r.pid && isAlive(r.pid) && !statusIds.has(r.fittingId)) {
      findings.push(mk("orphans", r.fittingId, "fail",
        `Spawn ledger records ${r.fittingId} pid ${r.pid} STILL RUNNING with no status file — an orphan process (the local-voice server.py class of leak).`,
        { fix: `Inspect \`ps -p ${r.pid}\`; the runner's reconciler reaps it on the next up(), or kill it manually. Preflight never kills.`,
          i18n: { key: "orphans.running", vars: { fittingId: r.fittingId, pid: r.pid } } }));
    }
  }
  if (!findings.length) {
    findings.push(mk("orphans", "all", "pass",
      `${statusFiles.length} status files and ${spawnRecords.length} spawn records, all consistent with live processes.`,
      { i18n: { key: "orphans.ok", vars: { statusFiles: statusFiles.length, spawnRecords: spawnRecords.length } } }));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Check 6 — composition drift + unfitted re-station
// ---------------------------------------------------------------------------

export function assessDrift(input) {
  // input: {compositionId, lastUp: {at, ok}|null, manifestMtimesMs: {}|null,
  //         diskSelections: string[]|null, headSelections: string[]|null,
  //         unfitted: string[], diffStat: string|null, activeCompositionId?}
  const findings = [];
  const cid = input.compositionId;
  const unfit = new Set(input.unfitted || []);
  const isActive = !input.activeCompositionId || input.activeCompositionId === cid;

  if (input.lastUp && input.manifestMtimesMs) {
    const upAt = Date.parse(input.lastUp.at);
    const stale = Object.entries(input.manifestMtimesMs)
      .filter(([, ms]) => ms != null && Number.isFinite(upAt) && ms > upAt)
      .map(([f]) => f);
    if (stale.length) {
      const row = mk("drift", `${cid}:stale`, "warn",
        `${cid} changed since its last verified up (${input.lastUp.at}): ${stale.join(", ")} newer than the last-up record — the fast path will NOT apply and a full install/setup/verify will run.`,
        { fix: "Expected after edits; run the verify sweep before up() to see what the changes broke.",
          i18n: { key: "drift.stale", vars: { cid, at: input.lastUp.at, files: stale.join(", ") } } });
      findings.push(isActive ? row : demote(row, `${cid} is not the active composition, so a slow next up() costs nothing today`, "demote.notActiveSlowUp"));
    }
  }

  // Selections present on disk but not at HEAD are an UNCOMMITTED EDIT, which
  // is the same fact as the diffstat below — they used to be reported once per
  // fitting plus once for the file. Collect them and say it once.
  const added = [];
  if (input.diskSelections && input.headSelections) {
    const disk = new Set(input.diskSelections);
    const head = new Set(input.headSelections);
    for (const id of [...disk].sort()) {
      if (!head.has(id) && !unfit.has(id)) added.push(id);
    }
    // A removal with no `unfitted` record is a CORRECTNESS fact, not a
    // readiness one: the next read silently re-adds the fitting. It keeps full
    // severity in every composition, active or not, and is never demoted.
    for (const id of [...head].sort()) {
      if (!disk.has(id) && !unfit.has(id)) {
        findings.push(mk("drift", `${cid}:restation:${id}`, "warn",
          `${id} was removed from ${cid}'s selections but is NOT in \`unfitted\` — the next read will re-add it and silently undo the removal.`,
          {
            fix: `PUT the composition without ${id} in selections so it lands in \`unfitted\`, or accept that it will come back.`,
            action: { id: "unstation-fitting", params: { compositionId: cid, fittingId: id }, command: `PUT ${cid} without ${id} in selections (records the opt-out), persist it through Garrison's manifest writer` },
            i18n: { key: "drift.restation", vars: { id, cid } }
          }));
      }
    }
  }

  const diffStat = input.diffStat && input.diffStat.trim() ? input.diffStat.trim() : null;
  if (diffStat || added.length) {
    // Permanently informational on purpose: this check openly cannot tell a
    // deliberate edit from an unwanted rewrite, and a row nobody can ever
    // action must not spend the operator's attention as a warning.
    findings.push(demote(mk("drift", `${cid}:uncommitted`, "warn",
      `${cid}/apm.yml differs from git HEAD${added.length ? ` — it adds ${added.join(", ")}` : ""}. The runner re-authors this file, so a diff here may be a deliberate edit or an unwanted rewrite.`,
      { ...(diffStat ? { evidence: diffStat.slice(0, 2000) } : {}), fix: "Review the diff; commit deliberate changes, restore unwanted ones.",
        i18n: { key: added.length ? "drift.uncommittedAdds" : "drift.uncommitted", vars: { cid, added: added.join(", ") } } }),
      "git history alone cannot tell a deliberate edit from a rewrite", "demote.gitCannotTell"));
  }

  // No `:no-record` row: "has never been brought up" is already reported by
  // the verify-results check, and saying the same fact twice in two sections
  // is how a report acquires warnings nobody reads.

  if (!findings.length) {
    findings.push(mk("drift", cid, "pass", input.lastUp
      ? `${cid} matches its last verified up and git HEAD.`
      : `${cid} matches git HEAD (it has no last-up record; the verify-results check reports that).`,
      { i18n: { key: input.lastUp ? "drift.okLastUp" : "drift.okNoRecord", vars: { cid } } }));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Check 7 — retired capability kinds
// ---------------------------------------------------------------------------

export const RETIRED_KINDS = ["agent-skill", "soul"];

// Asking "is this kind still in the vocabulary?" instead of "is it on my list
// of retired ones?" means the next retirement is caught without preflight being
// edited. The retired list survives only to explain WHY a kind is gone.
export function scanKinds(manifests, { vocabulary = null, retired = RETIRED_KINDS } = {}) {
  const findings = [];
  const known = vocabulary instanceof Set && vocabulary.size ? vocabulary : null;
  const wasRetired = new Set(retired);
  for (const m of manifests) {
    const hits = [...new Set((m.kinds || []).filter((k) => (known ? !known.has(k) : wasRetired.has(k))))];
    for (const k of hits) {
      findings.push(mk("kind-vocabulary", m.id, "fail",
        `${m.id} declares capability kind "${k}", which is not in the current vocabulary — registering an unknown kind 500s /api/compositions and takes the whole Muster UI down.`,
        { fix: wasRetired.has(k)
            ? `"${k}" was dropped in the Quarters pivot; replace it with the current kind for this shape.`
            : `Replace "${k}" with a kind listed in capabilityKinds (src/lib/types.ts).`,
          i18n: { key: wasRetired.has(k) ? "kind-vocabulary.retired" : "kind-vocabulary.unknown", vars: { id: m.id, kind: k } } }));
    }
  }
  if (!findings.length) {
    findings.push(mk("kind-vocabulary", "all", "pass", known
      ? `${manifests.length} manifests, every declared kind is in the current vocabulary (${known.size} kinds).`
      : `${manifests.length} manifests, no retired kinds (${retired.join(", ")}) — the current vocabulary could not be read, so this fell back to the retired list.`,
      { i18n: known
          ? { key: "kind-vocabulary.okVocab", vars: { n: manifests.length, kinds: known.size } }
          : { key: "kind-vocabulary.okRetired", vars: { n: manifests.length, retired: retired.join(", ") } } }));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export function summarize(findings) {
  // `info` is counted but never decides `overall`: it is explicitly the band
  // for things that are true and not actionable.
  const counts = { info: 0, pass: 0, warn: 0, fail: 0 };
  for (const f of findings) counts[f.status] = (counts[f.status] || 0) + 1;
  const overall = counts.fail ? "fail" : counts.warn ? "warn" : "pass";
  return { overall, counts };
}

