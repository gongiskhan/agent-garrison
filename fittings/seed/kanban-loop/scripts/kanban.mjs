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
import { kanbanRoot, atomicWriteJSON, loadBoard, loadAllCards, updateCardCAS } from "../lib/board.mjs";
import { processCard, processBatch, getList, triggerFor, isInteractive, withEvent, phaseForList } from "../lib/engine.mjs";
import { gatewayRunFn } from "../lib/gateway-client.mjs";
import { syncAllBeats } from "../lib/scheduler-beats.mjs";
import { loadPolicy } from "../lib/policy.mjs";
import { loadResolvedModel, buildBoard, reconcileBoardLists, validNextForCard } from "../lib/resolved-model.mjs";
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
// the single garrison-* verb skill, and validNext ids the router reply's last line
// must exact-match. No per-list effort/model (the router decides); the two adversarial
// lists are cross-model Codex passes, NOT a higher tier (the operative stays modest);
// the architecture doc pointer is OFFERED to Implement (a convention, never required -
// a foreign project without one is normal, D12). Goal-mode cards prepend /goal; the guard is the iteration
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
          `Implement the planned slice end-to-end. Read the plan + acceptance from the run directory, and the project's architecture doc (${ARCH_DOC}) WHEN THE PROJECT HAS ONE - it is a convention, not a requirement, and a project without it is normal (GARRISON-FLOW-V2 D12: the flow is project-agnostic). Follow the project's existing conventions; fix forward; write the implement phase's gate-status entry.`,
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

// The canonical per-phase list configs (prompts, trigger, gate flags), indexed
// by phase id from the default pipeline — the SINGLE source buildBoard reuses so
// a derived board's phase lists carry the same behaviour as the built-in
// pipeline. Structural fields (id/order/validNext) are stripped by buildBoard and
// recomputed from the resolved model.
export function phaseTemplatesFrom(board) {
  const out = {};
  for (const l of board.lists || []) {
    if (l.kind === "agent") out[l.id] = l;
  }
  return out;
}

// The board to seed: DRIVEN BY the resolved model when the runner has projected
// one to ~/.garrison/kanban-loop/model.json (D15 — the fixed human columns plus
// one phase list per leaf duty in the composition's resolved sequences), else the
// built-in default pipeline. seedBoard() itself stays pure (a fixed default) so
// it is safe to call as an in-memory default; the model only drives the board
// that is actually PERSISTED to disk here at --setup.
export function resolveSeedBoard(root) {
  const model = loadResolvedModel(root);
  if (!model) return seedBoard();
  return buildBoard(model, { templates: phaseTemplatesFrom(seedBoard()) });
}

// A card must never be LOST when its list is removed by a duty reconcile. Move every
// card sitting on a now-removed list to the needs-attention column, preserving ALL
// other card state (runDir/runId/fences/… are kept) and recording WHY (a park event)
// so the human touchpoint surfaces it — the operator re-enters it on a current list.
// CAS-safe per card; a card whose list still exists is left untouched. Returns the
// moved card ids.
export async function relocateStrandedCards(root, board, removedListIds) {
  if (!Array.isArray(removedListIds) || removedListIds.length === 0) return [];
  const removed = new Set(removedListIds);
  const validIds = new Set((board.lists || []).map((l) => l.id));
  const cards = await loadAllCards(root);
  const moved = [];
  for (const card of cards) {
    // Only relocate a card whose current list truly left the board.
    if (!removed.has(card.list) || validIds.has(card.list)) continue;
    const fromList = card.list;
    const at = new Date().toISOString();
    const reason =
      `The '${fromList}' list was removed from the board when the composition's selected duties changed. ` +
      `Moved here so the card is not lost — re-enter it on a current list (To Do) to continue.`;
    const res = await updateCardCAS(root, card.id, (c) => ({
      ...c,
      list: "needs-attention",
      status: "needs-attention",
      parkedFrom: fromList,
      attentionReason: reason,
      events: withEvent(c, { at, kind: "parked", message: `List '${fromList}' removed by duty reconcile - moved to needs attention`, detail: reason })
    }));
    if (res) moved.push(card.id);
  }
  return moved;
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
    await atomicWriteJSON(boardFile, resolveSeedBoard(root));
    console.log("kanban-loop: seeded board at", boardFile);
  } else {
    // RECONCILE an existing board's phase-list SET to the current resolved model
    // (D15): add lists for newly-selected duties, drop lists for deselected ones,
    // so changing selected_duties updates a LIVE board (not only a fresh seed). Card
    // state is preserved (membership is derived from card files); any card stranded
    // on a removed list is relocated to needs-attention. No model on disk → leave the
    // board untouched (the default-pipeline / policy-less case is unaffected).
    const model = loadResolvedModel(root);
    const existing = model ? await loadBoard(root).catch(() => null) : null;
    if (model && existing) {
      const { board, removed, added } = reconcileBoardLists(existing, model, { templates: phaseTemplatesFrom(seedBoard()) });
      if (removed.length || added.length) {
        await atomicWriteJSON(boardFile, board);
        const moved = await relocateStrandedCards(root, board, removed);
        console.log(
          `kanban-loop: reconciled board (+[${added.join(", ")}] -[${removed.join(", ")}]${moved.length ? `, moved ${moved.length} stranded card(s) to needs-attention` : ""}) at`,
          boardFile
        );
      } else {
        console.log("kanban-loop: board up to date with the resolved model at", boardFile);
      }
    } else {
      console.log("kanban-loop: board exists at", boardFile);
    }
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
  // Delegate the wire to the SAME transport-aware streaming client the per-card
  // path uses (gateway-client.mjs): /chat/stream + the generous kanban per-turn
  // timeout + err.transport classification. The old blocking /chat had NO
  // timeoutMs (the gateway capped a real batched test run at the 5-min PTY
  // default) and died at the HTTP client's ~5-min headersTimeout — either way
  // a legitimate long batch parked its whole project group.
  const streamRunFn = gatewayRunFn(gatewayUrl);
  return async ({ project, cards, list, classification, skill, suppressContinuations, nudge }) => {
    // A verdict NUDGE (engine backstop) replaces the roster prompt: same
    // session, ask for nothing but the per-card verdict lines.
    if (nudge) {
      return streamRunFn({ prompt: nudge, classification, skill, suppressContinuations: suppressContinuations ?? true });
    }
    // D15 (S4a): each card's valid next steps come from ITS resolved (duty, level)
    // sequence (cached on the card), so a sequence-ended card is offered `done`, not
    // the board's next column. A legacy card (no sequence) falls back to the list's
    // static validNext. Tell the operative each card's own options so the verdict it
    // emits matches what parseBatchVerdicts will accept.
    const phase = phaseForList(list) || list.id;
    const roster = cards
      .map((c) => {
        const opts = validNextForCard(c, phase, null) ?? list.validNext ?? [];
        return `- ${c.id} :: title="${c.title}" runDir=${c.runDir || "(none)"} slice=${c.sliceId || "(none)"} next-options=[${opts.join(" | ")}]`;
      })
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
      "Emit ONE verdict line per card, each on its own line, EXACTLY in the form `<cardId> <next-list>` where <next-list> is one of THAT card's own next-options listed above.",
      list.routerPrompt || ""
    ].join("\n");
    return streamRunFn({ prompt, classification, skill, suppressContinuations: suppressContinuations ?? true });
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
