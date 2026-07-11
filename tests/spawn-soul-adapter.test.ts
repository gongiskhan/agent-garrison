import { describe, expect, it, vi, beforeEach } from "vitest";
import path from "node:path";

// The adapter's only claude-pty dependency is OperativePtySession.spawn — mock
// it so the wedge-fallback / exit-propagation / queue behavior is testable
// without a live claude TUI.
const spawnMock = vi.fn();
vi.mock("@garrison/claude-pty", () => ({
  OperativePtySession: {
    spawn: (...args: unknown[]) => spawnMock(...args),
  },
}));

const SPAWN_SOUL = path.resolve(
  __dirname,
  "..",
  "fittings",
  "seed",
  "http-gateway",
  "scripts",
  "lib",
  "spawn-soul.mjs"
);

type ExitHandler = (ev: { exitCode: number }) => void;

function fakeSession(overrides: Record<string, unknown> = {}) {
  const exitHandlers: ExitHandler[] = [];
  return {
    exitHandlers,
    handle: {
      onExit(h: ExitHandler) {
        exitHandlers.push(h);
        return { dispose() {} };
      },
    },
    screen: () => [] as string[],
    getClaudeSessionId: () => "claude-uuid",
    isAlive: () => true,
    runTurn: vi.fn(async () => ({ reply: "hello from soul" })),
    dispose: vi.fn(),
    ...overrides,
  };
}

function adapterOpts(overrides: Record<string, unknown> = {}) {
  return {
    sessionUuid: "u-1111",
    spawnConfig: {},
    promptPath: undefined,
    cwd: "/tmp",
    tierFlags: [],
    mcpConfigPath: null,
    isOrchestrator: true,
    resume: false,
    onEvent: vi.fn(),
    onResult: vi.fn(),
    onExit: vi.fn(),
    ...overrides,
  };
}

