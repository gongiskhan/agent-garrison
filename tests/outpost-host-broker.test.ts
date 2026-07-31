import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUTPOST_HOST_SCRIPT = join(import.meta.dirname, "../scripts/outpost-host.mjs");

let outpostHost: ChildProcess;
let hostPort: number;
// The daemon resolves its registry from GARRISON_HOME. Spawning it with a bare
// {...process.env} let this test write `test-machine` / `test-token-abc` — a
// VALID pairing token that authenticates a bridge and relays exec.run to a Mac —
// straight into the developer's real ~/.garrison/outpost-registry.json. Every
// run of the suite re-registered it. Sandbox the home per test.
let sandboxHome: string;

async function waitForPort(port: number, maxMs = 5000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`outpost-host on ${port} never came up`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const { createServer } = require("node:net");
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

beforeEach(async () => {
  hostPort = await freePort();
  sandboxHome = mkdtempSync(join(tmpdir(), "garrison-outpost-test-"));
  outpostHost = spawnProcess("node", [OUTPOST_HOST_SCRIPT], {
    env: {
      ...process.env,
      GARRISON_HOME: sandboxHome,
      GARRISON_OUTPOST_PORT: String(hostPort),
      GARRISON_OUTPOST_BIND: "127.0.0.1",
    },
    stdio: "ignore",
  });
  await waitForPort(hostPort);

  // Register a fake outpost token so auth works
  await fetch(`http://127.0.0.1:${hostPort}/registry/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "test-machine", token: "test-token-abc" }),
  });
});

afterEach(() => {
  outpostHost.kill("SIGTERM");
  if (sandboxHome) rmSync(sandboxHome, { recursive: true, force: true });
});

function connectBridge(token = "test-token-abc", machineName = "test-machine"): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${hostPort}/bridge`);
    ws.once("open", () => {
      ws.send(JSON.stringify({ version: 1, type: "auth", payload: { token, machine_name: machineName } }));
    });
    ws.once("message", (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as { type: string };
      if (frame.type === "auth_ok") resolve(ws);
      else reject(new Error(`auth failed: ${JSON.stringify(frame)}`));
    });
    ws.once("error", reject);
  });
}

function connectSubscriber(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${hostPort}/outposts/test-machine/io`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data: Buffer) => {
      try { resolve(JSON.parse(data.toString())); } catch { resolve(data); }
    });
    ws.once("error", reject);
  });
}

it("spawn_ok is returned to subscriber after bridge acks process.spawn", async () => {
  const bridge = await connectBridge();
  const sub = await connectSubscriber();

  // Subscriber sends spawn request
  sub.send(JSON.stringify({ type: "spawn", command: "/bin/echo", cols: 80, rows: 24 }));

  // Bridge receives the RPC
  const bridgeMsg = (await nextMessage(bridge)) as { type: string; id: string; payload: unknown };
  expect(bridgeMsg.type).toBe("process.spawn");
  expect((bridgeMsg.payload as { pty: boolean }).pty).toBe(true);

  // Bridge replies with spawn.ok (actual bridge format)
  bridge.send(JSON.stringify({ version: 1, type: "process.spawn.ok", id: bridgeMsg.id, payload: { handle: "h-test-1" } }));

  const subReply = (await nextMessage(sub)) as { type: string; handle: string };
  expect(subReply.type).toBe("spawn_ok");
  expect(subReply.handle).toBe("h-test-1");

  bridge.close();
  sub.close();
});

it("process.output from bridge is forwarded to subscriber", async () => {
  const bridge = await connectBridge();
  const sub = await connectSubscriber();

  sub.send(JSON.stringify({ type: "spawn", command: "/bin/zsh", cols: 80, rows: 24 }));

  const rpc = (await nextMessage(bridge)) as { type: string; id: string };
  bridge.send(JSON.stringify({ version: 1, type: "process.spawn.ok", id: rpc.id, payload: { handle: "h-out-1" } }));
  await nextMessage(sub); // spawn_ok

  // Bridge sends output event
  const b64 = Buffer.from("hello world\r\n", "utf8").toString("base64");
  bridge.send(JSON.stringify({ version: 1, type: "process.output", payload: { handle: "h-out-1", stream: "stdout", data: b64 } }));

  const output = (await nextMessage(sub)) as { type: string; payload: { data: string } };
  expect(output.type).toBe("process.output");
  expect(output.payload.data).toBe(b64);

  bridge.close();
  sub.close();
});

it("bridge_disconnected is sent to subscriber on bridge ws.close", async () => {
  const bridge = await connectBridge();
  const sub = await connectSubscriber();

  sub.send(JSON.stringify({ type: "spawn", command: "/bin/zsh", cols: 80, rows: 24 }));

  const rpc = (await nextMessage(bridge)) as { type: string; id: string };
  bridge.send(JSON.stringify({ version: 1, type: "process.spawn.ok", id: rpc.id, payload: { handle: "h-disc-1" } }));
  await nextMessage(sub); // spawn_ok

  // Close bridge
  bridge.close(1001, "test teardown");

  const notification = (await nextMessage(sub)) as { type: string };
  expect(notification.type).toBe("bridge_disconnected");

  sub.close();
});

it("spawn_error is returned when outpost is not connected", async () => {
  // No bridge connected — connect subscriber to non-existent outpost name
  const sub = new WebSocket(`ws://127.0.0.1:${hostPort}/outposts/no-such-machine/io`);
  await new Promise<void>((r) => sub.once("open", r));

  sub.send(JSON.stringify({ type: "spawn", command: "/bin/zsh", cols: 80, rows: 24 }));

  const reply = (await nextMessage(sub)) as { type: string; code: string };
  expect(reply.type).toBe("spawn_error");
  expect(reply.code).toBe("not_connected");

  sub.close();
});

