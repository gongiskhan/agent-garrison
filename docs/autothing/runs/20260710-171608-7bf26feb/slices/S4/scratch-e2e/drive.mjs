// GARRISON-FLOW-V2 gap #10 — drive the REAL run engine end-to-end on a FOREIGN
// project (/home/ggomes/dev/flow-scratch), in a sandbox, with an operative stub that
// actually DOES each phase's work in the scratch repo.
//
// Sandbox: GARRISON_KANBAN_DIR / GARRISON_HOME / GARRISON_RUNS_DIR under this dir,
// GARRISON_POLICY_PATH = a copy of the LIVE compiled policy (real garrison-* bindings,
// work kinds, phase plans, coordination section).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import path from "node:path";

const GAP = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const REPO = "/home/ggomes/dev/flow-scratch";
const SLICE = "S1";

process.env.GARRISON_KANBAN_DIR = path.join(GAP, "kanban");
process.env.GARRISON_HOME = path.join(GAP, "home");
process.env.GARRISON_RUNS_DIR = path.join(GAP, "runs");
process.env.GARRISON_POLICY_PATH = path.join(GAP, "policy", "policy.json");
// The engine must NOT reach the live board / live runs / live coord substrate.
const FITTING = "/home/ggomes/dev/garrison/fittings/seed/kanban-loop";

const { seedBoard } = await import(`${FITTING}/scripts/kanban.mjs`);
const { saveBoard, createCard, loadCard, saveCard, loadAllCards } = await import(`${FITTING}/lib/board.mjs`);
const { processCard, advanceCardPhase, getList } = await import(`${FITTING}/lib/engine.mjs`);
const { gateKeyForPhase, loadPolicy, railForCard } = await import(`${FITTING}/lib/policy.mjs`);

const ROOT = process.env.GARRISON_KANBAN_DIR;
const trace = []; // durable transcript of what the harness observed
const prompts = []; // every prompt the engine handed the "operative" (grepped later)
const log = (...a) => { const s = a.join(" "); console.log(s); trace.push(s); };

// ── the operative stub: it does the phase's REAL work, then returns the verdict ──

