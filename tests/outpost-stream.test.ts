import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { openOutpostPty } from "../src/lib/trenches/outpost-stream";

let httpServer: Server;
let wss: WebSocketServer;
let port: number;

beforeEach(
  () =>
    new Promise<void>((resolve) => {
      httpServer = createServer();
      wss = new WebSocketServer({ server: httpServer });
      httpServer.listen(0, "127.0.0.1", () => {
        const addr = httpServer.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    })
);

afterEach(
  () =>
    new Promise<void>((resolve) => {
      wss.clients.forEach((c) => c.terminate());
      wss.close(() => httpServer.close(() => resolve()));
    })
);

function makeShim(opts: Partial<{ name: string; cols: number; rows: number }> = {}) {
  return openOutpostPty({
    outpostHostUrl: `ws://127.0.0.1:${port}`,
    outpostName: opts.name ?? "test-outpost",
    command: "/bin/zsh",
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
  });
}

it("resolves ready with handle on spawn_ok", async () => {
  wss.once("connection", (ws) => {
    ws.once("message", () => {
      ws.send(JSON.stringify({ type: "spawn_ok", handle: "h-abc123" }));
    });
  });

  const shim = makeShim();
  const { handle } = await shim.ready;
  expect(handle).toBe("h-abc123");
});

it("rejects ready on spawn_error with code:message", async () => {
  wss.once("connection", (ws) => {
    ws.once("message", () => {
      ws.send(JSON.stringify({ type: "spawn_error", code: "not_connected", message: "outpost offline" }));
    });
  });

  const shim = makeShim();
  await expect(shim.ready).rejects.toThrow("not_connected: outpost offline");
});

it("rejects ready when socket closes before spawn_ok", async () => {
  wss.once("connection", (ws) => {
    ws.once("message", () => ws.close());
  });

  const shim = makeShim();
  await expect(shim.ready).rejects.toThrow();
});

it("write sends binary frame to broker", async () => {
  const received: Buffer[] = [];

  await new Promise<void>((resolve) => {
    wss.once("connection", (ws) => {
      ws.once("message", () => {
        ws.send(JSON.stringify({ type: "spawn_ok", handle: "h-1" }));
      });
      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          received.push(data as Buffer);
          resolve();
        }
      });
    });

    const shim = makeShim();
    shim.ready.then(() => shim.write("hello\r")).catch(() => {});
  });

  expect(received.length).toBeGreaterThan(0);
  expect(received[0]!.toString("utf8")).toBe("hello\r");
});

it("resize sends JSON control frame", async () => {
  const frames: unknown[] = [];

  await new Promise<void>((resolve) => {
    wss.once("connection", (ws) => {
      ws.once("message", () => {
        ws.send(JSON.stringify({ type: "spawn_ok", handle: "h-1" }));
      });
      ws.on("message", (data, isBinary) => {
        if (!isBinary) {
          const msg = JSON.parse(data.toString()) as unknown;
          frames.push(msg);
          if ((msg as { type: string }).type === "resize") resolve();
        }
      });
    });

    const shim = makeShim();
    shim.ready.then(() => shim.resize(120, 40)).catch(() => {});
  });

  expect(frames).toContainEqual({ type: "resize", cols: 120, rows: 40 });
});

it("onData fires with decoded base64 output", async () => {
  const received: string[] = [];

  const shim = makeShim();
  shim.onData((d) => received.push(d));

  await new Promise<void>((resolve) => {
    wss.once("connection", (ws) => {
      ws.once("message", () => {
        ws.send(JSON.stringify({ type: "spawn_ok", handle: "h-1" }));
        const b64 = Buffer.from("ls output\r\n", "utf8").toString("base64");
        ws.send(JSON.stringify({ type: "process.output", payload: { handle: "h-1", stream: "stdout", data: b64 } }));
        resolve();
      });
    });
  });

  await shim.ready;
  // Give the message handler a tick to fire
  await new Promise((r) => setTimeout(r, 20));
  expect(received).toContain("ls output\r\n");
});

it("onExit fires with exitCode and signal", async () => {
  const exits: Array<{ exitCode: number | null; signal: string | null }> = [];

  const shim = makeShim();
  shim.onExit((info) => exits.push(info));

  await new Promise<void>((resolve) => {
    wss.once("connection", (ws) => {
      ws.once("message", () => {
        ws.send(JSON.stringify({ type: "spawn_ok", handle: "h-1" }));
        ws.send(JSON.stringify({ type: "process.exit", payload: { handle: "h-1", exit_code: 0, signal: null } }));
        resolve();
      });
    });
  });

  await shim.ready;
  await new Promise((r) => setTimeout(r, 20));
  expect(exits).toHaveLength(1);
  expect(exits[0]).toEqual({ exitCode: 0, signal: null });
});

it("onBridgeStatus fires offline then online", async () => {
  const statuses: Array<"offline" | "online"> = [];

  const shim = makeShim();
  shim.onBridgeStatus((s) => statuses.push(s));

  await new Promise<void>((resolve) => {
    wss.once("connection", (ws) => {
      ws.once("message", () => {
        ws.send(JSON.stringify({ type: "spawn_ok", handle: "h-1" }));
        ws.send(JSON.stringify({ type: "bridge_disconnected" }));
        ws.send(JSON.stringify({ type: "bridge_reconnected" }));
        resolve();
      });
    });
  });

  await shim.ready;
  await new Promise((r) => setTimeout(r, 20));
  expect(statuses).toEqual(["offline", "online"]);
});
