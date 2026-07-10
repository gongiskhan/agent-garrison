#!/usr/bin/env node
// Kanban Loop V1b CLI:
//   --setup            seed the board + register the Test scheduler beat
//   --probe            verify the engine + board are loadable
//   --tick             process due IMMEDIATE agent-list cards (skips scheduler-beat,
//                      manual, and interactive lists)
//   --tick-list <id>   process ONE list. For the Test list this is the BATCHED path
//                      (one session per project); the Test scheduler beat calls it.
// The board UI is owned by other V1b slices; this is the engine spine.
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { kanbanRoot, atomicWriteJSON, loadBoard, loadAllCards } from "../lib/board.mjs";
import { processCard, processBatch, getList, triggerFor, isInteractive } from "../lib/engine.mjs";
import { gatewayRunFn } from "../lib/gateway-client.mjs";
import { syncAllBeats } from "../lib/scheduler-beats.mjs";
import { loadPolicy } from "../lib/policy.mjs";
import {
  reevaluateWaiting,
  coordinationConfig,
  coordinationAvailability,
  serializeGate
} from "../lib/coordination.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The full V1b pipeline (brief §"The pipeline and the lists" + v4 wireframe §5 — the
// authoritative per-list table). Every agent list carries an explicit {taskType,tier}
// classification (§10), a trigger (immediate | manual | scheduler-beat), a mode hint,
// the single autothing-* verb skill, and validNext ids the router reply's last line
// must exact-match. No per-list effort/model (the router decides); the two adversarial
// lists are cross-model Codex passes, NOT a higher tier (the operative stays modest);
// the architecture doc is handed to Implement so the generic writer reads doctrine
// from docs (Decision 3). Goal-mode cards prepend /goal; the guard is the iteration
// cap, not a goal hook (Decision 7).
const ARCH_DOC = "docs/architecture.md";

export { migrateBoard } from "../lib/board.mjs";

