import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A genuinely unresolvable conflict (the fresh content drifted too far for
// applyWithRetry's single automatic retry to reconcile) is a real, if rare,
// outcome of apply-core.mjs's baselineSha 409 contract - its own retry loop
// only re-reads once, so a target that keeps moving still 409s. Rather than
// racing a real filesystem write against the retry's narrow window, mock
// apply-core.mjs's applyWithRetry to return that outcome deterministically and
// assert reapply-sweep's own handling of it: reapply-failed, not a crash.
vi.mock("../fittings/seed/improver/lib/apply-core.mjs", () => ({
  applyWithRetry: vi.fn(async () => ({ ok: false, code: "conflict", current: { sha: "sha256:new" }, expected: "sha256:old" })),
  markerFor: (id: string) => `<!-- improver:${id} -->`,
}));

// @ts-ignore - pure .mjs
const { runReapplySweep } = await import("../fittings/seed/improver/lib/reapply-sweep.mjs");
// @ts-ignore - pure .mjs
const { loadQueue } = await import("../fittings/seed/improver/lib/review-queue.mjs");

describe("reapply-sweep - unresolvable conflict", () => {
  it("marks reapply-failed with a conflict reason instead of crashing", async () => {
    const root = mkdtempSync(join(tmpdir(), "gar-sweep-conflict-"));
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const target = join(root, "knowledge-memory.md");
    writeFileSync(target, "# Memory\nclobbered, no marker here\n", "utf8");

    const entry = {
      id: "id-conflict",
      rule: "memory-consolidation",
      diff: "+ line",
      status: "applied",
      at: "2026-06-15T00:00:00Z",
      evidence: { targetFile: target },
    };
    const queuePath = join(stateDir, "review-queue.json");
    writeFileSync(queuePath, JSON.stringify([entry], null, 2), "utf8");

    const summary = await runReapplySweep({ stateDir, queuePath });
    expect(summary.restored).toBe(0);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0].id).toBe("id-conflict");
    expect(summary.failed[0].reason).toMatch(/conflict/);

    const queue = await loadQueue(queuePath);
    expect(queue[0].status).toBe("reapply-failed");
    expect(queue[0].reapplyFailureReason).toMatch(/conflict/);
  });
});
