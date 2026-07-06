import { describe, it, expect, vi } from "vitest";
// @ts-ignore — pure .mjs
import { createSerializer, withTimeout } from "../fittings/seed/http-gateway/scripts/lib/serializer.mjs";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createSerializer", () => {
  it("runs turns strictly one at a time, in enqueue order", async () => {
    const enqueue = createSerializer();
    const order: string[] = [];
    const gates: Array<() => void> = [];

    // Each turn records start, then holds the queue until we manually release it.
    const mkTurn = (id: string) => enqueue(async (release: () => void) => {
      order.push(`start:${id}`);
      gates.push(() => { order.push(`release:${id}`); release(); });
      return id;
    });

    const p1 = mkTurn("a");
    const p2 = mkTurn("b");
    await tick();

    // Only turn A has started; B is queued behind A's release.
    expect(order).toEqual(["start:a"]);
    await p1; // fn resolved (write done) — but the queue is still held by A

    gates[0](); // release A
    await tick();
    await p2;
    expect(order).toEqual(["start:a", "release:a", "start:b"]);
  });

  it("auto-releases after maxHoldMs so a wedged turn can't block the queue forever", async () => {
    vi.useFakeTimers();
    try {
      const enqueue = createSerializer({ maxHoldMs: 1000 });
      const started: string[] = [];
      // Turn A never calls release → should auto-release after 1s.
      enqueue(async () => { started.push("a"); return "a"; });
      const pB = enqueue(async () => { started.push("b"); return "b"; });
      await vi.advanceTimersByTimeAsync(0); // flush microtasks so A starts + holds
      expect(started).toEqual(["a"]);
      await vi.advanceTimersByTimeAsync(1001);
      await pB;
      expect(started).toEqual(["a", "b"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the queue even if a turn throws", async () => {
    const enqueue = createSerializer();
    await expect(enqueue(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    // The next turn must still run (queue not deadlocked).
    await expect(enqueue(async () => "ok")).resolves.toBe("ok");
  });
});

describe("withTimeout", () => {
  it("passes through a value that settles in time", async () => {
    await expect(withTimeout(Promise.resolve("v"), 1000, () => "timeout")).resolves.toBe("v");
  });
  it("resolves with onTimeout() when the promise hangs", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise(() => {});
      const p = withTimeout(never, 500, () => "timed-out");
      await vi.advanceTimersByTimeAsync(501);
      await expect(p).resolves.toBe("timed-out");
    } finally {
      vi.useRealTimers();
    }
  });
  it("propagates rejection", async () => {
    await expect(withTimeout(Promise.reject(new Error("x")), 1000, () => "t")).rejects.toThrow("x");
  });
});