export function seedBoard() {
  return {
    version: 3,
    lists: [
      {
        id: "backlog", title: "Backlog", order: 0, kind: "manual", trigger: "manual",
        // On entry: infer the title eagerly; apply the project only at >=70% confidence,
        // else park in needs-attention (engine.resolveBacklogInference — FINDING 3).
        onEnter: "infer-title-and-project",
        validNext: ["todo"]
      },
      { id: "todo", title: "To Do", order: 1, kind: "manual", trigger: "manual", validNext: ["discuss", "plan"] },
      {
        id: "discuss", title: "Discuss", order: 2, kind: "agent-interactive", trigger: "manual",
        // Interactive: NOT auto-dispatched. The board opens the web chat; the operative
        // produces a brief to disk; the human advances manually. (Per-list mode is DEAD
        // — D15; the gateway resolves the face.)
        interactive: true, surface: "web-channel",
        onEnter: "open-web-chat",
        validNext: ["plan"]
      },
      // ── Autonomous lists (Plan onward). A list maps to a PHASE NAME and nothing
      // else (D15): skill / model / effort / runtime resolve from the compiled
      // Orchestrator policy at dispatch time (lib/policy.mjs); the engine injects
      // the policy-bound skill into the prompt. These lists are ENGINE-OWNED
      // (D16): the board API + UI reject manual moves/edits on them.
      {
        id: "plan", title: "Plan", order: 3, kind: "agent", trigger: "immediate", phase: "plan",
        executePrompt:
          "Plan this card: explore, then write the implementation plan and machine-checkable acceptance under the run directory, and write the plan phase's gate-status entry.",
        routerPrompt: "When the plan + acceptance are written (or already exist in the run directory) AND the plan phase's gate-status entry exists, end with `implement` on its own final line.",
        validNext: ["implement"]
      },
      {
        id: "implement", title: "Implement", order: 4, kind: "agent", trigger: "immediate", phase: "implement",
        executePrompt:
          `Implement the planned slice end-to-end. Read the plan + acceptance from the run directory and the architecture doc at ${ARCH_DOC}; follow existing conventions; fix forward; write the implement phase's gate-status entry.`,
        routerPrompt: "When the code is written and self-checks pass — or the change is already present and complete — end with `review` on its own final line.",
        validNext: ["review"]
      },
      {
        id: "review", title: "Review", order: 5, kind: "agent", trigger: "immediate", phase: "review",
        executePrompt: "Review the slice diff for correctness then quality; write the review phase's gate-status entry with the verdict.",
        routerPrompt: "If the review is clean OR the slice is already complete (no real issues), end with `adversarial-review`. Only if real issues remain, end with `implement`. End with the bare token on its own final line.",
        validNext: ["adversarial-review", "implement"]
      },
      {
        id: "adversarial-review", title: "Adversarial Review", order: 6, kind: "agent", trigger: "immediate", phase: "adversarial-review",
        executePrompt: "Run the adversarial review phase: a fresh-context pass that tries to break the diff; iterate to approve; write the phase's gate-status entry.",
        routerPrompt: "If the adversarial review approves — or there is nothing left to review (already complete/clean) — end with `test`. Only if it found real issues, end with `implement`. End with the bare token on its own final line.",
        validNext: ["test", "implement"]
      },
      {
        id: "test", title: "Test", order: 7, kind: "agent", trigger: "scheduler-beat", phase: "test",
        // Runs on its OWN scheduler beat (default every 5h, editable as a cron), not
        // the global heartbeat, and is BATCHED per project: one session per project
        // against one test plan, one verdict per card (list MECHANICS, preserved — D9).
        beatCron: "0 */5 * * *",
        batched: true,
        executePrompt: "Run the test phase: write + run the committed correctness gate (and typecheck/lint/build) for each card's slice; write each card's test phase gate-status entry.",
        routerPrompt: "For each card, emit `<cardId> adversarial-test` if green (or already passing), or `<cardId> implement` only if it is genuinely failing.",
        validNext: ["adversarial-test", "implement"]
      },
      {
        id: "adversarial-test", title: "Adversarial Test", order: 8, kind: "agent", trigger: "immediate", phase: "adversarial-test",
        executePrompt: "Run the adversarial-test phase: an independent pass drives the running app through the acceptance with its own probes; write the phase's gate-status entry.",
        routerPrompt: "If the independent pass passed — or there is nothing left to test (already complete) — end with `walkthrough`. Only if it genuinely failed, end with `implement`. End with the bare token on its own final line.",
        validNext: ["walkthrough", "implement"]
      },
      {
        id: "walkthrough", title: "Walkthrough", order: 9, kind: "agent", trigger: "immediate", phase: "walkthrough",
        // The engine ENFORCES this: the card cannot advance off Walkthrough unless
        // <runDir>/evidence/ actually contains a file (screenshot or evidence.md).
        requiresEvidence: true,
        executePrompt:
          "Leave TANGIBLE EVIDENCE for this change under the run directory's evidence/ folder (create `<runDir>/evidence/`), and write the walkthrough phase's gate-status entry. This is the proof the user opens on the finished card, so it must always exist:\n" +
          "1. ALWAYS write `<runDir>/evidence/evidence.md` — a short log: WHAT changed (the diff or a concise summary with file:line), and HOW you verified it (the commands you ran + their key output).\n" +
          "2. If the change has ANY visual / UI surface, ALSO capture at least one screenshot of the affected page or state into `<runDir>/evidence/` as a .png. Name it descriptively (e.g. after.png).\n" +
          "3. If the change genuinely warrants a full recorded walkthrough video (real multi-step UI behavior), record it and also set the card's videoUrl.\n" +
          "For a trivial change (a static text/copy/config tweak), steps 1 (and 2 if there's a page) are enough — do NOT force a video. Keep your reply short.",
        routerPrompt: "If you produced the evidence bundle (a screenshot and/or evidence.md under <runDir>/evidence/, plus a video if warranted), end with `validate`. Only if you could not produce ANY evidence at all, end with `implement`. End with the bare token on its own final line.",
        validNext: ["validate", "implement"]
      },
      {
        id: "validate", title: "Validate", order: 10, kind: "agent", trigger: "immediate", phase: "validate",
        executePrompt:
          "Run the validate phase against this card's run directory + slice: check every APPLICABLE DoD gate (tests/typecheck/lint/build/e2e, review, adversarial passes; a phase the card's rail turned OFF is recorded off, never a silent pass) and write the durable gate record. " +
          "CONFIRM the evidence bundle exists under `<runDir>/evidence/` — that tangible proof is part of the DoD. " +
          "A gate that was legitimately size-skipped for a trivial change COUNTS AS SATISFIED, but DO expect at least the evidence.md log. Keep your reply short.",
        routerPrompt: "If the Definition of Done holds — all applicable gates pass, are rail-off, or are size-skip-satisfied AND the evidence bundle exists — end with `done`. Only if a gate genuinely FAILED or NO evidence was produced, end with `implement`. End with the bare token on its own final line.",
        validNext: ["done", "implement"]
      },
      { id: "done", title: "Done", order: 11, kind: "manual", trigger: "manual", terminal: true, validNext: [] },
      {
        id: "needs-attention", title: "Needs attention", order: 12, kind: "manual", trigger: "manual",
        // Always notifies on entry (the surface honours notifyOnEntry). The ONE human
        // touchpoint on the autonomous side (D16): edit, resolve, re-enter the pipeline.
        notifyOnEntry: true,
        validNext: ["todo", "plan", "implement"]
      }
    ],
    projects: {}
  };
}

