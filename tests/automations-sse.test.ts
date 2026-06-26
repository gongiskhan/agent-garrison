import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shapeForStep } from "../fittings/seed/automations/lib/command-shape.mjs";

// E3 — the SSE run stream. Start the real automations server, run an automation
// asynchronously, and assert step events + run_complete arrive over SSE.

const REPO = path.resolve(__dirname, "..");
const START = path.join(REPO, "fittings", "seed", "automations", "scripts", "start.mjs");
const PORT = 7197;
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
  dir = mkdtempSync(path.join(tmpdir(), "garrison-sse-"));
  // Pre-approve the local_command shape so the run doesn't pause on consent (G2s).
  const shape = shapeForStep({ command: "printf streamed-output" });
  writeFileSync(path.join(dir, "approved-commands.json"), JSON.stringify({ shapes: [shape] }));
  srv = spawn("node", [START], {
    env: { ...process.env, GARRISON_AUTOMATIONS_DIR: dir, AUTOMATIONS_UI_PORT: String(PORT), AUTOMATIONS_UI_HOST: "127.0.0.1" }
  });
  await waitHealthy(8000);
});

afterEach(() => {
  if (srv && !srv.killed) srv.kill("SIGKILL");
  srv = null;
  rmSync(dir, { recursive: true, force: true });
});

async function readSse(runId: string, timeoutMs = 8000): Promise<any[]> {
  const res = await fetch(`${BASE}/api/runs/${runId}/stream`);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  const events: any[] = [];
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (line) events.push(JSON.parse(line.slice(6)));
    }
    if (events.some((e) => e.type === "run_complete" || e.type === "run_error")) break;
  }
  return events;
}

describe("automations SSE run stream (E3)", () => {
  it("streams run_step + run_complete for an async run", async () => {
    // create
    await fetch(`${BASE}/api/automations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "sse",
        name: "SSE flow",
        steps: [
          { id: "s1", type: "wait", durationMs: 20 },
          { id: "s2", type: "local_command", command: "printf streamed-output" }
        ]
      })
    });
    // run async
    const runRes = await fetch(`${BASE}/api/automations/sse/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputs: {} })
    });
    expect(runRes.status).toBe(202);
    const { runId } = await runRes.json();
    expect(runId).toBeTruthy();

    const events = await readSse(runId);
    const types = events.map((e) => e.type);
    expect(types).toContain("run_step");
    expect(types).toContain("step_output_chunk");
    expect(types).toContain("run_complete");
    // both steps reached completed
    const completed = events.filter((e) => e.type === "run_step" && e.status === "completed");
    expect(completed.length).toBe(2);
    // the streamed chunk carried the command output
    expect(events.some((e) => e.type === "step_output_chunk" && String(e.chunk).includes("streamed-output"))).toBe(true);
  }, 20000);
});
