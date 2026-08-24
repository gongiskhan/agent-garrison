import { afterEach, beforeEach, describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDispatchStreamEvent } from "@/lib/dispatch-stream";
import type { CardDispatch } from "@/lib/dispatch";

// The card store is the STATE SERVICE now, not files under GARRISON_KANBAN_DIR.
// Boot one for this file and project its discovery env before anything reads a
// card; side files still live under the kanban root this file already pins.
import { setupKanbanState } from "./kanban-state-env";
let __kanbanState: Awaited<ReturnType<typeof setupKanbanState>>;
beforeAll(async () => {
  __kanbanState = await setupKanbanState();
}, 30_000);
afterAll(async () => {
  await __kanbanState?.stop();
});


let root: string;
let prior: string | undefined;
const dispatch: CardDispatch = {
  machine: "studio",
  workerId: "w1",
  runId: "run-one",
  phase: "implement",
  logIndex: 2,
  claimedAt: "2026-08-05T00:00:00Z",
  heartbeatAt: "2026-08-05T00:00:00Z",
  state: "running"
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dispatch-stream-"));
  prior = process.env.GARRISON_KANBAN_DIR;
  process.env.GARRISON_KANBAN_DIR = root;
});
afterEach(() => {
  if (prior === undefined) delete process.env.GARRISON_KANBAN_DIR;
  else process.env.GARRISON_KANBAN_DIR = prior;
  rmSync(root, { recursive: true, force: true });
});

describe("remote Watch stream", () => {
  it("orders events and deduplicates a retry", async () => {
    await appendDispatchStreamEvent("CARD", dispatch, { eventId: 2, channel: "stderr", text: "warn" });
    await appendDispatchStreamEvent("CARD", dispatch, { eventId: 1, channel: "stdout", text: "hello " });
    const retry = await appendDispatchStreamEvent("CARD", dispatch, { eventId: 1, channel: "stdout", text: "DUPLICATE" });
    expect(retry.duplicate).toBe(true);
    const log = readFileSync(join(root, "cards", "CARD", "log-2.md"), "utf8");
    expect(log).toContain("hello ");
    expect(log).toContain("[stderr] warn");
    expect(log).not.toContain("DUPLICATE");
    expect(log.indexOf("hello")).toBeLessThan(log.indexOf("warn"));
  });

  it("retains structured screenshot activity without base64-expanding the raw log", async () => {
    const journal = JSON.stringify({
      role: "user",
      blocks: [{ type: "tool_result", toolUseId: "vision", images: [{ mediaType: "image/png", data: "aGVsbG8=" }] }]
    });
    await appendDispatchStreamEvent("CARD", dispatch, { eventId: 1, channel: "journal", text: journal });
    const log = readFileSync(join(root, "cards", "CARD", "log-2.md"), "utf8");
    expect(log).toBe("# mesh dispatch\n");
    expect(log).not.toContain("aGVsbG8=");
  });
});
