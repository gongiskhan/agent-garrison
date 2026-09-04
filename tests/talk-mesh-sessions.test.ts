// meshSessions(): local rows (via an injected fetchImpl standing in for the
// Shells fitting's /index) merged with peer rows (written straight into a
// REAL state service), bound to local threads, sorted, and capped.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startStateService, type StateHarness } from "./state-service-harness";
// @ts-ignore — pure .mjs
import { meshSessions, _resetCachesForTests } from "../packages/talk/src/mesh-sessions.mjs";
// @ts-ignore — pure .mjs
import { ensureThread, setThreadSession } from "../packages/talk/src/threads.mjs";

let harness: StateHarness & { tokens: Record<string, string> };
let sandbox: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  harness = await startStateService({ nodes: ["self-node", "peer-node"] });
});

afterAll(async () => {
  await harness.stop();
});

beforeEach(async () => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), "talk-mesh-sessions-"));
  for (const k of ["GARRISON_HOME", "GARRISON_STATE_URL", "GARRISON_STATE_TOKEN", "GARRISON_NODE_NAME"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.GARRISON_HOME = sandbox;
  process.env.GARRISON_STATE_URL = harness.url;
  process.env.GARRISON_STATE_TOKEN = harness.tokens["self-node"];
  process.env.GARRISON_NODE_NAME = "self-node";
  mkdirSync(path.join(sandbox, "web-channel", "threads"), { recursive: true });
  writeFileSync(path.join(sandbox, "node.json"), JSON.stringify({ accent: "moss" }));
  mkdirSync(path.join(sandbox, "ui-fittings"), { recursive: true });
  writeFileSync(path.join(sandbox, "ui-fittings", "remote-shell-runtime.json"), JSON.stringify({ url: "http://127.0.0.1:1" }));
  _resetCachesForTests();
});

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

const NOW = new Date().toISOString();

function fakeFetchWithBody(body: unknown) {
  return async () => ({ ok: true, json: async () => body });
}

