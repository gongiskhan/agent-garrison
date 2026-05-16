import { describe, expect, it, beforeEach } from "vitest";
import { NextRequest } from "next/server";

beforeEach(() => {
  // Reset the global server bus between tests.
  (globalThis as { __garrisonWorkbenchServerBus?: unknown }).__garrisonWorkbenchServerBus = undefined;
});

function post(url: string, body: object): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("Phase 9I L2 — /api/workbench/spawn-soul-tab + /respawn-soul-tab", () => {
  it("spawn-soul-tab POST writes to bus and returns a terminalTabId", async () => {
    const { POST } = await import("@/app/api/workbench/spawn-soul-tab/route");
    const { workbenchServerBus } = await import("@/lib/workbench-server-bus");
    const received: any[] = [];
    workbenchServerBus().subscribe((e) => received.push(e));

    const res = await POST(
      post("http://localhost/api/workbench/spawn-soul-tab", {
        session_id: "abc-123",
        soul: "engineer",
        cwd: "/tmp/repo",
        args: ["--print", "--session-id", "abc-123"],
        message: "fix the regex",
        worktree_id: "wt-1",
        mcp_config_path: "/tmp/.mcp.json"
      })
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { terminal_tab_id: string };
    expect(data.terminal_tab_id).toMatch(/^[0-9a-f-]{36}$/i);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      kind: "soul-tab-launch",
      sessionId: "abc-123",
      soul: "engineer",
      cwd: "/tmp/repo",
      worktreeId: "wt-1",
      mcpConfigPath: "/tmp/.mcp.json"
    });
    expect(received[0].terminalTabId).toBe(data.terminal_tab_id);
  });

  it("spawn-soul-tab POST returns 400 when required fields are missing", async () => {
    const { POST } = await import("@/app/api/workbench/spawn-soul-tab/route");
    const res = await POST(post("http://localhost/api/workbench/spawn-soul-tab", { soul: "engineer" }));
    expect(res.status).toBe(400);
  });

  it("respawn-soul-tab POST emits a respawn event with the new args", async () => {
    const { POST } = await import("@/app/api/workbench/respawn-soul-tab/route");
    const { workbenchServerBus } = await import("@/lib/workbench-server-bus");
    const received: any[] = [];
    workbenchServerBus().subscribe((e) => received.push(e));

    const res = await POST(
      post("http://localhost/api/workbench/respawn-soul-tab", {
        session_id: "abc-123",
        terminal_tab_id: "tab-xyz",
        args: ["--print", "--resume", "abc-123", "--model", "claude-opus-4-7"],
        message: "respawned"
      })
    );
    expect(res.status).toBe(200);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      kind: "soul-tab-respawn",
      sessionId: "abc-123",
      terminalTabId: "tab-xyz",
      message: "respawned"
    });
    expect(received[0].args).toContain("--model");
    expect(received[0].args).toContain("claude-opus-4-7");
  });

  it("launch-stream GET serves text/event-stream and replays recent events", async () => {
    const { workbenchServerBus } = await import("@/lib/workbench-server-bus");
    workbenchServerBus().emitLaunch({
      sessionId: "earlier",
      soul: "engineer",
      cwd: "/tmp/x",
      args: ["--print"]
    });

    const { GET } = await import("@/app/api/workbench/launch-stream/route");
    const res = await GET(new NextRequest("http://localhost/api/workbench/launch-stream"));
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let deadline = Date.now() + 1500;
    let seenEarlier = false;
    while (Date.now() < deadline && !seenEarlier) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes("earlier")) seenEarlier = true;
    }
    await reader.cancel().catch(() => null);
    expect(seenEarlier).toBe(true);
  }, 5000);
});