// Resolve the installed scheduler CLI. At setup time cwd is the kanban-loop fitting
// dir, so the sibling scheduler fitting is one level up (matches the improver pattern).
function schedulerCli() {
  return process.env.GARRISON_SCHEDULER_CLI
    || path.resolve(__dirname, "..", "..", "scheduler", "scripts", "scheduler.mjs");
}

// Register a scheduler beat for EVERY scheduler-beat list, each on its own `beatCron`
// (the Test list seeds one; the user can add/edit a beat per list in the list config).
// Delegates to the shared lib so --setup and PATCH /lists register beats identically.
async function registerSchedulerBeats() {
  const board = await loadBoard().catch(() => seedBoard());
  await syncAllBeats(board);
}

// Register the IMMEDIATE-list tick (FINDING 1: "a scheduler job ticks it"). Immediate
// agent lists fire on entry, but the engine is polled (no event bus), so a frequent
// scheduler job runs `--tick`. Cadence configurable via KANBAN_TICK_CRON (default every
// 2 minutes). The Test list has its OWN, separate beat (registerTestBeat).
async function registerTick() {
  const cron = process.env.KANBAN_TICK_CRON || "*/2 * * * *"; // every 2 minutes
  const cli = schedulerCli();
  const self = path.resolve(__dirname, "kanban.mjs");
  const cmd = `node ${self} --tick`;
  if (!existsSync(cli)) {
    console.log(`kanban-loop: scheduler CLI not found at ${cli} (skipping tick job; register manually).`);
    return;
  }
  const { spawnSync } = await import("node:child_process");
  spawnSync("node", [cli, "remove", "kanban-tick"], { stdio: "ignore" });
  const add = spawnSync("node", [cli, "add", "kanban-tick", cron, cmd], { encoding: "utf8" });
  if (add.status === 0) {
    console.log(`kanban-loop: registered kanban-tick @ '${cron}' -> ${cmd}`);
  } else {
    console.log(`kanban-loop: scheduler add (tick) failed (non-fatal in dev): ${add.stderr || add.stdout || add.status}`);
  }
}

async function setup() {
  const root = kanbanRoot();
  await fs.mkdir(path.join(root, "cards"), { recursive: true });
  const boardFile = path.join(root, "board.json");
  if (!existsSync(boardFile)) {
    await atomicWriteJSON(boardFile, seedBoard());
    console.log("kanban-loop: seeded board at", boardFile);
  } else {
    console.log("kanban-loop: board exists at", boardFile);
  }
  await registerTick();
  await registerSchedulerBeats();
}

async function probe() {
  try {
    await loadBoard();
  } catch {
    // an absent board is fine for the probe — setup seeds it
  }
  if (typeof processCard !== "function" || typeof processBatch !== "function") {
    console.error("KANBAN-FAIL: engine not loadable");
    process.exit(1);
  }
  console.log("KANBAN-OK");
}

