#!/usr/bin/env node
// Kanban Loop V1a CLI: --setup (seed the board) | --probe (verify) | --tick
// (process due immediate agent-list cards). The board UI is V1b.
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { kanbanRoot, atomicWriteJSON, loadBoard, loadAllCards } from "../lib/board.mjs";
import { processCard, getList } from "../lib/engine.mjs";

// §8 default board: manual columns + agent lists mapped to the garrison-* verb
// skills (§9: skill is explicit per list), each with an explicit {taskType,tier}
// (§10) and the valid next lists. No per-list effort/model (the router decides);
// no Infer column (low-confidence inference → needs-attention).
function seedBoard() {
  return {
    version: 1,
    lists: [
      { id: "backlog", title: "Backlog", order: 0, kind: "manual", validNext: ["todo"] },
      { id: "todo", title: "To Do", order: 1, kind: "manual", validNext: ["plan"] },
      {
        id: "plan", title: "Plan", order: 2, kind: "agent", skill: "garrison-planning", taskType: "code", tier: "T2-deep",
        executePrompt: "Plan this card: explore, then write FLOW_PLAN.md with machine-checkable acceptance.",
        routerPrompt: "If the plan is ready to build, choose `implement`; else choose `needs-attention`.",
        validNext: ["implement", "needs-attention"]
      },
      {
        id: "implement", title: "Implement", order: 3, kind: "agent", skill: "garrison-architecture", taskType: "code", tier: "T2-deep",
        executePrompt: "Implement the planned slice end-to-end, following existing conventions.",
        routerPrompt: "When the code is written and self-checks pass, choose `review`.",
        validNext: ["review", "needs-attention"]
      },
      {
        id: "review", title: "Review", order: 4, kind: "agent", skill: "code-review", taskType: "review", tier: "T1-standard",
        executePrompt: "Review the change for correctness then quality.",
        routerPrompt: "If clean, choose `test`; if real issues remain, choose `implement`.",
        validNext: ["test", "implement", "needs-attention"]
      },
      {
        id: "test", title: "Test", order: 5, kind: "agent", skill: "garrison-testing", taskType: "code", tier: "T2-deep",
        executePrompt: "Write + run the committed correctness gate (and typecheck/lint/build).",
        routerPrompt: "If green, choose `validate`; if failing, choose `implement`.",
        validNext: ["validate", "implement", "needs-attention"]
      },
      {
        id: "validate", title: "Validate", order: 6, kind: "agent", skill: "garrison-governance", taskType: "ops", tier: "T1-standard",
        executePrompt: "Enforce the Definition of Done; write the durable gate record.",
        routerPrompt: "If the DoD holds, choose `done`; else choose `implement`.",
        validNext: ["done", "implement", "needs-attention"]
      },
      { id: "done", title: "Done", order: 7, kind: "manual", validNext: [] },
      { id: "needs-attention", title: "Needs attention", order: 8, kind: "manual", validNext: ["todo", "plan", "implement"] }
    ],
    projects: {}
  };
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
}

async function probe() {
  try {
    await loadBoard();
  } catch {
    // an absent board is fine for the probe — setup seeds it
  }
  if (typeof processCard !== "function") {
    console.error("KANBAN-FAIL: engine not loadable");
    process.exit(1);
  }
  console.log("KANBAN-OK");
}

// Dispatch a card's combined prompt through the orchestrator front door (the
// gateway /chat → preRoute). The board's cards must reach a running gateway; with
// no GARRISON_GATEWAY_URL this is a no-op tick.
function gatewayRunFn(gatewayUrl) {
  return async ({ prompt }) => {
    const res = await fetch(`${gatewayUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-garrison-origin": "channel" },
      body: JSON.stringify({ channel: "kanban", message: prompt })
    });
    if (!res.ok) throw new Error(`kanban dispatch failed: HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    return { reply: data.reply ?? data.text ?? "" };
  };
}

async function tick() {
  const gatewayUrl = process.env.GARRISON_GATEWAY_URL;
  if (!gatewayUrl) {
    console.log("kanban-loop: no GARRISON_GATEWAY_URL — nothing to dispatch (immediate cards wait).");
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
    if (!list || list.kind !== "agent" || list.trigger === "manual" || list.trigger === "heartbeat") continue;
    if (card.status === "running" || card.status === "needs-attention") continue;
    const { outcome } = await processCard({ root, board, card, runFn, cap });
    console.log(`kanban-loop: card ${card.id} → ${outcome.status}${outcome.to ? " " + outcome.to : ""}`);
    processed++;
  }
  console.log(`kanban-loop: tick processed ${processed} card(s)`);
}

const arg = process.argv[2];
if (arg === "--setup") await setup();
else if (arg === "--probe") await probe();
else if (arg === "--tick") await tick();
else console.log("usage: kanban.mjs --setup | --probe | --tick");
