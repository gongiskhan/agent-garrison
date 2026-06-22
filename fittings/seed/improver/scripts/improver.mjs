#!/usr/bin/env node
// improver.mjs — nightly Improver runner CLI (BRIEF v4 §4 + skills rule v1).
//
//   improver.mjs run-now [improver-nightly]   # run the improver, emit proposals
//   improver.mjs --probe                       # health check, prints "ok"
//
// TWO MODES, selected by whether a skills telemetry source is wired:
//
//  * LEGACY (no IMPROVER_PROJECTS_DIR): the memory-consolidation rule only.
//    Reads MEMORY.md learned hints, writes proposal diffs + a review-queue index,
//    prints a one-line JSON summary. Backward-compatible with MR5a/MR5b.
//
//  * SKILLS (IMPROVER_PROJECTS_DIR set): the skills-only two-phase loop —
//    (1) deterministic maintenance (stale/archive of owned, unpinned skills) and
//    (2) ONE capped, evidence-cited PTY model pass that proposes body-append-only
//    skill edits for human approval. The memory rule still runs and its proposals
//    are merged into the same queue. Emits six numbered FINDING lines + a final
//    `IMPROVER-V1 OK`. Fully hermetic under the env seams below; mutates only the
//    GARRISON_CLAUDE_HOME sandbox + IMPROVER_DATA dir.
//
// Env seams (hermetic acceptance run):
//   IMPROVER_PROJECTS_DIR   fixture transcripts root (activates the skills phase)
//   GARRISON_CLAUDE_HOME    sandbox ~/.claude (its skills/ dir is the work surface)
//   IMPROVER_LOCK           composition apm.lock.yaml (provenance / owned set)
//   IMPROVER_PINNED         CSV of pinned (human-frozen) skills
//   IMPROVER_MODEL_FIXTURE  recorded {reply, sessionId} replayed for the PTY pass
//   IMPROVER_DATA           Improver data dir (queue, snapshots, archives, …)
//   IMPROVER_NOW            ISO timestamp pinned as "now" (deterministic maintenance)
//   IMPROVER_STALE_DAYS / IMPROVER_ARCHIVE_DAYS / IMPROVER_MAX_PROPOSALS /
//   IMPROVER_SKILL_SIZE_LIMIT / IMPROVER_MODEL
//   IMPROVER_VAULT_LOCKED / IMPROVER_SERVER_DOWN  (skip seams, unchanged)

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { runImprover, upsertQueue } from "../lib/improver-core.mjs";
import { runDreamPhase, chooseDreamRunTurn } from "../lib/memory-dream.mjs";
import { scanSkillTelemetry, telemetryToJSON } from "../lib/skill-telemetry.mjs";
import { loadProvenance } from "../lib/provenance.mjs";
import { planMaintenance } from "../lib/maintenance-core.mjs";
import { proposeSkillImprovements } from "../lib/skill-proposal.mjs";
import { snapshotSkill, restoreSkill } from "../lib/snapshot.mjs";
import { runGates, splitFrontmatter } from "../lib/gates.mjs";
import { buildNewContent, applyWithRetry } from "../lib/apply-core.mjs";
import { loadAutonomy, saveAutonomy, setRuleAutonomy, isAuto } from "../lib/review-queue.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GARRISON_HOME = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
const DATA_DIR = process.env.IMPROVER_DATA || path.join(GARRISON_HOME, "improver");
const QUEUE_FILE = path.join(DATA_DIR, "review-queue.json");
const PROPOSALS_DIR = path.join(DATA_DIR, "proposals");
const REPORT_FILE = path.join(DATA_DIR, "last-run.json");
const MAINT_FILE = path.join(DATA_DIR, "maintenance.json");
const TELEMETRY_FILE = path.join(DATA_DIR, "skill-telemetry.json");
const PINNED_FILE = path.join(DATA_DIR, "pinned.json");
const AUTONOMY_FILE = path.join(DATA_DIR, "autonomy.json");
const RECONCILE_MARKER = path.join(DATA_DIR, "reconcile-invoked.json");

function claudeHome() {
  const o = process.env.GARRISON_CLAUDE_HOME?.trim();
  return o && o.length ? o : path.join(os.homedir(), ".claude");
}

