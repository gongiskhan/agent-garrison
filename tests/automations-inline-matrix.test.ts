import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Engine deltas 1 (inline ephemeral runs + contextTag) and 6 (run matrix) at
// the real HTTP surface — no saved automation required beforehand.

const REPO = path.resolve(__dirname, "..");
const START = path.join(REPO, "fittings", "seed", "automations", "scripts", "start.mjs");
const PORT = 7220; // unique across the suite — 7198 is automations-mcp.test.ts's
const BASE = `http://127.0.0.1:${PORT}`;

let dir: string;
let srv: ChildProcess | null = null;

async function waitHealthy(timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "garrison-inline-"));
  srv = spawn("node", [START], {
    env: { ...process.env, GARRISON_HOME: dir, GARRISON_AUTOMATIONS_DIR: dir, AUTOMATIONS_UI_PORT: String(PORT), AUTOMATIONS_UI_HOST: "127.0.0.1" }
  });
  await waitHealthy(8000);
});

afterEach(() => {
  if (srv && !srv.killed) srv.kill("SIGKILL");
  srv = null;
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/automations/run-inline (delta 1)", () => {
  it("runs a not-persisted automation body to completion, sync, with a contextTag", async () => {
    const res = await fetch(`${BASE}/api/automations/run-inline?sync=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        automation: { name: "inline probe", steps: [{ id: "s1", type: "wait", durationMs: 1 }] },
        contextTag: "drill"
      })
    });
    expect(res.status).toBe(200);
    const { run } = await res.json();
    expect(run.status).toBe("completed");
    expect(run.contextTag).toBe("drill");
    expect(run.ephemeral).toBe(true);
    // never persisted to the saved-automations list
    const list = await (await fetch(`${BASE}/api/automations`)).json();
    expect(list.automations).toHaveLength(0);
  });

  it("400s when automation.steps is missing", async () => {
    const res = await fetch(`${BASE}/api/automations/run-inline`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ automation: { name: "no steps" } })
    });
    expect(res.status).toBe(400);
  });

  it("returns {runId} async (no ?sync=1) and the run is separately fetchable once complete", async () => {
    const res = await fetch(`${BASE}/api/automations/run-inline`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ automation: { name: "inline async", steps: [{ id: "s1", type: "wait", durationMs: 1 }] } })
    });
    expect(res.status).toBe(202);
    const { runId } = await res.json();
    expect(runId).toBeTruthy();
    let run: any = null;
    for (let i = 0; i < 40; i++) {
      const r = await fetch(`${BASE}/api/runs/${runId}`);
      if (r.ok) { run = (await r.json()).run; if (run.status !== "running") break; }
      await new Promise((r2) => setTimeout(r2, 100));
    }
    expect(run?.status).toBe("completed");
  });
});

describe("POST /api/automations/run-matrix (delta 6)", () => {
  it("runs an inline automation once per viewport and returns grouped results", async () => {
    const res = await fetch(`${BASE}/api/automations/run-matrix`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        automation: { name: "matrix probe", steps: [{ id: "s1", type: "wait", durationMs: 1 }] },
        viewports: [{ id: "desktop", width: 1280, height: 800 }, { id: "mobile", width: 390, height: 844 }],
        contextTag: "drill"
      })
    });
    expect(res.status).toBe(200);
    const { matrix } = await res.json();
    expect(matrix.results).toHaveLength(2);
    expect(matrix.results.map((r: any) => r.viewportId).sort()).toEqual(["desktop", "mobile"]);
    expect(matrix.results.every((r: any) => r.status === "completed")).toBe(true);

    const fetched = await (await fetch(`${BASE}/api/runs/matrix/${matrix.matrixId}`)).json();
    expect(fetched.matrix.matrixId).toBe(matrix.matrixId);
  });

  it("400s when viewports is missing/empty", async () => {
    const res = await fetch(`${BASE}/api/automations/run-matrix`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ automation: { name: "x", steps: [] }, viewports: [] })
    });
    expect(res.status).toBe(400);
  });
});
