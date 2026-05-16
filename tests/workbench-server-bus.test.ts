import { describe, expect, it, beforeEach } from "vitest";
import { workbenchServerBus } from "@/lib/workbench-server-bus";

describe("Phase 9E — workbench-server-bus", () => {
  beforeEach(() => {
    // global singleton; reset by replacing
    (globalThis as { __garrisonWorkbenchServerBus?: unknown }).__garrisonWorkbenchServerBus = undefined;
  });

  it("emitLaunch returns a terminalTabId and notifies subscribers", async () => {
    const bus = workbenchServerBus();
    const received: any[] = [];
    bus.subscribe((e) => received.push(e));

    const tabId = bus.emitLaunch({
      sessionId: "abc",
      soul: "engineer",
      cwd: "/tmp",
      args: ["--print", "--session-id", "abc"]
    });

    expect(tabId).toMatch(/^[0-9a-f-]{36}$/);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      kind: "soul-tab-launch",
      sessionId: "abc",
      soul: "engineer",
      terminalTabId: tabId
    });
  });

  it("emitRespawn notifies subscribers without generating a new id", async () => {
    const bus = workbenchServerBus();
    const received: any[] = [];
    bus.subscribe((e) => received.push(e));

    bus.emitRespawn({
      sessionId: "abc",
      terminalTabId: "tab-123",
      args: ["--print", "--resume", "abc", "--model", "claude-opus-4-7"]
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      kind: "soul-tab-respawn",
      sessionId: "abc",
      terminalTabId: "tab-123"
    });
  });

  it("replays recent events to subscribers connecting after publish", async () => {
    const bus = workbenchServerBus();
    bus.emitLaunch({
      sessionId: "earlier",
      soul: "engineer",
      cwd: "/tmp",
      args: ["--print"]
    });

    const received: any[] = [];
    bus.subscribe((e) => received.push(e));

    expect(received).toHaveLength(1);
    expect(received[0].sessionId).toBe("earlier");
  });
});