async function flushQueue(adapter: { queue: Promise<unknown> }) {
  // Two rounds: the queue promise itself, then the microtasks chained on it.
  for (let i = 0; i < 4; i++) {
    await (adapter.queue as Promise<unknown>).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("spawn-soul PtySoulAdapter", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("resume that exits at startup falls back to a fresh spawn with the same uuid", async () => {
    const startupErr = Object.assign(
      new Error("Claude exited during startup:\nNo conversation found with session ID: u-1111"),
      { name: "StartupExitError" }
    );
    const session = fakeSession();
    spawnMock.mockRejectedValueOnce(startupErr).mockResolvedValueOnce(session);

    const { spawnHeadless } = await import(SPAWN_SOUL);
    const opts = adapterOpts({ resume: true });
    const adapter = spawnHeadless(opts);
    await adapter.ready;

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0][0]).toMatchObject({ resumeSessionId: "u-1111" });
    expect(spawnMock.mock.calls[0][0].sessionUuid).toBeUndefined();
    expect(spawnMock.mock.calls[1][0]).toMatchObject({ sessionUuid: "u-1111" });
    expect(spawnMock.mock.calls[1][0].resumeSessionId).toBeUndefined();
    expect(adapter.dead).toBe(false);
    expect(opts.onExit).not.toHaveBeenCalled();
  });

  it("resume wedged on a live banner screen is disposed and respawned fresh", async () => {
    const wedged = fakeSession({
      screen: () => ["  No conversation found with session ID: u-1111  "],
    });
    const clean = fakeSession();
    spawnMock.mockResolvedValueOnce(wedged).mockResolvedValueOnce(clean);

    const { spawnHeadless } = await import(SPAWN_SOUL);
    const adapter = spawnHeadless(adapterOpts({ resume: true }));
    await adapter.ready;

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(wedged.dispose).toHaveBeenCalled();
    expect(adapter.dead).toBe(false);
  });

  it("an auth trap is NOT retried fresh (a fresh spawn would trap identically)", async () => {
    const authErr = Object.assign(new Error("login screen"), { name: "AuthTrapError" });
    spawnMock.mockRejectedValue(authErr);

    const { spawnHeadless } = await import(SPAWN_SOUL);
    const opts = adapterOpts({ resume: true });
    const adapter = spawnHeadless(opts);
    await expect(adapter.ready).rejects.toThrow("login screen");
    await new Promise((r) => setTimeout(r, 0));

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(adapter.dead).toBe(true);
    expect(opts.onExit).toHaveBeenCalledWith(1, "spawn-failed");
    expect(adapter.write("hi")).toBe(false);
  });

  it("child exit marks the adapter dead, fires onExit, and rejects new turns", async () => {
    const session = fakeSession();
    spawnMock.mockResolvedValue(session);

    const { spawnHeadless } = await import(SPAWN_SOUL);
    const opts = adapterOpts();
    const adapter = spawnHeadless(opts);
    await adapter.ready;
    expect(adapter.write("first")).toBeTruthy();

    session.exitHandlers[0]({ exitCode: 3 });
    expect(adapter.dead).toBe(true);
    expect(opts.onExit).toHaveBeenCalledWith(3, null);
    expect(adapter.write("second")).toBe(false);
  });

  it("write() returns a PER-TURN promise — concurrent turns never cross replies", async () => {
    const session = fakeSession();
    (session.runTurn as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ reply: "reply-for-A" })
      .mockResolvedValueOnce({ reply: "reply-for-B" });
    spawnMock.mockResolvedValue(session);

    const { spawnHeadless } = await import(SPAWN_SOUL);
    const adapter = spawnHeadless(adapterOpts());
    await adapter.ready;

    const a = adapter.write("turn A");
    const b = adapter.write("turn B");
    expect(await a).toBe("reply-for-A");
    expect(await b).toBe("reply-for-B");
    // and the underlying TUI saw them serially, in order
    const calls = (session.runTurn as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].message).toBe("turn A");
    expect(calls[1][0].message).toBe("turn B");
  });

  it("a failed turn resolves ITS OWN promise with the error text and later turns still run", async () => {
    const session = fakeSession();
    (session.runTurn as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ reply: "after-failure" });
    spawnMock.mockResolvedValue(session);

    const { spawnHeadless } = await import(SPAWN_SOUL);
    const adapter = spawnHeadless(adapterOpts());
    await adapter.ready;

    expect(await adapter.write("bad")).toContain("[operative error] boom");
    expect(await adapter.write("good")).toBe("after-failure");
  });

  it("a failed turn resolves waiters with an error result and does not poison the queue", async () => {
    const session = fakeSession();
    (session.runTurn as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ reply: "recovered" });
    spawnMock.mockResolvedValue(session);

    const { spawnHeadless } = await import(SPAWN_SOUL);
    const opts = adapterOpts();
    const adapter = spawnHeadless(opts);
    await adapter.ready;

    adapter.write("turn-1");
    await flushQueue(adapter);
    expect(opts.onResult).toHaveBeenCalledTimes(1);
    expect(String(opts.onResult.mock.calls[0][0])).toContain("[operative error] boom");

    adapter.write("turn-2");
    await flushQueue(adapter);
    expect(opts.onResult).toHaveBeenCalledTimes(2);
    expect(opts.onResult.mock.calls[1][0]).toBe("recovered");
  });

  it("a turn queued behind a failed spawn resolves with a start-failure result", async () => {
    spawnMock.mockRejectedValue(new Error("spawn exploded"));

    const { spawnHeadless } = await import(SPAWN_SOUL);
    const opts = adapterOpts();
    const adapter = spawnHeadless(opts);
    // Queue before the rejection lands.
    expect(adapter.write("early turn")).toBeTruthy();
    await flushQueue(adapter);

    expect(opts.onResult).toHaveBeenCalledTimes(1);
    expect(String(opts.onResult.mock.calls[0][0])).toContain("operative failed to start");
    expect(String(opts.onResult.mock.calls[0][0])).toContain("spawn exploded");
  });
});