// Parse a MEMORY.md index into {title, hook} entries (shared shape with harvest).
function parseMemory(md) {
  const out = [];
  for (const line of String(md).split("\n")) {
    const m = line.match(/^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*(?:—|-)?\s*(.*)$/);
    if (m) out.push({ title: m[1].trim(), hook: (m[3] || "").trim() });
  }
  return out;
}

function readDecisions(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function loadQueue() {
  if (!existsSync(QUEUE_FILE)) return [];
  try {
    return JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
  } catch {
    return [];
  }
}

function listSkillDirs(home) {
  const dir = path.join(home, "skills");
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function readPriorState() {
  try {
    const m = JSON.parse(readFileSync(MAINT_FILE, "utf8"));
    return m && m.state && typeof m.state === "object" ? m.state : {};
  } catch {
    return {};
  }
}

// reconcile("post-authoring"): record the invocation (evidence). Kept as the
// injected recording reconcileFn — the live src/lib reconcile() is TS and is
// wired by the server/UI integration (deliberate scope line, matching MR5a).
function recordingReconcile(trigger) {
  let hist = [];
  try {
    hist = JSON.parse(readFileSync(RECONCILE_MARKER, "utf8"));
  } catch {
    hist = [];
  }
  const rec = { trigger, at: new Date().toISOString() };
  hist.push(rec);
  writeFileSync(RECONCILE_MARKER, JSON.stringify(hist, null, 2), "utf8");
  return rec;
}

// runTurn for the PTY model pass. With IMPROVER_MODEL_FIXTURE set, replay the
// recorded {reply, sessionId} (hermetic). Otherwise undefined → the module's
// default dynamic import of @garrison/claude-pty#oneShotTurn (the real path).
function makeRunTurn() {
  const fixture = process.env.IMPROVER_MODEL_FIXTURE;
  if (!fixture) return undefined;
  return async () => {
    const obj = JSON.parse(readFileSync(fixture, "utf8"));
    return {
      reply: typeof obj.reply === "string" ? obj.reply : JSON.stringify(obj),
      sessionId: obj.sessionId || null,
    };
  };
}

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Resolve the dream rule's config: env vars (config→env injected at setup, or
// the values setup.sh baked into dream-config.json) override the JSON file,
// which overrides built-in defaults. The dream phase runs ONLY when memory_primary
// is set (one machine owns vault-wide consolidation; secondaries stay skills-only).
export function loadDreamConfig() {
  // Resolve the data dir dynamically (not the import-time DATA_DIR const) so the
  // server and tests that set IMPROVER_DATA after import read the right file.
  const dataDir = process.env.IMPROVER_DATA || path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "improver");
  let file = {};
  try {
    file = JSON.parse(readFileSync(path.join(dataDir, "dream-config.json"), "utf8")) || {};
  } catch {
    file = {};
  }
  const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? "").trim());
  const vaultRaw = process.env.IMPROVER_VAULT_DIR || file.vaultDir || "";
  return {
    vaultDir: vaultRaw ? expandHome(vaultRaw) : "",
    memoryDir: process.env.IMPROVER_MEMORY_DIR || file.memoryDir || "Memory",
    memoryPrimary: truthy(process.env.IMPROVER_MEMORY_PRIMARY ?? file.memoryPrimary),
    retentionDays: Number(process.env.IMPROVER_CHECKPOINT_RETENTION_DAYS ?? file.checkpointRetentionDays ?? 14),
    model: process.env.IMPROVER_DREAM_MODEL || file.dreamModel || "haiku",
    cap: Number(process.env.IMPROVER_DREAM_MAX_PROPOSALS ?? file.dreamMaxProposals ?? 8),
  };
}

// Fixture seam for the dream PTY pass (mirrors makeRunTurn). With
// IMPROVER_DREAM_FIXTURE set, replay a recorded {reply, sessionId} hermetically;
// otherwise undefined → memory-dream.mjs uses the real @garrison/claude-pty path.
function makeDreamRunTurn() {
  const fixture = process.env.IMPROVER_DREAM_FIXTURE;
  if (fixture) {
    return async () => {
      const obj = JSON.parse(readFileSync(fixture, "utf8"));
      return { reply: typeof obj.reply === "string" ? obj.reply : JSON.stringify(obj), sessionId: obj.sessionId || null };
    };
  }
  // Opt-in (kanban §10 "one entry for all autonomous flows"): route the dream pass
  // through the gateway's pre-route seam when enabled + a gateway URL is set.
  // Default → chooseDreamRunTurn returns the one-shot path (unchanged behavior).
  return chooseDreamRunTurn({
    routeViaGateway: process.env.GARRISON_IMPROVER_ROUTE_VIA_GATEWAY === "1",
    gatewayUrl: process.env.GARRISON_GATEWAY_URL || null,
  });
}

