// meshSessions(): local rows (via an injected fetchImpl standing in for the
// Shells fitting's /index) merged with peer rows (written straight into a
// REAL state service), bound to local threads, sorted, and capped.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StateClient } from "@garrison/state-client";
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
  for (const node of ["self-node", "peer-node"]) {
    const previous = await harness.client.getConfig("shells.sessions", `node:${node}`);
    if (previous) await harness.client.putConfig("shells.sessions", `node:${node}`, { rows: [] }, { ifMatchRev: previous.rev });
  }
  _resetCachesForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
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

function nativeSnapshot(id: string, at: number) {
  const timestamp = new Date(at).toISOString();
  return { updatedAt: timestamp, rows: [{ id, runtime: "codex", kind: "cli", status: "working", statusSource: "hooks", lastActivityAt: timestamp }] };
}

async function publishSnapshot(node: string, body: unknown) {
  const previous = await harness.client.getConfig("shells.sessions", `node:${node}`);
  await harness.client.putConfig("shells.sessions", `node:${node}`, body, { ifMatchRev: previous?.rev ?? 0 });
}

describe("meshSessions", () => {
  it("uses the owner's published sessions when its cold local index exceeds the fetch deadline", async () => {
    await publishSnapshot("self-node", nativeSnapshot("slow-owner-session", Date.now()));
    const slowFetch = vi.fn((_url: string, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const result = await meshSessions({ fetchImpl: slowFetch });
    expect(result.rows).toEqual([expect.objectContaining({ id: "slow-owner-session", node: "self-node", status: "working", shellOrigin: null })]);
    expect(result.nodes.filter((node: { node: string }) => node.node === "self-node")).toHaveLength(1);
    expect(slowFetch).toHaveBeenCalledOnce();
  });

  it("retains local sessions after failed refreshes, expires original activity, and honors recovery and empty reads", async () => {
    const started = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(started);
    const initial = nativeSnapshot("local-retained", started);
    expect((await meshSessions({ fetchImpl: fakeFetchWithBody(initial) })).rows[0].status).toBe("working");

    clock.mockReturnValue(started + 95_000);
    const failedFetch = async () => { throw new Error("owner temporarily unavailable"); };
    const stale = await meshSessions({ fetchImpl: failedFetch });
    expect(stale.rows).toEqual([expect.objectContaining({ id: "local-retained", status: "unknown", statusSource: "stale-node", lastActivityAt: initial.rows[0].lastActivityAt })]);

    clock.mockReturnValue(started + 6 * 86_400_000);
    expect((await meshSessions({ fetchImpl: failedFetch })).rows).toEqual([]);

    clock.mockReturnValue(started + 6 * 86_400_000 + 5_001);
    const recovered = nativeSnapshot("local-retained", Date.now());
    expect((await meshSessions({ fetchImpl: fakeFetchWithBody(recovered) })).rows[0]).toMatchObject({ status: "working", statusSource: "hooks" });
    await publishSnapshot("self-node", recovered);
    clock.mockReturnValue(Date.now() + 5_001);
    expect((await meshSessions({ fetchImpl: fakeFetchWithBody({ rows: [], updatedAt: new Date(Date.now()).toISOString() }) })).rows).toEqual([]);
  });

  it("retains peer snapshots and the owner registry during authority failures, then replaces them on recovery", async () => {
    const started = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(started);
    const initial = nativeSnapshot("peer-retained", started);
    await publishSnapshot("peer-node", initial);
    const localFetch = fakeFetchWithBody({ rows: [] });
    expect((await meshSessions({ fetchImpl: localFetch })).rows[0].status).toBe("working");

    clock.mockReturnValue(started + 95_000);
    const configFailure = vi.spyOn(StateClient.prototype, "getConfig").mockRejectedValue(new Error("temporary config failure"));
    const stale = await meshSessions({ fetchImpl: localFetch });
    expect(stale.rows).toEqual([expect.objectContaining({ id: "peer-retained", status: "unknown", statusSource: "stale-node", lastActivityAt: initial.rows[0].lastActivityAt })]);

    clock.mockReturnValue(started + 190_000);
    const registryFailure = vi.spyOn(StateClient.prototype, "listNodes").mockRejectedValue(new Error("temporary registry failure"));
    expect((await meshSessions({ fetchImpl: localFetch })).rows[0]).toMatchObject({ id: "peer-retained", node: "peer-node", status: "unknown" });

    clock.mockReturnValue(started + 6 * 86_400_000);
    expect((await meshSessions({ fetchImpl: localFetch })).rows).toEqual([]);
    configFailure.mockRestore();
    registryFailure.mockRestore();
    await publishSnapshot("peer-node", nativeSnapshot("peer-retained", Date.now()));
    clock.mockReturnValue(Date.now() + 5_001);
    expect((await meshSessions({ fetchImpl: localFetch })).rows[0]).toMatchObject({ id: "peer-retained", status: "working", statusSource: "hooks" });
    await publishSnapshot("peer-node", { rows: [], updatedAt: new Date(Date.now()).toISOString() });
    clock.mockReturnValue(Date.now() + 5_001);
    expect((await meshSessions({ fetchImpl: localFetch })).rows).toEqual([]);
  });

  it("merges local (injected fetch) and peer (real state service) rows, node accents included", async () => {
    const previousPeer = await harness.client.getConfig("shells.sessions", "node:peer-node");
    await harness.client.putConfig("shells.sessions", "node:peer-node", {
      node: "peer-node",
      shellOrigin: { loopback: "http://127.0.0.1:8098", public: "https://peer.tail.example:8498" },
      updatedAt: NOW,
      rows: [{ id: "peer-1", runtime: "cursor", kind: "cli", cwd: "/tmp/peer", project: "peer", title: null, status: "working", statusSource: "hooks", startedAt: NOW, lastActivityAt: NOW, resumable: true, attachable: false, resumeRef: "chat_1", resumeCommand: null, transcript: null }]
    }, { ifMatchRev: previousPeer?.rev ?? 0 });

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

  it("binds a local shell wrapper to the exact peer shell so its thread keeps the peer spinner", async () => {
    await ensureThread({ id: "peer-shell-wrapper", source: "shell", context: { shell: { node: "peer-node", transport: "local", tmuxSession: "peer-shell" } } });
    const current = await harness.client.getConfig("shells.sessions", "node:peer-node");
    await harness.client.putConfig("shells.sessions", "node:peer-node", { updatedAt: new Date().toISOString(), rows: [
      { id: "shell:local:peer-shell", kind: "shell", runtime: "codex", status: "working", lastActivityAt: new Date().toISOString(), shell: { transport: "local", tmuxSession: "peer-shell", sessionId: "remote-id" } }
    ] }, { ifMatchRev: current?.rev ?? 0 });
    const result = await meshSessions({ fetchImpl: fakeFetchWithBody({ rows: [] }) });
    expect(result.rows.find((r: { id: string }) => r.id === "shell:local:peer-shell")).toMatchObject({ threadId: "peer-shell-wrapper", status: "working", node: "peer-node" });
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
    const uncapped = await meshSessions({ fetchImpl: fakeFetchWithBody(localBody) });
    expect(uncapped.rows.filter((r: { status: string }) => r.status === "ended")).toHaveLength(25);
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
