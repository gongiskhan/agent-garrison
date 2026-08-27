import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Outbox, OUTBOUND_DELAY_SECONDS, resolveSendContext } from "../fittings/seed/whatsapp-web/lib/outbox.mjs";

// The delay buffer itself (brief §8.4). An outbound message is the irreversible
// category, so an agent-triggered send is PARKED for a cancel window and only
// executed when the window elapses uncancelled — that is what makes it
// revertible in practice, and revertible-in-practice is the only reason an
// autonomy band may ever grant act-without-asking on it.
//
// Time and timers are injected throughout: a test that actually waited 60
// seconds would be a test nobody runs.

class FakeClock {
  t = 1_760_000_000_000;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now = () => this.t;
  setTimer = (fn: () => void, delay: number) => {
    const handle = ++this.seq;
    this.timers.set(handle, { at: this.t + delay, fn });
    return handle as unknown as NodeJS.Timeout;
  };
  clearTimer = (handle: unknown) => {
    this.timers.delete(handle as number);
  };

  /** Advance the clock and run every timer that came due, oldest first. */
  async advance(ms: number) {
    this.t += ms;
    const due = [...this.timers.entries()].filter(([, t]) => t.at <= this.t).sort((a, b) => a[1].at - b[1].at);
    for (const [handle, timer] of due) {
      this.timers.delete(handle);
      timer.fn();
    }
    // Let the async fire() chain settle before assertions.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  get armed() {
    return this.timers.size;
  }
}

function makeOutbox(
  file: string,
  clock: FakeClock,
  opts: { fail?: boolean; gate?: (ctx: string) => void; groupKey?: (entry: any) => string } = {}
) {
  const sent: any[] = [];
  const batches: any[][] = [];
  const outbox = new Outbox({
    file,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    groupKey: opts.groupKey ?? null,
    send: async (entry: any, batch: any[]) => {
      if (opts.gate) opts.gate(entry.context);
      if (opts.fail) throw new Error("wire refused it");
      sent.push(entry);
      batches.push(batch);
      return { id: `wamid.${sent.length}` };
    }
  });
  return { outbox, sent, batches };
}

