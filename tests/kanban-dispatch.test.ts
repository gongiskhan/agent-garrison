// V1c regression: "moving a card to Plan does nothing" — the board now AUTO-DISPATCHES a
// card's run when it is moved onto an immediate agent list (shouldAutoDispatch), and only
// then (manual/interactive/scheduler-beat targets just move). Plus the engine actually
// runs + advances the card when dispatched (processCard with an injected runFn — the same
// path the board's gatewayRunFn drives against the live gateway).
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs
import { shouldAutoDispatch } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore — pure .mjs
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore — pure .mjs
import { createCard, loadCard } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { processCard } from "../fittings/seed/kanban-loop/lib/engine.mjs";

const board = seedBoard();
const tmp = () => mkdtempSync(join(tmpdir(), "kanban-dispatch-"));

describe("v1c shouldAutoDispatch — Move onto an immediate agent list starts the run", () => {
  it("true ONLY for immediate agent lists", () => {
    expect(shouldAutoDispatch(board, "plan")).toBe(true);        // immediate agent
    expect(shouldAutoDispatch(board, "implement")).toBe(true);   // immediate agent
    expect(shouldAutoDispatch(board, "adversarial-review")).toBe(true);
    expect(shouldAutoDispatch(board, "validate")).toBe(true);
  });
  it("false for manual / interactive / scheduler-beat / unknown lists", () => {
    expect(shouldAutoDispatch(board, "backlog")).toBe(false);    // manual
    expect(shouldAutoDispatch(board, "todo")).toBe(false);       // manual
    expect(shouldAutoDispatch(board, "discuss")).toBe(false);    // interactive (James web chat)
    expect(shouldAutoDispatch(board, "test")).toBe(false);       // scheduler-beat (batched)
    expect(shouldAutoDispatch(board, "done")).toBe(false);       // manual terminal
    expect(shouldAutoDispatch(board, "no-such-list")).toBe(false);
  });

  it("when dispatched, the engine runs the card through the gateway runFn and advances it", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "SSO fix", project: "m365", list: "plan" });
    // The board's gatewayRunFn POSTs to the gateway; here we inject a stub that returns
    // the plan list's verdict (its router-prompt ends with `implement`).
    const runFn = async () => ({ reply: "implement" });
    const { outcome } = await processCard({ root, board, card, runFn, cap: 10 });
    expect(outcome.status).toBe("moved");
    expect(outcome.to).toBe("implement");
    const disk = await loadCard(root, card.id);
    expect(disk.list).toBe("implement");
    expect(typeof disk.runId).toBe("string");           // runId minted on the first agent-list entry
    expect(disk.runDir).toBe(`docs/autothing/runs/${disk.runId}`);
  });
});