function sh(cmd, args, cwd = REPO) {
  try {
    const out = execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout || ""}${err.stderr || ""}` };
  }
}

function gateFile(runDir) {
  return path.join(runDir, "slices", SLICE, "gate-status.json");
}

// Write the phase's DURABLE gate entry (D9) — <runDir>/slices/S1/gate-status.json.
function writeGate(runDir, phase, entry) {
  const f = gateFile(runDir);
  mkdirSync(path.dirname(f), { recursive: true });
  let doc = { slice: SLICE, gates: {} };
  if (existsSync(f)) { try { doc = JSON.parse(readFileSync(f, "utf8")); } catch { /* rewrite */ } }
  doc.gates = doc.gates || {};
  doc.gates[gateKeyForPhase(phase)] = { at: new Date().toISOString(), ...entry };
  writeFileSync(f, JSON.stringify(doc, null, 2) + "\n");
  return doc;
}

const MULTIPLY_SRC = `export function multiply(a, b) {
  return a * b;
}
`;
const MULTIPLY_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { multiply } from "../src/multiply.mjs";

test("multiply multiplies two numbers", () => {
  assert.equal(multiply(3, 4), 12);
});

test("multiply handles zero", () => {
  assert.equal(multiply(7, 0), 0);
});
`;

let testRunOutput = ""; // real output of the repo's test command, reused as evidence

async function operative({ prompt, card, list }) {
  prompts.push({ phase: list.id, prompt });
  const runDir = card.runDir;
  const phase = list.phase || list.id;

  if (phase === "plan") {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "FLOW_PLAN.md"), `# FLOW_PLAN — ${card.title}

Project: ${card.project} (${REPO})
Run: ${card.runId}
Slice ${SLICE}: add a \`multiply\` function alongside the existing \`add\`.

## Approach
- \`src/multiply.mjs\` exports \`multiply(a, b)\`, mirroring the shape of \`src/add.mjs\`.
- \`test/multiply.test.mjs\` covers the happy path and the zero case, using \`node:test\`
  like the existing \`test/add.test.mjs\`.

## Acceptance (machine-checkable)
- \`npm test\` (node --test) passes, with the new multiply tests included.
- \`npm run lint\` passes.
- \`multiply(3, 4) === 12\` and \`multiply(7, 0) === 0\`.
`);
    writeFileSync(path.join(runDir, "touch-set.json"), JSON.stringify({
      version: 1,
      cardId: card.id,
      runId: card.runId,
      project: card.project,
      predictedAt: new Date().toISOString(),
      files: ["src/multiply.mjs", "test/multiply.test.mjs"],
      dirs: [],
      surfaces: [],
      exclusive: [],
      notes: "Additive: two new files, no edits to existing sources."
    }, null, 2) + "\n");
    writeGate(runDir, phase, { status: "pass", plan: "FLOW_PLAN.md", touchSet: "touch-set.json" });
    return { reply: "Plan written: one slice (S1), two new files, acceptance is the repo's own test command.\n\nimplement" };
  }

  if (phase === "implement") {
    writeFileSync(path.join(REPO, "src", "multiply.mjs"), MULTIPLY_SRC);
    writeFileSync(path.join(REPO, "test", "multiply.test.mjs"), MULTIPLY_TEST);
    const check = sh("node", ["--check", "src/multiply.mjs"]);
    writeGate(runDir, phase, {
      status: check.code === 0 ? "pass" : "fail",
      files: ["src/multiply.mjs", "test/multiply.test.mjs"],
      selfCheck: `node --check src/multiply.mjs -> exit ${check.code}`
    });
    return { reply: `Wrote src/multiply.mjs + test/multiply.test.mjs; node --check exit ${check.code}.\n\nreview` };
  }

  if (phase === "review") {
    const diff = sh("git", ["diff", "--stat", "HEAD"]).out.trim();
    writeGate(runDir, phase, { status: "approve", verdict: "approve", findings: [], diffStat: diff || "(new untracked files)" });
    return { reply: "Review: mirrors the existing add.mjs convention, ESM, no side effects. Clean.\n\nadversarial-review" };
  }

  if (phase === "adversarial-review") {
    // A fresh pass that tries to break it: does the module actually export what the test imports?
    const probe = sh("node", ["-e", "import('./src/multiply.mjs').then(m=>{if(typeof m.multiply!=='function')process.exit(3)})"]);
    writeGate(runDir, phase, {
      status: probe.code === 0 ? "approve" : "needs-work",
      verdict: probe.code === 0 ? "approve" : "needs-work",
      evidence: `export probe -> exit ${probe.code}`
    });
    return { reply: `Adversarial review: export surface probed independently (exit ${probe.code}); no issues found.\n\ntest` };
  }

  if (phase === "test") {
    const t = sh("npm", ["test"]);
    const lint = sh("npm", ["run", "lint"]);
    testRunOutput = t.out.trim();
    writeGate(runDir, phase, {
      status: t.code === 0 && lint.code === 0 ? "pass" : "fail",
      command: "npm test (node --test)",
      exitCode: t.code,
      lintExitCode: lint.code,
      output: testRunOutput.split("\n").slice(-14).join("\n")
    });
    if (t.code !== 0 || lint.code !== 0) return { reply: `Tests FAILED (exit ${t.code}).\n\nimplement` };
    return { reply: `npm test green (exit 0), npm run lint green.\n\nadversarial-test` };
  }

  if (phase === "adversarial-test") {
    // Independent probe: assert the acceptance directly, not via the committed test file.
    const probe = sh("node", ["-e",
      "import('./src/multiply.mjs').then(m=>{const a=m.multiply(3,4),b=m.multiply(7,0);if(a!==12||b!==0){console.error('got',a,b);process.exit(4)}console.log('acceptance holds: multiply(3,4)=12 multiply(7,0)=0')})"]);
    writeGate(runDir, phase, {
      status: probe.code === 0 ? "pass" : "fail",
      probe: "node -e independent acceptance probe (not the committed test)",
      exitCode: probe.code,
      output: probe.out.trim()
    });
    if (probe.code !== 0) return { reply: `Independent probe FAILED: ${probe.out}\n\nimplement` };
    return { reply: `Independent probe passed: ${probe.out.trim()}\n\nwalkthrough` };
  }

  if (phase === "walkthrough") {
    // Headless library change: the list's own prompt says evidence.md (+ a screenshot only
    // if there is a visual surface) is enough — no video is forced. The evidence is REAL.
    const evDir = path.join(runDir, "evidence");
    mkdirSync(evDir, { recursive: true });
    const show = sh("git", ["show", "--stat", "--format=%h %s%n%b", "HEAD"]).out.trim();
    writeFileSync(path.join(evDir, "evidence.md"), `# Evidence — ${card.title}

Project: ${card.project} (${REPO}) — a plain Node repo, not the Garrison repo.

## What changed
- \`src/multiply.mjs\` (new): exports \`multiply(a, b)\`.
- \`test/multiply.test.mjs\` (new): two node:test cases.

Landed as the implement fence commit:

\`\`\`
${show}
\`\`\`

## How it was verified (real commands, real output)
\`npm test\` in ${REPO}:

\`\`\`
${testRunOutput.split("\n").slice(-12).join("\n")}
\`\`\`

Independent acceptance probe (adversarial-test phase): \`multiply(3,4)=12\`, \`multiply(7,0)=0\`.

No visual surface on this change (headless library), so no screenshot/video was forced.
`);
    writeGate(runDir, phase, { status: "pass", evidence: ["evidence/evidence.md"], video: null, reason: "headless library change — evidence.md log, no video warranted" });
    return { reply: "Evidence bundle written to <runDir>/evidence/evidence.md (no UI surface, so no video).\n\nvalidate" };
  }

  throw new Error(`operative stub: no behavior for phase ${phase}`);
}