describe("meshSessions", () => {
  it("merges local (injected fetch) and peer (real state service) rows, node accents included", async () => {
    await harness.client.putConfig("shells.sessions", "node:peer-node", {
      node: "peer-node",
      shellOrigin: { loopback: "http://127.0.0.1:8098", public: "https://peer.tail.example:8498" },
      updatedAt: NOW,
      rows: [{ id: "peer-1", runtime: "cursor", kind: "cli", cwd: "/tmp/peer", project: "peer", title: null, status: "working", statusSource: "hooks", startedAt: NOW, lastActivityAt: NOW, resumable: true, attachable: false, resumeRef: "chat_1", resumeCommand: null, transcript: null }]
    }, { ifMatchRev: 0 });

    const localBody = {
      node: "self-node",
      shellOrigin: { loopback: "http://127.0.0.1:8098", public: null },
      updatedAt: NOW,
      rows: [{ id: "local-1", runtime: "codex", kind: "cli", cwd: "/tmp/local", project: "local", title: null, status: "idle", statusSource: "transcript", startedAt: NOW, lastActivityAt: NOW, resumable: true, attachable: false, resumeRef: "019f", resumeCommand: null, transcript: null }]
    };

    const result = await meshSessions({ fetchImpl: fakeFetchWithBody(localBody) });
    expect(result.self.node).toBe("self-node");
    expect(result.nodes.map((n: { node: string }) => n.node).sort()).toEqual(["peer-node", "self-node"]);
    const peerNodeRow = result.nodes.find((n: { node: string }) => n.node === "peer-node");
    expect(peerNodeRow.shellOrigin).toBe("https://peer.tail.example:8498");

    const local = result.rows.find((r: { id: string }) => r.id === "local-1");
    const peer = result.rows.find((r: { id: string }) => r.id === "peer-1");
    expect(local.node).toBe("self-node");
    expect(local.nodeAccent).toBe("#4a7d5f"); // moss
    expect(peer.node).toBe("peer-node");
    expect(peer.shellOrigin).toBe("https://peer.tail.example:8498");
  });

  it("binds a local shell row to its owning thread, and a claude row to a conversation", async () => {
    const t1 = await ensureThread({ id: "t1", source: "shell", context: { shell: { node: "self-node", transport: "local", tmuxSession: "s1" } } });
    expect(t1).toBeTruthy();
    const t2 = await ensureThread({ id: "t2", source: "chat" });
    await setThreadSession("t2", "claude-sess-1");

    const localBody = {
      node: "self-node",
      shellOrigin: { loopback: "http://127.0.0.1:8098", public: null },
      updatedAt: NOW,
      rows: [
        { id: "shell:local:s1", runtime: "shell", kind: "shell", cwd: "/tmp", project: null, title: "s1", status: "idle", statusSource: "hooks", startedAt: NOW, lastActivityAt: NOW, resumable: false, attachable: false, resumeRef: null, resumeCommand: null, shell: { transport: "local", tmuxSession: "s1", label: "s1", sessionId: "sess-1" }, transcript: null },
        { id: "claude-sess-1", runtime: "claude", kind: "cli", cwd: "/tmp", project: null, title: null, status: "working", statusSource: "registry", startedAt: NOW, lastActivityAt: NOW, resumable: true, attachable: false, resumeRef: "claude-sess-1", resumeCommand: null, transcript: null }
      ]
    };
    const result = await meshSessions({ fetchImpl: fakeFetchWithBody(localBody) });
    const shellRow = result.rows.find((r: { id: string }) => r.id === "shell:local:s1");
    expect(shellRow.threadId).toBe("t1");
    const claudeRow = result.rows.find((r: { id: string }) => r.id === "claude-sess-1");
    expect(claudeRow.boundTo).toEqual({ kind: "conversation", threadId: "t2" });
  });

  it("sorts working > idle > unknown > ended, and caps ended rows per node", async () => {
    const rows = [];
    for (let i = 0; i < 25; i++) {
      rows.push({ id: `ended-${i}`, runtime: "codex", kind: "cli", cwd: "/tmp", project: null, title: null, status: "ended", statusSource: "registry", startedAt: NOW, lastActivityAt: new Date(Date.now() - i * 1000).toISOString(), resumable: true, attachable: false, resumeRef: "x", resumeCommand: null, transcript: null });
    }
    rows.push({ id: "working-1", runtime: "codex", kind: "cli", cwd: "/tmp", project: null, title: null, status: "working", statusSource: "hooks", startedAt: NOW, lastActivityAt: NOW, resumable: true, attachable: false, resumeRef: "x", resumeCommand: null, transcript: null });
    const localBody = { node: "self-node", shellOrigin: { loopback: "x", public: null }, updatedAt: NOW, rows };
    const result = await meshSessions({ fetchImpl: fakeFetchWithBody(localBody), limitEndedPerNode: 5 });
    expect(result.rows[0].id).toBe("working-1");
    expect(result.rows.filter((r: { status: string }) => r.status === "ended")).toHaveLength(5);
  });

  it("a state-service outage still returns local rows, never throws", async () => {
    const prevUrl = process.env.GARRISON_STATE_URL;
    process.env.GARRISON_STATE_URL = "http://127.0.0.1:1";
    _resetCachesForTests();
    const localBody = { node: "self-node", shellOrigin: { loopback: "x", public: null }, updatedAt: NOW, rows: [{ id: "local-only", runtime: "codex", kind: "cli", cwd: "/tmp", project: null, title: null, status: "working", statusSource: "hooks", startedAt: NOW, lastActivityAt: NOW, resumable: true, attachable: false, resumeRef: "x", resumeCommand: null, transcript: null }] };
    const result = await meshSessions({ fetchImpl: fakeFetchWithBody(localBody) });
    expect(result.rows.map((r: { id: string }) => r.id)).toEqual(["local-only"]);
    process.env.GARRISON_STATE_URL = prevUrl;
  });
});