// basic-memory reindex/doctor runner for the deterministic housekeeping step.
// Best-effort: a missing basic-memory (or IMPROVER_DREAM_NO_INDEX=1) just records
// "skipped"/"error" — it never fails the run. Returns null to skip entirely.
function makeBasicMemoryRunner() {
  if (process.env.IMPROVER_DREAM_NO_INDEX === "1") return null;
  return async ({ cmd, args }) => {
    try {
      execFileSync(cmd, args, { stdio: "ignore", timeout: 60_000 });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  };
}

// Compute dream proposals + run deterministic housekeeping. Shared by the nightly
// CLI (runSkills) and the own-port UI ("Run now" in server.mjs). Returns
// { dreamProposals, housekeeping, config }.
export async function computeDream({ now = null, dryRun = false } = {}) {
  const config = loadDreamConfig();
  if (!config.memoryPrimary) return { dreamProposals: [], housekeeping: { skipped: "not memory_primary" }, config };
  if (!config.vaultDir || !existsSync(config.vaultDir)) {
    return { dreamProposals: [], housekeeping: { skipped: `vault missing: ${config.vaultDir || "(unset)"}` }, config };
  }
  const res = await runDreamPhase({
    vaultDir: config.vaultDir,
    memoryDir: config.memoryDir,
    retentionDays: config.retentionDays,
    model: config.model,
    cap: config.cap,
    runTurn: makeDreamRunTurn(),
    runCommand: makeBasicMemoryRunner(),
    now,
    dryRun,
  });
  return { ...res, config };
}

// ── legacy memory-only run (preserves MR5a/MR5b stdout contract) ──────────────
function runLegacy() {
  const memoryPath =
    process.env.IMPROVER_MEMORY ||
    path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".claude", "projects"), "MEMORY.md");
  const decisionsPath = process.env.IMPROVER_DECISIONS || "";
  const vaultLocked = process.env.IMPROVER_VAULT_LOCKED === "1";
  const serverUp = process.env.IMPROVER_SERVER_DOWN !== "1";

  const memoryEntries = existsSync(memoryPath) ? parseMemory(readFileSync(memoryPath, "utf8")) : [];
  const decisions = readDecisions(decisionsPath);
  const at = new Date().toISOString();

  mkdirSync(DATA_DIR, { recursive: true });
  const result = runImprover({ decisions, memoryEntries, vaultLocked, serverUp, at });

  if (result.skipped) {
    writeFileSync(REPORT_FILE, JSON.stringify({ at, skipped: result.skipped }, null, 2), "utf8");
    appendFileSync(path.join(DATA_DIR, "runs.log"), `${at} skipped: ${result.skipped}\n`, "utf8");
    console.log(JSON.stringify({ skipped: result.skipped }));
    return;
  }

  mkdirSync(PROPOSALS_DIR, { recursive: true });
  let queue = loadQueue();
  for (const p of result.proposals) {
    writeFileSync(path.join(PROPOSALS_DIR, `${p.id}.json`), JSON.stringify(p, null, 2), "utf8");
    queue = upsertQueue(queue, p);
  }
  writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), "utf8");
  writeFileSync(REPORT_FILE, JSON.stringify(result.report, null, 2), "utf8");
  console.log(JSON.stringify({ proposals: result.proposals.length, queue: queue.length }));
}