// ── drive ────────────────────────────────────────────────────────────────────

const board = { ...seedBoard(), projects: { "flow-scratch": { path: REPO } } };
await saveBoard(board, ROOT);

const policy = loadPolicy();
log(`policy: ${policy ? "loaded" : "MISSING"} — phases=${(policy?.phases || []).length}, coordination.enabled=${policy?.coordination?.enabled}, fences=${policy?.coordination?.fences?.enabled}`);

let card = await createCard(ROOT, {
  title: "Add a multiply function with a test",
  description: "Add a multiply(a, b) function to src/ mirroring src/add.mjs, with a node:test covering it. Keep the repo's existing ESM + node --test conventions.",
  project: "flow-scratch",
  list: "todo",
  workKind: "full-feature",
  tier: "T1-standard",
  goalMode: true,
  acceptance: "npm test passes with multiply covered; multiply(3,4)===12 and multiply(7,0)===0.",
  origin: "gap10-e2e"
});
log(`card ${card.id} created on "todo" (workKind=${card.workKind}, tier=${card.tier})`);
const rail = railForCard(policy, card);
log(`rail (${rail.workKind}): ${rail.phases.map((p) => `${p.id}:${p.on ? "on" : "off"}`).join(" ")}`);

// The human Start: a manual move todo -> plan (what the board's Start button does).
card = await saveCard(ROOT, { ...card, list: "plan" });
log(`started: moved to "plan"`);

