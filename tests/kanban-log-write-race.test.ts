import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// @ts-ignore pure mjs
import { atomicWriteJSON, loadCard, writeCardLog } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore pure mjs
import { processCard } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore pure mjs
import { resetPolicyCache } from "../fittings/seed/kanban-loop/lib/policy.mjs";
// @ts-ignore pure mjs
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";

const previousPolicyPath = process.env.GARRISON_POLICY_PATH;

afterEach(() => {
  if (previousPolicyPath === undefined) delete process.env.GARRISON_POLICY_PATH;
  else process.env.GARRISON_POLICY_PATH = previousPolicyPath;
  resetPolicyCache();
});

describe("Kanban live-log write ordering", () => {
  it("uses independent atomic temp files for concurrent rewrites", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kanban-log-atomic-"));
    const id = "01LOGRACECARD0000000000000";
    const payloads = Array.from(
      { length: 32 },
      (_, index) => `payload-${index}:${String(index).repeat(2048)}`
    );

    await expect(Promise.all(
      payloads.map((payload) => writeCardLog(root, id, 1, payload))
    )).resolves.toHaveLength(payloads.length);

    const cardDir = path.join(root, "cards", id);
    const written = readFileSync(path.join(cardDir, "log-1.md"), "utf8");
    expect(payloads.map((payload) => `${payload}\n`)).toContain(written);
    expect(readdirSync(cardDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("drains streamed chunks before the authoritative reply and ignores late callbacks", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kanban-log-final-"));
    const card = {
      id: "01LOGFINALCARD000000000000",
      title: "review the cache",
      description: "verify correctness",
      project: "cache-project",
      list: "review",
      status: "ok",
      iterations: 0,
      rev: 0,
      goalMode: false,
      acceptance: null,
      events: [],
      runId: "01LOGFINALRUN0000000000000",
      runDir: path.join(root, "runs", "01LOGFINALRUN0000000000000"),
      created: "2026-07-16T00:00:00.000Z",
      updated: "2026-07-16T00:00:00.000Z"
    };
    mkdirSync(path.join(root, "cards", card.id), { recursive: true });
    mkdirSync(card.runDir, { recursive: true });
    await atomicWriteJSON(path.join(root, "cards", card.id, "card.json"), card);

    // Deliberate policy-less mode keeps this test focused on log finalization.
    process.env.GARRISON_POLICY_PATH = path.join(root, "missing-policy.json");
    resetPolicyCache();

    let lateChunk: (full: string) => void = () => {
      throw new Error("runFn did not expose its live-log callback");
    };
    const { outcome } = await processCard({
      root,
      board: seedBoard(),
      card,
      cwd: root,
      runFn: async ({ onChunk }: { onChunk: (full: string) => void }) => {
        lateChunk = onChunk;
        // Under the old fire-and-forget implementation these shared one
        // PID-scoped temp path with each other and the final write.
        for (let index = 0; index < 24; index += 1) {
          onChunk(`partial-${index}:${"x".repeat(32_768)}`);
        }
        return { reply: "authoritative review\nadversarial-review" };
      }
    });

    expect(outcome).toMatchObject({ status: "moved", to: "adversarial-review" });
    expect((await loadCard(root, card.id)).status).not.toBe("running");

    // A transport retaining the callback past its resolved result must not be
    // able to replace the already-finalized reply.
    lateChunk("late partial that must be ignored");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const cardDir = path.join(root, "cards", card.id);
    expect(readFileSync(path.join(cardDir, "log-1.md"), "utf8")).toBe(
      "# iteration 1\nauthoritative review\nadversarial-review\n"
    );
    expect(readdirSync(cardDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