// ── skills two-phase run (emits the six FINDINGs + IMPROVER-V1 OK) ────────────
async function runSkills() {
  const vaultLocked = process.env.IMPROVER_VAULT_LOCKED === "1";
  const serverUp = process.env.IMPROVER_SERVER_DOWN !== "1";
  if (vaultLocked || !serverUp) {
    const reason = vaultLocked ? "vault locked" : "next server down";
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(REPORT_FILE, JSON.stringify({ at: new Date().toISOString(), skipped: reason }, null, 2), "utf8");
    console.log(JSON.stringify({ skipped: reason }));
    return 0;
  }

  const now = process.env.IMPROVER_NOW || new Date().toISOString();
  const staleDays = Number(process.env.IMPROVER_STALE_DAYS ?? "30");
  const archiveDays = Number(process.env.IMPROVER_ARCHIVE_DAYS ?? "90");
  const cap = Number(process.env.IMPROVER_MAX_PROPOSALS ?? "8");
  const sizeLimit = Number(process.env.IMPROVER_SKILL_SIZE_LIMIT ?? String(64 * 1024));
  const model = process.env.IMPROVER_MODEL || "haiku";
  const home = claudeHome();

  mkdirSync(DATA_DIR, { recursive: true });

  // ── memory rules FIRST (independent of the skills acceptance flow) ──
  // The skills phase below has acceptance-oriented early exits (no loose skill,
  // 0 proposals, gate checks) that would otherwise skip nightly memory work. So
  // the dream (vault consolidation) + memory-consolidation proposals and the
  // deterministic housekeeping are computed and PERSISTED up front; the skills
  // proposals are appended to the same queue afterward.
  const memoryPath =
    process.env.IMPROVER_MEMORY ||
    path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".claude", "projects"), "MEMORY.md");
  const memoryEntries = existsSync(memoryPath) ? parseMemory(readFileSync(memoryPath, "utf8")) : [];
  const dream = await computeDream({ now });
  if (dream.housekeeping?.skipped) {
    console.log(`DREAM — skipped: ${dream.housekeeping.skipped}`);
  } else {
    const hk = dream.housekeeping || {};
    console.log(
      `DREAM — housekeeping auto-applied: archived=${(hk.archived || []).length} reindex=${hk.reindex} doctor=${hk.doctor}; ` +
        `consolidation proposals=${dream.dreamProposals.length} (dropped ${dream.dropped?.length || 0})`
    );
  }
  mkdirSync(PROPOSALS_DIR, { recursive: true });
  let queue = loadQueue();
  const memRun = runImprover({ memoryEntries, at: now, dreamProposals: dream.dreamProposals });
  for (const p of memRun.proposals) {
    writeFileSync(path.join(PROPOSALS_DIR, `${p.id}.json`), JSON.stringify(p, null, 2), "utf8");
    queue = upsertQueue(queue, p);
  }
  writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), "utf8");
  writeFileSync(REPORT_FILE, JSON.stringify({ ...memRun.report, dream: dream.housekeeping }, null, 2), "utf8");

  // 1) telemetry
  const telemetry = scanSkillTelemetry({ projectsDir: process.env.IMPROVER_PROJECTS_DIR, now });
  writeFileSync(TELEMETRY_FILE, JSON.stringify(telemetryToJSON(telemetry), null, 2), "utf8");

  // 2) provenance / classify
  const { classify } = loadProvenance({
    lockPath: process.env.IMPROVER_LOCK,
    pinnedPath: existsSync(PINNED_FILE) ? PINNED_FILE : null,
    pinnedEnv: process.env.IMPROVER_PINNED,
  });

  // candidate set = on-disk skills ∪ telemetry keys
  const skills = [...new Set([...listSkillDirs(home), ...Object.keys(telemetry.bySkill)])].sort();

  // 3) maintenance → FINDING 1, FINDING 2
  const maint = planMaintenance({ skills, telemetry, classify, now, staleDays, archiveDays, priorState: readPriorState() });
  const state = {};
  for (const e of maint.evaluated) state[e.name] = e.state;
  writeFileSync(
    MAINT_FILE,
    JSON.stringify({ at: now, staleDays, archiveDays, evaluated: maint.evaluated, transitions: maint.transitions, skipped: maint.skipped, state }, null, 2),
    "utf8"
  );
  console.log(`FINDING 1 — maintenance ran deterministically: evaluated=${maint.evaluated.length} transitioned=${maint.transitions.length}`);
  const untouched = maint.skipped.find((s) => s.reason === "pinned") || maint.skipped.find((s) => s.reason === "loose") || maint.skipped[0];
  if (!untouched) {
    console.error("improver: no ineligible (loose/pinned) skill present to prove FINDING 2");
    return 1;
  }
  console.log(`FINDING 2 — human-authored/pinned skill (${untouched.reason}) left untouched: ${untouched.name} untouched`);

  // 4) improvement — ONE capped PTY pass → FINDING 3 (proposal block) + FINDING 6 (path)
  const eligibleSkills = skills.filter((n) => classify(n).eligible);
  const prop = await proposeSkillImprovements({ eligibleSkills, telemetry, cap, model, runTurn: makeRunTurn(), now });

  if (!prop.proposals.length) {
    console.error("improver: improvement phase produced 0 proposals (check fixtures / telemetry / provenance)");
    return 1;
  }
  const first = prop.proposals[0];

  // honesty guard: the evidence sessionId is a real one present in telemetry
  const cited = telemetry.bySkill[first.targetFile.replace(/^skills\//, "").replace(/\/SKILL\.md$/, "")];
  const citedOk = cited && cited.sessionIds.has(first.evidence.sessionId);

  // append skill proposals to the same review queue (memory + dream already
  // persisted above, so they survive even if this skills flow exits early).
  for (const p of prop.proposals) {
    writeFileSync(path.join(PROPOSALS_DIR, `${p.id}.json`), JSON.stringify(p, null, 2), "utf8");
    queue = upsertQueue(queue, p);
  }
  writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), "utf8");
  writeFileSync(
    REPORT_FILE,
    JSON.stringify(
      { ...memRun.report, skillProposals: prop.proposals.length, dropped: prop.dropped.length, dream: dream.housekeeping },
      null,
      2
    ),
    "utf8"
  );

  console.log(`FINDING 3 — improvement proposal (claim + evidence + diff + gates; evidence.sessionId in telemetry=${!!citedOk}):`);
  console.log(JSON.stringify(first, null, 2));

  // 5) demo snapshot-before-apply + byte-identical rollback → FINDING 4
  const skillName = first.targetFile.replace(/^skills\//, "").replace(/\/SKILL\.md$/, "");
  const absTarget = path.join(home, "skills", skillName, "SKILL.md");
  const origContent = existsSync(absTarget) ? readFileSync(absTarget, "utf8") : "";
  const origFm = splitFrontmatter(origContent).frontmatter;
  const snap = await snapshotSkill(skillName, first.id, { claudeHome: home, dataDir: DATA_DIR });
  const newContent = buildNewContent(origContent, first);
  const preGate = runGates(newContent, { sizeLimit, originalFrontmatter: origFm });
  if (preGate.ok) {
    await applyWithRetry({ proposal: first, targetFile: absTarget, reconcileFn: recordingReconcile });
  }
  const restore = await restoreSkill(skillName, first.id, { claudeHome: home, dataDir: DATA_DIR });
  console.log(
    `FINDING 4 — snapshot ${snap.path} created before apply; rollback restored original byte-for-byte (sha ${restore.sha}, matches=${restore.matches})`
  );

  // 6) demo gate-fail blocks apply even under simulated autonomy=auto → FINDING 5
  let autonomy = await loadAutonomy(AUTONOMY_FILE);
  autonomy = setRuleAutonomy(autonomy, "skill-suggest", "auto");
  await saveAutonomy(AUTONOMY_FILE, autonomy);
  const auto = isAuto(autonomy, "skill-suggest");
  // a known-bad candidate: a frontmatter REWRITE (drops description) — violates
  // the body-append-only contract; gates run BEFORE apply, regardless of autonomy.
  const badContent = `---\nname: ${skillName}\n---\n\nrewritten body\n`;
  const badGate = runGates(badContent, { sizeLimit, originalFrontmatter: origFm });
  if (badGate.ok) {
    console.error("improver: gate unexpectedly passed a frontmatter rewrite");
    return 1;
  }
  console.log(
    `FINDING 5 — gate enforced under autonomy=auto (skill-suggest auto=${auto}; failures: ${badGate.failures.join(", ")}): GATE FAIL -> not applied`
  );

  // FINDING 6 — PTY-not-SDK invocation path (model pass already rode this path)
  console.log(`FINDING 6 — model pass ran through PTY not the SDK: invocation path ${prop.invocationPath}`);

  console.log("IMPROVER-V1 OK");
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--probe")) {
    runImprover({}); // core runs on empty inputs without throwing
    console.log("ok");
    return 0;
  }
  if (args[0] !== "run-now") {
    console.error("usage: improver.mjs run-now [improver-nightly] | --probe");
    return 2;
  }

  if (process.env.IMPROVER_PROJECTS_DIR) {
    return await runSkills();
  }
  runLegacy();
  return 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      console.error(`improver: ${err?.stack || err?.message || err}`);
      process.exit(1);
    });
}

export { parseMemory };