const path_taken = ["todo", "plan"];
for (let i = 0; i < 20; i++) {
  const listId = card.list;
  const list = getList(board, listId);
  if (!list || list.kind !== "agent") break; // manual/terminal column — stop
  const before = Date.now();
  const { card: c, outcome } = await processCard({ root: ROOT, board, card, runFn: operative, cap: 10, cwd: REPO });
  card = c;
  log(`processCard(${listId}) -> ${outcome.status}${outcome.to ? ` -> ${outcome.to}` : ""}${outcome.reason ? ` (${outcome.reason})` : ""}  [${Date.now() - before}ms]`);
  if (outcome.status !== "moved") { log(`STOPPED: ${JSON.stringify(outcome)}`); break; }
  path_taken.push(outcome.to);
  if (outcome.to === "validate") break; // the last phase goes through the in-process doorway
}

// ── the in-process doorway (D13): the session does the validate work ITSELF, writes
// the gate record, then calls advanceCardPhase — same D9/fence contract as dispatch.
if (card.list === "validate") {
  const runDir = card.runDir;
  const gates = JSON.parse(readFileSync(gateFile(runDir), "utf8")).gates;
  const evidenceOk = existsSync(path.join(runDir, "evidence", "evidence.md"));
  const failing = Object.entries(gates).filter(([, g]) => !["pass", "approve"].includes(g.status));
  writeFileSync(path.join(runDir, "evidence-index.json"), JSON.stringify({
    version: 1,
    runId: card.runId,
    cardId: card.id,
    project: card.project,
    repo: REPO,
    slice: SLICE,
    artifacts: {
      plan: "FLOW_PLAN.md",
      touchSet: "touch-set.json",
      gateStatus: `slices/${SLICE}/gate-status.json`,
      evidence: ["evidence/evidence.md"]
    },
    gates: Object.fromEntries(Object.entries(gates).map(([k, g]) => [k, g.status])),
    fences: (card.fences || []).map((f) => ({ phase: f.phase, sha: f.sha, empty: f.empty }))
  }, null, 2) + "\n");
  writeGate(runDir, "validate", {
    status: failing.length === 0 && evidenceOk ? "pass" : "fail",
    dodGates: Object.fromEntries(Object.entries(gates).map(([k, g]) => [k, g.status])),
    evidenceBundle: evidenceOk ? "evidence/evidence.md" : null,
    railOff: rail.phases.filter((p) => !p.on).map((p) => p.id)
  });
  const verdict = failing.length === 0 && evidenceOk ? "done" : "implement";
  const { card: c2, outcome } = await advanceCardPhase({ root: ROOT, board, card, verdict, cwd: REPO });
  card = c2;
  log(`advanceCardPhase(validate, verdict=${verdict}) -> ${outcome.status}${outcome.to ? ` -> ${outcome.to}` : ""}${outcome.reason ? ` (${outcome.reason})` : ""}`);
  if (outcome.to) path_taken.push(outcome.to);
}

const finalList = getList(board, card.list);
log(`\nFINAL: list=${card.list} terminal=${Boolean(finalList?.terminal)} status=${card.status} iterations=${card.iterations} parked=${Boolean(card.parkedReason || card.parked)}`);
log(`phase path: ${path_taken.join(" -> ")}`);
log(`runDir: ${card.runDir}`);
log(`fences: ${(card.fences || []).map((f) => `${f.phase}=${f.sha ? f.sha.slice(0, 10) : "?"}${f.empty ? "(anchor)" : "(COMMIT)"}`).join("  ")}`);
if (card.parkedReason) log(`PARK REASON: ${card.parkedReason}`);

writeFileSync(path.join(GAP, "card.json"), JSON.stringify(card, null, 2) + "\n");
writeFileSync(path.join(GAP, "prompts.json"), JSON.stringify(prompts, null, 2) + "\n");
writeFileSync(path.join(GAP, "drive-trace.txt"), trace.join("\n") + "\n");
writeFileSync(path.join(GAP, "events.txt"), (card.events || []).map((e) => `[${e.at}] ${e.kind}: ${e.message}${e.detail ? `\n    detail: ${String(e.detail).split("\n")[0]}` : ""}`).join("\n") + "\n");
