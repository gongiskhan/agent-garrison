// Boot-time recovery of interrupted runs: a card acquired as status:"running"
// whose dispatch died with the board process (server restart mid-processChain)
// must be swept back to a retryable state at startup — not sit "running"
// forever with its Run button hidden and its timer counting a run that no
// longer exists.
import { describe, it, expect } from "vitest";

process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";
import { mkdtempSync as __mkdtemp } from "node:fs";
import { tmpdir as __tmpdir } from "node:os";
import { join as __join } from "node:path";
process.env.GARRISON_RUNS_DIR = __mkdtemp(__join(__tmpdir(), "runs-home-"));

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs
import { createCard, loadCard, saveCard } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { recoverInterruptedRuns } from "../fittings/seed/kanban-loop/lib/engine.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "kanban-recover-"));

describe("recoverInterruptedRuns — stale running cards are swept at boot", () => {
  it("clears running state, keeps the iteration, and marks a retryable interrupted error", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "stranded run", project: "demo", list: "plan" });
    await saveCard(root, {
      ...card,
      status: "running",
      iterations: 3,
      runningSince: "2026-07-10T17:13:43.527Z"
    });

    const recovered = await recoverInterruptedRuns(root);
    expect(recovered).toEqual([card.id]);

    const after = await loadCard(root, card.id);
    expect(after.status).toBe("ok");
    expect(after.runningSince).toBeNull();
    expect(after.iterations).toBe(3); // a dispatch really happened — keep it consumed
    expect(after.lastDispatchError?.reason).toBe("interrupted");
    expect(after.lastDispatchError?.listId).toBe("plan");
    const kinds = (after.events || []).map((e: { kind: string }) => e.kind);
    expect(kinds).toContain("recovered");
  });

  it("leaves non-running cards untouched", async () => {
    const root = tmp();
    const a = await createCard(root, { title: "idle card", project: "demo", list: "plan" });
    const recovered = await recoverInterruptedRuns(root);
    expect(recovered).toEqual([]);
    const after = await loadCard(root, a.id);
    expect(after.status).toBe(a.status ?? "ok");
    expect(after.lastDispatchError ?? null).toBeNull();
  });
});
