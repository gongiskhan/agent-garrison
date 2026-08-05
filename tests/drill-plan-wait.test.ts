import { describe, expect, it, vi } from "vitest";
import { waitForPlanStatus } from "../fittings/seed/drill/ui/plan-wait";

describe("Drill plan client wait", () => {
  it("keeps following a server-owned plan beyond the obsolete 31-minute client cutoff", async () => {
    let elapsedMs = 0;
    let polls = 0;
    const phases: Array<string | null> = [];
    const deadlineAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    const result = await waitForPlanStatus({
      getStatus: async () => {
        polls += 1;
        return {
          root: "/tmp/app",
          pages: 0,
          job: polls <= 32
            ? { status: "planning", mode: "full", error: null, deadlineAt }
            : { status: "done", mode: "full", error: null, deadlineAt }
        };
      },
      onPhase: (phase) => phases.push(phase),
      sleep: async (ms) => { elapsedMs += ms; },
      // One simulated minute per poll makes the old 31-minute regression
      // explicit without making the test wait in real time.
      pollMs: 60_000
    });

    expect(elapsedMs).toBe(32 * 60_000);
    expect(result.job?.status).toBe("done");
    expect(polls).toBe(33);
    expect(phases.at(-1)).toBeNull();
  });

  it("preserves failed, canceled, and lost-job terminal semantics", async () => {
    await expect(waitForPlanStatus({
      getStatus: async () => ({ job: { status: "failed", mode: "full", error: "agent failed" } }),
      onPhase: vi.fn(),
      sleep: async () => {}
    })).rejects.toThrow("agent failed");

    await expect(waitForPlanStatus({
      getStatus: async () => ({ job: null }),
      onPhase: vi.fn(),
      sleep: async () => {}
    })).rejects.toThrow("plan job lost");

    const onPhase = vi.fn();
    const canceled = await waitForPlanStatus({
      getStatus: async () => ({ job: { status: "canceled", mode: "update", error: null } }),
      onPhase,
      sleep: async () => {}
    });
    expect(canceled.job?.status).toBe("canceled");
    expect(onPhase).toHaveBeenCalledWith(null);
  });
});
