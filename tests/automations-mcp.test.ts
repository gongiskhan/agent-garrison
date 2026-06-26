import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { automationsAvailable, callListAutomations, callRunAutomation } from "../fittings/seed/mcp-gateway/scripts/lib/tools.mjs";

// E5 — the Operative can list + run automations as MCP tools. We start the real
// automations server (registering its status under a tmp GARRISON_HOME) and call
// the mcp-gateway tool helpers against it.

const REPO = path.resolve(__dirname, "..");
const START = path.join(REPO, "fittings", "seed", "automations", "scripts", "start.mjs");
const PORT = 7198;

let home: string;
let srv: ChildProcess | null = null;

async function waitHealthy(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), "garrison-mcp-"));
  process.env.GARRISON_HOME = home;
  process.env.GARRISON_AUTOMATIONS_DIR = path.join(home, "automations");
  srv = spawn("node", [START], {
    env: { ...process.env, GARRISON_HOME: home, GARRISON_AUTOMATIONS_DIR: path.join(home, "automations"), AUTOMATIONS_UI_PORT: String(PORT), AUTOMATIONS_UI_HOST: "127.0.0.1" }
  });
  await waitHealthy(8000);
});

afterEach(() => {
  if (srv && !srv.killed) srv.kill("SIGKILL");
  srv = null;
  delete process.env.GARRISON_HOME;
  delete process.env.GARRISON_AUTOMATIONS_DIR;
  rmSync(home, { recursive: true, force: true });
});

describe("automations MCP tools (E5)", () => {
  it("discovers the running engine and lists + runs an automation", async () => {
    expect(automationsAvailable()).toBe(true);

    await fetch(`http://127.0.0.1:${PORT}/api/automations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "mcp-auto", name: "MCP automation", steps: [{ id: "s1", type: "wait", durationMs: 5 }] })
    });

    const list = await callListAutomations();
    expect(list.some((a) => a.id === "mcp-auto" && a.name === "MCP automation")).toBe(true);

    const run = await callRunAutomation({ id: "mcp-auto", inputs: {} });
    expect(run.status).toBe("completed");
    expect(run.steps).toEqual([{ type: "wait", status: "completed" }]);
  }, 20000);
});