it("binary frame from subscriber is forwarded as process.send_input RPC to bridge", async () => {
  const bridge = await connectBridge();
  const sub = await connectSubscriber();

  sub.send(JSON.stringify({ type: "spawn", command: "/bin/zsh", cols: 80, rows: 24 }));
  const spawnRpc = (await nextMessage(bridge)) as { type: string; id: string };
  bridge.send(JSON.stringify({ version: 1, type: "process.spawn.ok", id: spawnRpc.id, payload: { handle: "h-in-1" } }));
  await nextMessage(sub); // spawn_ok

  // Send binary stdin from subscriber
  sub.send(Buffer.from("ls\r", "utf8"));

  const inputRpc = (await nextMessage(bridge)) as { type: string; payload: { handle: string; data: string } };
  expect(inputRpc.type).toBe("process.send_input");
  expect(inputRpc.payload.handle).toBe("h-in-1");
  // data should be base64 of "ls\r"
  expect(Buffer.from(inputRpc.payload.data, "base64").toString("utf8")).toBe("ls\r");

  bridge.close();
  sub.close();
});

// ---------------------------------------------------------------------------
// Registry shape robustness. The registry file is 0600 and hand-editable, and a
// SHAPE error is not a parse error: a bare `[...]` array parses fine, then every
// `reg.outposts.map/find` throws TypeError inside an async handler, which escapes
// createServer(handleHttp) as an unhandled rejection and kills the daemon. Live:
// ~/.garrison-dev/outpost-registry.json WAS a bare array, so one unauthenticated
// GET /outposts would have taken the whole dev instance down with it
// (concurrently --kill-others-on-fail also stops Next and the scheduler).
// ---------------------------------------------------------------------------
describe("outpost-host registry shape robustness", () => {
  async function startWithRegistry(body: string): Promise<{ port: number; proc: ChildProcess; home: string }> {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const port = await freePort();
    const home = mkdtempSync(join(tmpdir(), "garrison-outpost-shape-"));
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "outpost-registry.json"), body);
    const proc = spawnProcess("node", [OUTPOST_HOST_SCRIPT], {
      env: { ...process.env, GARRISON_HOME: home, GARRISON_OUTPOST_PORT: String(port), GARRISON_OUTPOST_BIND: "127.0.0.1" },
      stdio: "ignore",
    });
    await waitForPort(port);
    return { port, proc, home };
  }

  const CASES: Array<[string, string, string[]]> = [
    ["a bare array (the shape that crashed dev)", '[{"name":"a","token":"t"}]', ["a"]],
    ["the normal object", '{"outposts":[{"name":"b","token":"t"}]}', ["b"]],
    ["a non-object scalar", '"nope"', []],
    ["an object with no outposts key", '{"something":1}', []],
    ["null entries inside the list", '{"outposts":[null,{"name":"c","token":"t"}]}', ["c"]],
  ];

  for (const [label, body, expected] of CASES) {
    it(`serves /outposts and survives ${label}`, async () => {
      const { port, proc, home } = await startWithRegistry(body);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/outposts`);
        expect(res.status).toBe(200);
        const json = (await res.json()) as { outposts: Array<{ name: string }> };
        expect(json.outposts.map((o) => o.name)).toEqual(expected);

        // Still alive afterwards — the crash killed the PROCESS, so one request
        // succeeding is not enough; prove the daemon is still serving.
        const again = await fetch(`http://127.0.0.1:${port}/health`);
        expect(again.status).toBe(200);
      } finally {
        proc.kill("SIGTERM");
        rmSync(home, { recursive: true, force: true });
      }
    }, 20000);
  }
});
