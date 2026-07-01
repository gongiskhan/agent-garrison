import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The threads store resolves its dir from GARRISON_HOME at module load, so point
// it at a temp home BEFORE importing.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wc-threads-"));
const MOD = pathToFileURL(
  path.resolve(__dirname, "../fittings/seed/web-channel-default/scripts/threads.mjs")
).href;

let threads: typeof import("../fittings/seed/web-channel-default/scripts/threads.mjs");

beforeAll(async () => {
  process.env.GARRISON_HOME = TMP_HOME;
  threads = await import(MOD);
});

afterAll(() => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
});

describe("web-channel threads store", () => {
  it("safeThreadId sanitises unsafe keys and keeps safe ones stable", () => {
    expect(threads.safeThreadId("kanban-01ABC")).toBe("kanban-01ABC");
    // Distinct originals that sanitise to the same stem stay distinct via a hash.
    const a = threads.safeThreadId("kanban:01ABC");
    const b = threads.safeThreadId("kanban-01ABC");
    expect(a).not.toBe(b);
    expect(threads.safeThreadId("")).toBeNull();
  });

  it("ensureThread is idempotent on the same opaque key", async () => {
    const t1 = await threads.ensureThread({ id: "kanban-card1", title: "Tagline change", source: "kanban" });
    const t2 = await threads.ensureThread({ id: "kanban-card1" });
    expect(t2.id).toBe(t1.id);
    expect(t2.title).toBe("Tagline change");
    expect(t2.source).toBe("kanban");
    expect(t2.messages).toEqual([]);
  });

  it("appendMessages persists exchanges, bumps count, derives an untitled title", async () => {
    const id = "chat-derive";
    await threads.appendMessages(id, [
      { role: "user", text: "# How do I deploy ekoa?\nmore detail" },
      { role: "assistant", text: "Merge to main triggers prod." },
    ]);
    const t = await threads.getThread(id);
    expect(t?.messages).toHaveLength(2);
    expect(t?.messages[0]).toMatchObject({ role: "user" });
    expect(t?.messages[1]).toMatchObject({ role: "assistant", text: "Merge to main triggers prod." });
    // Title derived from the first non-empty user line, stripped of markdown hash.
    expect(t?.title).toBe("How do I deploy ekoa?");

    // Appending again accumulates.
    await threads.appendMessages(id, [
      { role: "user", text: "thanks" },
      { role: "assistant", text: "anytime" },
    ]);
    const t2 = await threads.getThread(id);
    expect(t2?.messages).toHaveLength(4);
  });

  it("listThreads returns metas sorted by most-recent activity, deleteThread removes", async () => {
    const list = await threads.listThreads();
    const ids = list.map((m) => m.id);
    expect(ids).toContain("kanban-card1");
    expect(ids).toContain("chat-derive");
    // chat-derive was written most recently → first.
    expect(list[0].id).toBe("chat-derive");
    expect(list.find((m) => m.id === "chat-derive")?.messageCount).toBe(4);

    expect(await threads.deleteThread("kanban-card1")).toBe(true);
    expect(await threads.getThread("kanban-card1")).toBeNull();
    expect(await threads.deleteThread("does-not-exist")).toBe(false);
  });

  it("rejects bad ids and ignores malformed messages", async () => {
    await expect(threads.appendMessages("", [{ role: "user", text: "x" }])).rejects.toThrow();
    const meta = await threads.appendMessages("chat-filter", [
      { role: "user", text: "keep" },
      { role: "system", text: "drop" } as any,
      { role: "assistant", text: 42 } as any,
    ]);
    expect(meta.messageCount).toBe(1);
  });
});
