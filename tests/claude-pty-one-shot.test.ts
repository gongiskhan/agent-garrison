import { afterEach, describe, expect, it, vi } from "vitest";

const PKG = "@garrison/claude-pty";

type Event =
  | { kind: "effort"; bytes: string }
  | { kind: "observer" }
  | { kind: "run-turn" }
  | { kind: "message"; message: string }
  | { kind: "dispose" };

function fakeSession(events: Event[]) {
  let disposed = false;
  return {
    writeKeys(bytes: string) {
      events.push({ kind: "effort", bytes });
    },
    async runTurn(req: { message: string }) {
      events.push({ kind: "run-turn" });
      // Mirrors OperativePtySession.runTurn's pre-submit disposal guard.
      if (disposed) throw new Error("OperativePtySession is disposed; cannot run a new turn.");
      events.push({ kind: "message", message: req.message });
      return { reply: "ok", sessionId: "one-shot-session" };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      events.push({ kind: "dispose" });
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("claude-pty: one-shot native effort and cancellation", () => {
  it("settles native effort before publishing the session and submits the exact message", async () => {
    const { OperativePtySession, oneShotTurn } = await import(PKG);
    const events: Event[] = [];
    const session = fakeSession(events);
    const spawn = vi.spyOn(OperativePtySession, "spawn").mockResolvedValue(session as never);

    const message = "  preserve leading space\r\nand trailing space  ";
    const providerEnv = {
      PATH: "/bin",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:11434",
      ANTHROPIC_AUTH_TOKEN: "local-test-token",
    };
    const outcome = await oneShotTurn({
      cwd: "/unused",
      effort: "high",
      effortSettleMs: 0,
      env: providerEnv,
      providerLaunch: true,
      message,
      onSession: (published: unknown) => {
        expect(published).toBe(session);
        events.push({ kind: "observer" });
      },
    });

    expect(events).toEqual([
      { kind: "effort", bytes: "/effort high\r" },
      { kind: "observer" },
      { kind: "run-turn" },
      { kind: "message", message },
      { kind: "dispose" },
    ]);
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      env: providerEnv,
      providerLaunch: true,
    }));
    expect(outcome).toEqual({ reply: "ok", sessionId: "one-shot-session", effortApplied: true });
  });

  it("honors a Stop latched during effort settle before any user-message bytes are submitted", async () => {
    vi.useFakeTimers();
    const { OperativePtySession, oneShotTurn } = await import(PKG);
    const events: Event[] = [];
    const session = fakeSession(events);
    vi.spyOn(OperativePtySession, "spawn").mockResolvedValue(session as never);

    let stopRequested = false;
    const turn = oneShotTurn({
      cwd: "/unused",
      effort: "max",
      effortSettleMs: 100,
      message: "must never be submitted",
      onSession: (published: { dispose(): void }) => {
        events.push({ kind: "observer" });
        // The caller's cancellation registry latches Stop until the disposable
        // session is published. Registration then applies it synchronously.
        if (stopRequested) {
          published.dispose();
          throw Object.assign(new Error("turn interrupted before runtime start"), {
            code: "turn_interrupted_before_runtime",
          });
        }
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([{ kind: "effort", bytes: "/effort max\r" }]);

    // Stop arrives while the native command is settling, before onSession.
    stopRequested = true;
    await vi.advanceTimersByTimeAsync(99);
    expect(events).toEqual([{ kind: "effort", bytes: "/effort max\r" }]);

    const rejected = expect(turn).rejects.toMatchObject({ code: "turn_interrupted_before_runtime" });
    await vi.advanceTimersByTimeAsync(1);
    await rejected;

    expect(events).toEqual([
      { kind: "effort", bytes: "/effort max\r" },
      { kind: "observer" },
      { kind: "dispose" },
    ]);
    expect(events.some((event) => event.kind === "message")).toBe(false);
  });
});