// Dispatch goes through the shared, transport-aware gateway client (lib/gateway-client.mjs,
// imported at the top of this file): one wire shape + one failure classification across the
// tick and the board, so a transient gateway failure reverts a card rather than parking it.

// Batched dispatch for the Test list: ONE session per project covering all of the
// project's waiting cards. The prompt is the list's execute/router prompt plus the
// card roster (id + runDir + slice), and the session is asked to emit one verdict line
// per card (`<cardId> <next-list>`); processBatch parses each verdict per card.
// Exported so the board server's manual "Run" can drive a batched list (Test) through
// the SAME batch wire shape the scheduler beat uses (one session per project).
export function batchGatewayRunFn(gatewayUrl) {
  return async ({ project, cards, list, classification, skill, suppressContinuations }) => {
    const roster = cards
      .map((c) => `- ${c.id} :: title="${c.title}" runDir=${c.runDir || "(none)"} slice=${c.sliceId || "(none)"}`)
      .join("\n");
    // Lead with the list's mode so the gateway switches the operative's face (same as
    // the per-card buildCardPrompt). Inert if the gateway ignores it.
    const mode = (list?.mode || "").trim();
    const prompt = [
      ...(mode ? [`${mode}, take on the following batched test run.`, ""] : []),
      `Batched test run for project "${project}". Test ALL of these cards' slices in ONE session against one test plan:`,
      roster,
      "",
      list.executePrompt || "",
      "",
      `Emit ONE verdict line per card, each on its own line, EXACTLY in the form \`<cardId> <next-list>\` where <next-list> is one of: ${list.validNext.join(", ")}.`,
      list.routerPrompt || ""
    ].join("\n");
    const res = await fetch(`${gatewayUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-garrison-origin": "channel" },
      body: JSON.stringify({
        channel: "kanban",
        message: prompt,
        classification: classification ?? null,
        skill: skill ?? null,
        suppressContinuations: suppressContinuations ?? true
      })
    });
    if (!res.ok) throw new Error(`kanban batch dispatch failed: HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    return { reply: data.reply ?? data.text ?? "" };
  };
}

// The gateway URL the tick dispatches through: explicit env, else the conventional
// :4777 (matching the board server + web channel). The runner injects the live URL.
function resolveGatewayUrl() {
  return process.env.GARRISON_GATEWAY_URL || `http://127.0.0.1:${process.env.GARRISON_GATEWAY_PORT || "4777"}`;
}

// The scheduler tick runs out-of-band (launchd) with no operative, so PING the gateway
// first and skip the whole tick when it is down — immediate cards WAIT for an operative
// instead of every card failing its run and parking in needs-attention.
async function gatewayReachable(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(url, { method: "GET", signal: ctrl.signal }).catch(() => null);
    clearTimeout(t);
    return Boolean(r); // any HTTP response (even 404) means the gateway is up
  } catch {
    return false;
  }
}

// Process due IMMEDIATE agent-list cards. Skips scheduler-beat (Test runs on its own
// beat), manual, and interactive lists.
async function tick() {
  const gatewayUrl = resolveGatewayUrl();
  if (!(await gatewayReachable(gatewayUrl))) {
    console.log(`kanban-loop: gateway not reachable at ${gatewayUrl} — nothing to dispatch (immediate cards wait for an operative).`);
    return;
  }
  const root = kanbanRoot();
  const board = await loadBoard(root);
  const cap = Number(process.env.GARRISON_KANBAN_ITERATION_CAP || 10);
  // Coordination (GARRISON-FLOW-V2 S1): release any waiting cards whose blocker
  // reached its release point BEFORE dispatching, then reload so released cards
  // are seen on their new list this same tick.
  const cards0 = await loadAllCards(root);
  await reevaluateWaiting({ root, board, cards: cards0 }).catch(() => {});
  const cards = await loadAllCards(root);
  const coordCfg = coordinationConfig(loadPolicy());
  const degraded = coordCfg.enabled && !coordinationAvailability().ok && coordCfg.serializeWhenUnavailable;
  const runFn = gatewayRunFn(gatewayUrl);
  let processed = 0;
  for (const card of cards) {
    const list = getList(board, card.list);
    if (!list || list.kind !== "agent") continue;        // manual / agent-interactive skip
    if (triggerFor(list) !== "immediate") continue;       // scheduler-beat / manual skip
    if (isInteractive(list)) continue;                    // belt-and-suspenders
    if (card.status === "running" || card.status === "needs-attention") continue;
    if (card.waitingOn) continue;                         // deferred behind an overlapping run
    // Serialize gate (D9): coordination enabled but its substrate is unusable —
    // run only the oldest live card per project until it recovers.
    if (degraded) {
      const gate = serializeGate(cards, card, board);
      if (!gate.allowed) { console.log(`kanban-loop: card ${card.id} → ${gate.reason}`); continue; }
    }
    const { outcome } = await processCard({ root, board, card, runFn, cap });
    console.log(`kanban-loop: card ${card.id} → ${outcome.status}${outcome.to ? " " + outcome.to : ""}`);
    processed++;
  }
  console.log(`kanban-loop: tick processed ${processed} card(s)`);
}

