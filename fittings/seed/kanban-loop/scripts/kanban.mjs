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

export function seedBoard() {
  return {
    version: 2,
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
        // in James mode produces a brief to disk; the human advances manually (§8).
        skill: null, interactive: true, mode: "james", surface: "web-channel",
        onEnter: "open-web-chat",
        validNext: ["plan"]
      },
      {
        id: "plan", title: "Plan", order: 3, kind: "agent", trigger: "immediate",
        skill: "autothing-plan", taskType: "code", tier: "T2-deep", mode: "james",
        executePrompt:
          "Plan this card with autothing-plan: explore, then write the implementation plan and machine-checkable acceptance under the run directory.",
        routerPrompt: "When the plan + acceptance are written (or already exist in the run directory), end with `implement` on its own final line.",
        validNext: ["implement"]
      },
      {
        id: "implement", title: "Implement", order: 4, kind: "agent", trigger: "immediate",
        skill: "autothing-implement", taskType: "code", tier: "T2-deep", mode: "joe",
        // Implement is handed the plan slice + acceptance + the architecture doc so the
        // generic writer reads project doctrine from docs (Decision 3). goalMode-aware
        // (engine prepends /goal <acceptance>); the guard is the per-card iteration cap.
        executePrompt:
          `Implement the planned slice end-to-end with autothing-implement. Read the plan + acceptance from the run directory and the architecture doc at ${ARCH_DOC}; follow existing conventions; fix forward.`,
        routerPrompt: "When the code is written and self-checks pass — or the change is already present and complete — end with `review` on its own final line.",
        validNext: ["review"]
      },
      {
        id: "review", title: "Review", order: 5, kind: "agent", trigger: "immediate",
        skill: "autothing-review", taskType: "review", tier: "T1-standard", mode: "joe",
        executePrompt: "Review the slice diff for correctness then quality with autothing-review.",
        routerPrompt: "If the review is clean OR the slice is already complete (no real issues), end with `adversarial-review`. Only if real issues remain, end with `implement`. End with the bare token on its own final line.",
        validNext: ["adversarial-review", "implement"]
      },
      {
        id: "adversarial-review", title: "Adversarial Review", order: 6, kind: "agent", trigger: "immediate",
        // Cross-model Codex via the codex CLI — the operative is modest, the strength is
        // Codex, so this is T1-standard, NOT a higher tier.
        skill: "autothing-adversarial-review", taskType: "review", tier: "T1-standard", mode: "joe",
        executePrompt: "Run autothing-adversarial-review: have Codex (codex CLI) try to break the diff and iterate to approve.",
        routerPrompt: "If both models approve — or there is nothing left to review (already complete/clean) — end with `test`. Only if Codex found real issues, end with `implement`. End with the bare token on its own final line.",
        validNext: ["test", "implement"]
      },
      {
        id: "test", title: "Test", order: 7, kind: "agent", trigger: "scheduler-beat",
        // Runs on its OWN scheduler beat (default every 5h, configurable), not the
        // global heartbeat, and is BATCHED per project: one session per project against
        // one test plan, one verdict per card (FINDING 7 / processBatch).
        skill: "autothing-test", taskType: "code", tier: "T1-standard", mode: "joe", batched: true,
        executePrompt: "Run autothing-test: write + run the committed correctness gate (and typecheck/lint/build) for each card's slice.",
        routerPrompt: "For each card, emit `<cardId> adversarial-test` if green (or already passing), or `<cardId> implement` only if it is genuinely failing.",
        validNext: ["adversarial-test", "implement"]
      },
      {
        id: "adversarial-test", title: "Adversarial Test", order: 8, kind: "agent", trigger: "immediate",
        // Cross-model Codex functional pass; needs a running dev server. Operative modest.
        skill: "autothing-adversarial-test", taskType: "code", tier: "T1-standard", mode: "joe",
        executePrompt: "Run autothing-adversarial-test: have Codex (codex CLI) drive the running app through the acceptance with its own pass.",
        routerPrompt: "If Codex's pass passed — or there is nothing left to test (already complete) — end with `walkthrough`. Only if it genuinely failed, end with `implement`. End with the bare token on its own final line.",
        validNext: ["walkthrough", "implement"]
      },
      {
        id: "walkthrough", title: "Walkthrough", order: 9, kind: "agent", trigger: "immediate",
        skill: "autothing-walkthrough", taskType: "code", tier: "T1-standard", mode: "joe",
        // The engine ENFORCES this: the card cannot advance off Walkthrough unless
        // <runDir>/evidence/ actually contains a file (screenshot or evidence.md). The
        // "ALWAYS write evidence" prompt is thus a real gate, not just self-attestation.
        requiresEvidence: true,
        // Records the verified video and links videoUrl onto the card — BUT size-aware,
        // exactly like Test / Adversarial Review / Adversarial Test (which skip their heavy
        // external calls for a trivial change). A 1-line static-text/copy/config tweak has
        // no user-visible behavior to record, so DON'T attempt a video for it — note the
        // size-skip and route to validate (the earlier "tried to record nothing → empty
        // reply → park" was the missing skip path, not a real failure).
        executePrompt:
          "Leave TANGIBLE EVIDENCE for this change under the run directory's evidence/ folder (create `<runDir>/evidence/`). This is the proof the user opens on the finished card, so it must always exist:\n" +
          "1. ALWAYS write `<runDir>/evidence/evidence.md` — a short log: WHAT changed (the diff or a concise summary with file:line), and HOW you verified it (the commands you ran + their key output).\n" +
          "2. If the change has ANY visual / UI surface, ALSO capture at least one screenshot of the affected page or state into `<runDir>/evidence/` as a .png (render the page headlessly — e.g. Playwright/chromium against the local file or dev server — and screenshot it). Name it descriptively (e.g. after.png).\n" +
          "3. If the change genuinely warrants a full recorded walkthrough video (real multi-step UI behavior), run autothing-walkthrough and also set the card's videoUrl.\n" +
          "For a trivial change (a static text/copy/config tweak), steps 1 (and 2 if there's a page) are enough — do NOT force a video. Keep your reply short.",
        routerPrompt: "If you produced the evidence bundle (a screenshot and/or evidence.md under <runDir>/evidence/, plus a video if warranted), end with `validate`. Only if you could not produce ANY evidence at all, end with `implement`. End with the bare token on its own final line.",
        validNext: ["validate", "implement"]
      },
      {
        id: "validate", title: "Validate", order: 10, kind: "agent", trigger: "immediate",
        skill: "autothing-validate", taskType: "ops", tier: "T1-standard", mode: "joe",
        executePrompt:
          "Run autothing-validate against this card's run directory + slice: check every APPLICABLE DoD gate (tests/typecheck/lint/build/e2e, review, adversarial passes) and write the durable gate record. " +
          "CONFIRM the evidence bundle exists under `<runDir>/evidence/` (a screenshot and/or evidence.md, plus a video if one was warranted) — that tangible proof is part of the DoD. " +
          "A gate that was legitimately size-skipped for a trivial change (e.g. a Codex pass or a full video on a 1-line text change) COUNTS AS SATISFIED — do not fail the DoD for an artifact a trivial change never needed, but DO expect at least the evidence.md log. Keep your reply short.",
        routerPrompt: "If the Definition of Done holds — all applicable gates pass or are size-skip-satisfied AND the evidence bundle exists — end with `done`. Only if a gate genuinely FAILED or NO evidence was produced, end with `implement`. End with the bare token on its own final line.",
        validNext: ["done", "implement"]
      },
      { id: "done", title: "Done", order: 11, kind: "manual", trigger: "manual", terminal: true, validNext: [] },
      {
        id: "needs-attention", title: "Needs attention", order: 12, kind: "manual", trigger: "manual",
        // Always notifies on entry (the surface honours notifyOnEntry).
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

async function registerTestBeat() {
  // The Test list fires on its own cadence (default every 5h), NOT the global
  // heartbeat. Register it with the scheduler at setup time (idempotent: remove + add),
  // mirroring the improver/morning-briefing pattern. Cadence is configurable via
  // KANBAN_TEST_BEAT_CRON.
  const cron = process.env.KANBAN_TEST_BEAT_CRON || "0 */5 * * *"; // every 5 hours
  const cli = schedulerCli();
  const self = path.resolve(__dirname, "kanban.mjs");
  const cmd = `node ${self} --tick-list test`;
  if (!existsSync(cli)) {
    console.log(`kanban-loop: scheduler CLI not found at ${cli} (skipping Test beat; register manually).`);
    return;
  }
  const { spawnSync } = await import("node:child_process");
  spawnSync("node", [cli, "remove", "kanban-test-beat"], { stdio: "ignore" });
  const add = spawnSync("node", [cli, "add", "kanban-test-beat", cron, cmd], { encoding: "utf8" });
  if (add.status === 0) {
    console.log(`kanban-loop: registered kanban-test-beat @ '${cron}' -> ${cmd}`);
  } else {
    console.log(`kanban-loop: scheduler add failed (non-fatal in dev): ${add.stderr || add.stdout || add.status}`);
  }
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
  await registerTestBeat();
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
  return async ({ project, cards, list, classification, suppressContinuations }) => {
    const roster = cards
      .map((c) => `- ${c.id} :: title="${c.title}" runDir=${c.runDir || "(none)"} slice=${c.sliceId || "(none)"}`)
      .join("\n");
    const prompt = [
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
        skill: list?.skill ?? null,
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
  const cards = await loadAllCards(root);
  const cap = Number(process.env.GARRISON_KANBAN_ITERATION_CAP || 10);
  const runFn = gatewayRunFn(gatewayUrl);
  let processed = 0;
  for (const card of cards) {
    const list = getList(board, card.list);
    if (!list || list.kind !== "agent") continue;        // manual / agent-interactive skip
    if (triggerFor(list) !== "immediate") continue;       // scheduler-beat / manual skip
    if (isInteractive(list)) continue;                    // belt-and-suspenders
    if (card.status === "running" || card.status === "needs-attention") continue;
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
  const cards = await loadAllCards(root);
  const cap = Number(process.env.GARRISON_KANBAN_ITERATION_CAP || 10);

  if (list.batched) {
    const batchRunFn = batchGatewayRunFn(gatewayUrl);
    const listCards = cards.filter((c) => c.list === listId);
    const { outcomes } = await processBatch({ root, board, listId, cards: listCards, batchRunFn, cap });
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