describe("outbox delay buffer", () => {
  let dir: string;
  let file: string;
  let clock: FakeClock;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "outbox-"));
    file = path.join(dir, "outbox.json");
    clock = new FakeClock();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("copies the taxonomy's window: 60 seconds", () => {
    // fittings/seed/orchestrator/lib/routing-autonomy.mjs declares
    // OUTBOUND_DELAY_SECONDS = 60; the copy here must not drift from it.
    expect(OUTBOUND_DELAY_SECONDS).toBe(60);
  });

  it("enqueue parks the send and sends nothing yet", () => {
    const { outbox, sent } = makeOutbox(file, clock);
    const entry = outbox.enqueue({ action: "send_text", payload: { jid: "351900000000@s.whatsapp.net", body: "hi" }, context: "agent" });
    expect(entry.status).toBe("pending");
    expect(Date.parse(entry.executeAt) - Date.parse(entry.queuedAt)).toBe(60_000);
    expect(sent).toHaveLength(0);
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    expect(persisted.entries).toHaveLength(1);
    expect(persisted.entries[0]).toMatchObject({ id: entry.id, action: "send_text", status: "pending" });
  });

  it("sends exactly once after the window elapses", async () => {
    const { outbox, sent } = makeOutbox(file, clock);
    const entry = outbox.enqueue({ action: "send_text", payload: { jid: "j@s.whatsapp.net", body: "hi" }, context: "agent" });
    await clock.advance(59_000);
    expect(sent).toHaveLength(0);
    await clock.advance(2_000);
    expect(sent).toHaveLength(1);
    expect(outbox.get(entry.id)).toMatchObject({ status: "sent", result: { id: "wamid.1" } });
  });

  it("survives a double timer: a second fire for the same id is a no-op", async () => {
    const { outbox, sent } = makeOutbox(file, clock);
    const entry = outbox.enqueue({ action: "send_text", payload: { jid: "j@s.whatsapp.net", body: "hi" }, context: "agent" });
    await clock.advance(61_000);
    await outbox.fire(entry.id);
    await outbox.fire(entry.id);
    expect(sent).toHaveLength(1);
  });

  it("a send that throws settles as failed, never as sent, and is not retried", async () => {
    const { outbox } = makeOutbox(file, clock, { fail: true });
    const entry = outbox.enqueue({ action: "send_text", payload: { jid: "j@s.whatsapp.net", body: "hi" }, context: "agent" });
    await clock.advance(61_000);
    expect(outbox.get(entry.id)).toMatchObject({ status: "failed", error: "wire refused it" });
    expect(clock.armed).toBe(0);
  });

  describe("cancel", () => {
    it("inside the window prevents the send", async () => {
      const { outbox, sent } = makeOutbox(file, clock);
      const entry = outbox.enqueue({ action: "send_text", payload: { jid: "j@s.whatsapp.net", body: "hi" }, context: "agent" });
      const outcome = outbox.cancel(entry.id);
      expect(outcome).toMatchObject({ ok: true, status: "cancelled" });
      expect(clock.armed).toBe(0);
      await clock.advance(120_000);
      expect(sent).toHaveLength(0);
      expect(outbox.get(entry.id)!.status).toBe("cancelled");
    });

    it("is idempotent", () => {
      const { outbox } = makeOutbox(file, clock);
      const entry = outbox.enqueue({ action: "send_text", payload: { jid: "j@s.whatsapp.net", body: "hi" }, context: "agent" });
      expect(outbox.cancel(entry.id).ok).toBe(true);
      expect(outbox.cancel(entry.id)).toMatchObject({ ok: true, status: "cancelled" });
    });

    it("after the window answers already-sent instead of pretending", async () => {
      const { outbox, sent } = makeOutbox(file, clock);
      const entry = outbox.enqueue({ action: "send_text", payload: { jid: "j@s.whatsapp.net", body: "hi" }, context: "agent" });
      await clock.advance(61_000);
      expect(sent).toHaveLength(1);
      expect(outbox.cancel(entry.id)).toMatchObject({ ok: false, status: "sent", error: "already sent" });
    });

    it("an unknown id is reported, not silently accepted", () => {
      const { outbox } = makeOutbox(file, clock);
      expect(outbox.cancel("ob_nope")).toMatchObject({ ok: false, status: "unknown" });
    });
  });

  describe("context preservation across the deferral", () => {
    it("keeps the queue-time context on the record", () => {
      const { outbox } = makeOutbox(file, clock);
      const entry = outbox.enqueue({ action: "send_text", payload: { jid: "j@s.whatsapp.net", body: "hi" }, context: "automation" });
      expect(JSON.parse(readFileSync(file, "utf8")).entries[0].context).toBe("automation");
      expect(outbox.get(entry.id)!.context).toBe("automation");
    });

    it("re-applies the automation refusal AT SEND TIME, from the recorded context", async () => {
      // The draining daemon does not carry GARRISON_AUTOMATION_ENGINE, so a
      // gate that re-read the env here would silently clear itself. It must
      // read the context stored with the entry.
      const { outbox, sent } = makeOutbox(file, clock, {
        gate: (ctx) => {
          if (ctx === "automation") throw new Error("refused at send time: queued by the Automations engine");
        }
      });
      const entry = outbox.enqueue({ action: "send_text", payload: { jid: "j@s.whatsapp.net", body: "hi" }, context: "automation" });
      await clock.advance(61_000);
      expect(sent).toHaveLength(0);
      expect(outbox.get(entry.id)).toMatchObject({ status: "failed", error: expect.stringContaining("Automations engine") });
    });
  });

  describe("batching by destination", () => {
    const toChannel = (entry: any) => String(entry.payload.channel);

    it("delivers everything due for one destination as a single send", async () => {
      // Slack rate-limits near one message per second per channel, so three
      // windows elapsing together must not become three posts.
      const { outbox, sent, batches } = makeOutbox(file, clock, { groupKey: toChannel });
      const a = outbox.enqueue({ action: "send_message", payload: { channel: "C1", text: "one" }, context: "agent" });
      const b = outbox.enqueue({ action: "send_message", payload: { channel: "C1", text: "two" }, context: "agent" });
      await clock.advance(61_000);
      expect(sent).toHaveLength(1);
      expect(batches[0].map((e: any) => e.payload.text)).toEqual(["one", "two"]);
      expect(outbox.get(a.id)!.status).toBe("sent");
      expect(outbox.get(b.id)!.status).toBe("sent");
    });

    it("never batches a different destination", async () => {
      const { outbox, sent, batches } = makeOutbox(file, clock, { groupKey: toChannel });
      outbox.enqueue({ action: "send_message", payload: { channel: "C1", text: "one" }, context: "agent" });
      outbox.enqueue({ action: "send_message", payload: { channel: "C2", text: "two" }, context: "agent" });
      await clock.advance(61_000);
      expect(sent).toHaveLength(2);
      expect(batches.map((b) => b.length)).toEqual([1, 1]);
    });

    it("never pulls in an entry whose own window has not elapsed", async () => {
      // Batching an early entry would spend a cancel window its sender still has.
      const { outbox, sent, batches } = makeOutbox(file, clock, { groupKey: toChannel });
      outbox.enqueue({ action: "send_message", payload: { channel: "C1", text: "first" }, context: "agent" });
      await clock.advance(30_000);
      const later = outbox.enqueue({ action: "send_message", payload: { channel: "C1", text: "later" }, context: "agent" });
      await clock.advance(31_000);
      expect(batches[0].map((e: any) => e.payload.text)).toEqual(["first"]);
      expect(outbox.get(later.id)!.status).toBe("pending");
      await clock.advance(30_000);
      expect(sent).toHaveLength(2);
    });

    it("leaves a cancelled sibling out of the batch", async () => {
      const { outbox, batches } = makeOutbox(file, clock, { groupKey: toChannel });
      outbox.enqueue({ action: "send_message", payload: { channel: "C1", text: "keep" }, context: "agent" });
      const dropped = outbox.enqueue({ action: "send_message", payload: { channel: "C1", text: "drop" }, context: "agent" });
      outbox.cancel(dropped.id);
      await clock.advance(61_000);
      expect(batches[0].map((e: any) => e.payload.text)).toEqual(["keep"]);
      expect(outbox.get(dropped.id)!.status).toBe("cancelled");
    });

    it("a batched send that fails fails every entry in it, and none are retried", async () => {
      const { outbox } = makeOutbox(file, clock, { groupKey: toChannel, fail: true });
      const a = outbox.enqueue({ action: "send_message", payload: { channel: "C1", text: "one" }, context: "agent" });
      const b = outbox.enqueue({ action: "send_message", payload: { channel: "C1", text: "two" }, context: "agent" });
      await clock.advance(61_000);
      expect(outbox.get(a.id)).toMatchObject({ status: "failed", error: "wire refused it" });
      expect(outbox.get(b.id)).toMatchObject({ status: "failed", error: "wire refused it" });
      expect(clock.armed).toBe(0);
    });
  });

  describe("rearm after a restart", () => {
    it("re-arms a still-pending entry and fires it at its original executeAt", async () => {
      const first = makeOutbox(file, clock);
      const entry = first.outbox.enqueue({ action: "send_text", payload: { jid: "j@s.whatsapp.net", body: "hi" }, context: "agent" });
      // The process dies: its timer goes with it.
      clock.clearTimer(1);
      await clock.advance(10_000);

      const second = makeOutbox(file, clock);
      expect(second.outbox.rearm().map((e: any) => e.id)).toEqual([entry.id]);
      await clock.advance(40_000);
      expect(second.sent).toHaveLength(0);
      await clock.advance(20_000);
      expect(second.sent).toHaveLength(1);
    });

    it("fires an overdue entry immediately rather than dropping it", async () => {
      const first = makeOutbox(file, clock);
      first.outbox.enqueue({ action: "send_text", payload: { jid: "j@s.whatsapp.net", body: "hi" }, context: "agent" });
      clock.clearTimer(1);
      await clock.advance(600_000);

      const second = makeOutbox(file, clock);
      second.outbox.rearm();
      await clock.advance(0);
      expect(second.sent).toHaveLength(1);
    });

    it("fails an entry a crash left mid-send instead of sending it twice", () => {
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          entries: [{ id: "ob_x", action: "send_text", payload: { jid: "j@s.whatsapp.net", body: "hi" }, context: "agent", status: "sending", queuedAt: new Date(clock.t).toISOString(), executeAt: new Date(clock.t).toISOString() }]
        })
      );
      const { outbox, sent } = makeOutbox(file, clock);
      expect(outbox.rearm()).toHaveLength(0);
      expect(outbox.get("ob_x")).toMatchObject({ status: "failed", error: "process exited mid-send; not retried" });
      expect(sent).toHaveLength(0);
    });

    it("a corrupt outbox file reads as empty rather than throwing", () => {
      writeFileSync(file, "{not json");
      const { outbox } = makeOutbox(file, clock);
      expect(outbox.pending()).toEqual([]);
      expect(outbox.rearm()).toEqual([]);
    });
  });
});

describe("resolveSendContext", () => {
  it("treats an unmarked caller as an agent, so the default is buffered", () => {
    expect(resolveSendContext({})).toBe("agent");
  });

  it("marks an Automations-engine child from the env var the engine sets", () => {
    expect(resolveSendContext({ GARRISON_AUTOMATION_ENGINE: "1" })).toBe("automation");
  });

  it("only an explicit human marker bypasses the buffer", () => {
    expect(resolveSendContext({ GARRISON_SEND_CONTEXT: "human" })).toBe("human");
    expect(resolveSendContext({ GARRISON_SEND_CONTEXT: "HUMAN" })).toBe("human");
    expect(resolveSendContext({ GARRISON_SEND_CONTEXT: "sort-of-human" })).toBe("agent");
  });

  it("an automation cannot present itself as a human", () => {
    // The engine's marker wins over the explicit one, so an inherited or
    // spoofed GARRISON_SEND_CONTEXT cannot buy an unattended run a direct send.
    expect(resolveSendContext({ GARRISON_SEND_CONTEXT: "human", GARRISON_AUTOMATION_ENGINE: "1" })).toBe("automation");
  });
});