// Process ONE list. For a batched list (Test) this is the per-project batched path
// invoked by the Test scheduler beat; for any other agent list it falls back to the
// per-card path (manual single-list kick).
async function tickList(listId) {
  const gatewayUrl = resolveGatewayUrl();
  if (!(await gatewayReachable(gatewayUrl))) {
    console.log(`kanban-loop: gateway not reachable at ${gatewayUrl} — nothing to dispatch (cards wait for an operative).`);
    return;
  }
  const root = kanbanRoot();
  const board = await loadBoard(root);
  const list = getList(board, listId);
  if (!list || list.kind !== "agent") {
    console.log(`kanban-loop: list '${listId}' is not an agent list — nothing to dispatch.`);
    return;
  }
  const cap = Number(process.env.GARRISON_KANBAN_ITERATION_CAP || 10);
  // Release waiting cards first (same as tick), then read fresh.
  const cards0 = await loadAllCards(root);
  await reevaluateWaiting({ root, board, cards: cards0 }).catch(() => {});
  const cards = await loadAllCards(root);
  const coordCfg = coordinationConfig(loadPolicy());
  const degraded = coordCfg.enabled && !coordinationAvailability().ok && coordCfg.serializeWhenUnavailable;

  if (list.batched) {
    const batchRunFn = batchGatewayRunFn(gatewayUrl);
    const listCards = cards.filter((c) => c.list === listId);
    const { outcomes } = await processBatch({ root, board, listId, cards: listCards, batchRunFn, cap, cwd: process.cwd() });
    const projects = new Set(outcomes.map((o) => o.project));
    for (const o of outcomes) {
      console.log(`kanban-loop: [${o.project}] card ${o.id} → ${o.status}${o.to ? " " + o.to : ""}`);
    }
    console.log(`kanban-loop: --tick-list ${listId} batched ${outcomes.length} card(s) across ${projects.size} project(s)`);
    return;
  }

  const runFn = gatewayRunFn(gatewayUrl);
  let processed = 0;
  for (const card of cards) {
    if (card.list !== listId) continue;
    if (card.status === "running" || card.status === "needs-attention") continue;
    if (card.waitingOn) continue;                         // deferred behind an overlapping run
    if (degraded) {
      const gate = serializeGate(cards, card, board);
      if (!gate.allowed) { console.log(`kanban-loop: card ${card.id} → ${gate.reason}`); continue; }
    }
    const { outcome } = await processCard({ root, board, card, runFn, cap });
    console.log(`kanban-loop: card ${card.id} → ${outcome.status}${outcome.to ? " " + outcome.to : ""}`);
    processed++;
  }
  console.log(`kanban-loop: --tick-list ${listId} processed ${processed} card(s)`);
}

// Only dispatch the CLI when run directly (so `import { seedBoard }` from a test is
// side-effect-free).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const arg = process.argv[2];
  if (arg === "--setup") await setup();
  else if (arg === "--probe") await probe();
  else if (arg === "--tick") await tick();
  else if (arg === "--tick-list") await tickList(process.argv[3]);
  else console.log("usage: kanban.mjs --setup | --probe | --tick | --tick-list <id>");
}
