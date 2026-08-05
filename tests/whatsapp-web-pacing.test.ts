import { describe, expect, it } from "vitest";
import { randomDelayMs, SendQueue } from "../fittings/seed/whatsapp-web/lib/pacing.mjs";

describe("whatsapp-web randomDelayMs", () => {
  it("stays within [min, max]", () => {
    for (let i = 0; i < 200; i++) {
      const d = randomDelayMs(100, 200);
      expect(d).toBeGreaterThanOrEqual(100);
      expect(d).toBeLessThanOrEqual(200);
    }
  });

  it("clamps a negative min to 0", () => {
    const d = randomDelayMs(-50, 10);
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThanOrEqual(10);
  });

  it("returns exactly min when min === max", () => {
    expect(randomDelayMs(500, 500)).toBe(500);
  });
});

// Rule 6 of the brief: human-like pacing, no bursts. The queue is the ONLY
// path a send goes through, so these tests stand in for "no batch send is
// possible" — every task is delayed and strictly serialized.
describe("whatsapp-web SendQueue", () => {
  it("delays each task via the injected sleep function", async () => {
    const sleeps: number[] = [];
    const queue = new SendQueue({
      minDelayMs: 10,
      maxDelayMs: 10,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      }
    });
    await queue.enqueue(async () => "ok");
    expect(sleeps).toEqual([10]);
  });

  it("serializes tasks — the second never starts before the first resolves", async () => {
    const order: string[] = [];
    const queue = new SendQueue({ minDelayMs: 0, maxDelayMs: 0, sleep: async () => {} });

    const first = queue.enqueue(async () => {
      order.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first-end");
      return "a";
    });
    const second = queue.enqueue(async () => {
      order.push("second-start");
      return "b";
    });

    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("a failed task does not wedge tasks queued after it", async () => {
    const queue = new SendQueue({ minDelayMs: 0, maxDelayMs: 0, sleep: async () => {} });
    const first = queue.enqueue(async () => {
      throw new Error("boom");
    });
    const second = queue.enqueue(async () => "recovered");

    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("recovered");
  });
});
