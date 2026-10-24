// The scheduler runs `kanban.mjs --tick` every two minutes. The tick checks the
// gateway before kicking conversations, and that check must be a quiet skip when
// the gateway is down, never a crash.
//
// A refactor removed the `gatewayReachable` helper but kept its call site, so
// every tick with a configured gateway threw
// `ReferenceError: gatewayReachable is not defined` and exited 1 before it could
// kick a single conversation. The scheduler kept running the job, so the board
// simply stopped moving. Both cases run the real CLI as a subprocess.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";

// @ts-ignore pure mjs
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore pure mjs
import { saveBoard } from "../fittings/seed/kanban-loop/lib/board.mjs";

// The card store is the STATE SERVICE now, not files under GARRISON_KANBAN_DIR.
// Boot one for this file and project its discovery env before the tick reads it.
import { setupKanbanState } from "./kanban-state-env";
let __kanbanState: Awaited<ReturnType<typeof setupKanbanState>>;
beforeAll(async () => {
  __kanbanState = await setupKanbanState();
  // The tick loads the board before it reaches the gateway check.
  await saveBoard(seedBoard(), mkdtempSync(join(tmpdir(), "kanban-tick-gw-board-")));
}, 30_000);
afterAll(async () => {
  await __kanbanState?.stop();
});

const KANBAN_CLI = fileURLToPath(new URL("../fittings/seed/kanban-loop/scripts/kanban.mjs", import.meta.url));

interface TickResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Async on purpose: the second case answers from an HTTP server in THIS process,
// which a blocking spawnSync would never let respond.
function runTick(gatewayUrl: string): Promise<TickResult> {
  const home = mkdtempSync(join(tmpdir(), "kanban-tick-gw-"));
  const child = spawn(process.execPath, [KANBAN_CLI, "--tick"], {
    env: {
      ...process.env,
      GARRISON_HOME: home,
      GARRISON_KANBAN_DIR: join(home, "kanban-loop"),
      GARRISON_GATEWAY_URL: gatewayUrl
    }
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })));
}

// A port that was just free: bind, read it back, release it.
async function closedPortUrl(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

describe("kanban tick gateway check", () => {
  it("skips quietly when the gateway is unreachable", async () => {
    const result = await runTick(await closedPortUrl());
    expect(result.stderr).not.toContain("gatewayReachable is not defined");
    expect(result.stdout).toContain("gateway not reachable");
    expect(result.status).toBe(0);
  }, 30_000);

  it("gets past the check when the gateway answers, even with a 404", async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const result = await runTick(`http://127.0.0.1:${port}`);
      expect(result.stderr).not.toContain("gatewayReachable is not defined");
      expect(result.stdout).not.toContain("gateway not reachable");
      expect(result.status).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});
