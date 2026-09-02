import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, beforeAll, afterAll } from "vitest";
// @ts-ignore - pure .mjs
import { makeRequestHandler } from "../fittings/seed/kanban-loop/scripts/server.mjs";

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

// GET /board/runtime is the board UI's one source for where Conversations lives
// and whether a gateway is up. Conversations is a route of the Garrison shell,
// not an embedded fitting, so the endpoint names that route and scans no
// web-channel status file (no webChannelEmbedId / webChannelUrl fields). These
// drive the endpoint over HTTP against a sandboxed home so the assertions never
// depend on what this machine runs.

interface RuntimeBody {
  conversationsRoute: string;
  gatewayBaseUrl: string | null;
  noGateway: boolean;
  cardsAbsDir: string;
  [key: string]: unknown;
}

let home: string;
let board: string;
let priorHome: string | undefined;
let priorBoard: string | undefined;
const servers: http.Server[] = [];

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "kanban-runtime-"));
  board = path.join(home, "kanban-loop");
  mkdirSync(board, { recursive: true });
  priorHome = process.env.GARRISON_HOME;
  priorBoard = process.env.GARRISON_KANBAN_DIR;
  process.env.GARRISON_HOME = home;
  process.env.GARRISON_KANBAN_DIR = board;
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  if (priorHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = priorHome;
  if (priorBoard === undefined) delete process.env.GARRISON_KANBAN_DIR;
  else process.env.GARRISON_KANBAN_DIR = priorBoard;
  rmSync(home, { recursive: true, force: true });
});

async function runtime(gatewayUrl: string | null): Promise<RuntimeBody> {
  const server = http.createServer(makeRequestHandler({ root: board, cwd: board, gatewayUrl, cap: 10 }, board));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}/board/runtime`);
  expect(res.status).toBe(200);
  return (await res.json()) as RuntimeBody;
}

describe("/board/runtime - Conversations is a shell route", () => {
  it("names the relative /talk route and carries no embedded-channel fields", async () => {
    const body = await runtime(null);
    expect(body.conversationsRoute).toBe("/talk");
    // Relative by contract: the browser is usually on another machine over the
    // tailnet, so an absolute loopback here would be unreachable + mixed content.
    expect(body.conversationsRoute.startsWith("/")).toBe(true);
    expect(body.conversationsRoute).not.toMatch(/^\/\/|^https?:/);
    expect(body).not.toHaveProperty("webChannelEmbedId");
    expect(body).not.toHaveProperty("webChannelUrl");
  });

  it("reports the gateway the runner injected, and its absence", async () => {
    const down = await runtime(null);
    expect(down.gatewayBaseUrl).toBeNull();
    expect(down.noGateway).toBe(true);

    const up = await runtime("http://127.0.0.1:1");
    expect(up.gatewayBaseUrl).toBe("http://127.0.0.1:1");
    expect(up.noGateway).toBe(false);
  });

  it("hands Conversations the absolute, card-owned cards dir for the Brief editor", async () => {
    const body = await runtime(null);
    expect(body.cardsAbsDir).toBe(path.join(board, "cards"));
  });

  it("does not scan ui-fittings: a web-channel status file changes nothing", async () => {
    // A node still running the legacy own-port web channel writes this file; the
    // route is the shell's regardless of it.
    mkdirSync(path.join(home, "ui-fittings"), { recursive: true });
    writeFileSync(
      path.join(home, "ui-fittings", "web-channel-default.json"),
      JSON.stringify({ fittingId: "web-channel-default", url: "http://127.0.0.1:1", pid: 1 })
    );
    const body = await runtime(null);
    expect(body.conversationsRoute).toBe("/talk");
    expect(Object.keys(body).sort()).toEqual(["cardsAbsDir", "conversationsRoute", "gatewayBaseUrl", "noGateway"]);
  });
});
