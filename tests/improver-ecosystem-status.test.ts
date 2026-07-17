import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

// Slice 3 (FLOW_PLAN docs/autothing/runs/20260701-092738-9b939e7a) - the
// improver own-port server's GET /api/ecosystem-status endpoint, which backs
// the review UI's new "Ecosystem" tab.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(REPO_ROOT, "fittings", "seed", "improver", "scripts", "server.mjs");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitHealth(port: number, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch {
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("improver server did not become healthy");
}

async function api(port: number, method: string, p: string) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, signal: AbortSignal.timeout(10_000) });
  return { status: r.status, json: (await r.json()) as any };
}

describe("Slice 3 - GET /api/ecosystem-status", () => {
  let proc: ChildProcess | undefined;
  let tmp: string;
  let data: string;
  let port: number;

  beforeAll(async () => {
    port = await freePort();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "garrison-improver-ecosys-"));
    data = path.join(tmp, "improver-data");
    fs.mkdirSync(data, { recursive: true });
    proc = spawn("node", [SERVER], {
      env: {
        ...process.env,
        // Cleared: resolveCompositionDir() falls back to "no apm.yml" only when
        // this is absent/empty. Running this suite from inside a live Garrison
        // Operative shell inherits a REAL GARRISON_COMPOSITION_DIR via
        // process.env, which would otherwise leak through the spread and break
        // the "no real composition dir in this test env" assumption below.
        GARRISON_COMPOSITION_DIR: "",
        IMPROVER_PORT: String(port),
        IMPROVER_HOST: "127.0.0.1",
        IMPROVER_DATA: data,
        GARRISON_HOME: tmp
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitHealth(port);
  }, 20_000);

  afterAll(() => {
    try {
      proc?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  });

  it("returns nulls before any run has been recorded", async () => {
    const res = await api(port, "GET", "/api/ecosystem-status");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ecosystemUpdate: null, reapplySweep: null });
  });

  it("returns the last recorded entries after a real run-now (which drives both phases)", async () => {
    // run-now is the same handler that drives runEcosystemUpdate/runReapplySweep
    // in production - a real integration exercise, not hand-seeded fixtures.
    await fetch(`http://127.0.0.1:${port}/api/run-now`, { method: "POST" });

    const res = await api(port, "GET", "/api/ecosystem-status");
    expect(res.status).toBe(200);
    expect(res.json.ecosystemUpdate).toBeTruthy();
    expect(res.json.ecosystemUpdate.skipped).toMatch(/no apm\.yml/); // no real composition dir in this test env
    expect(res.json.reapplySweep).toBeTruthy();
    expect(res.json.reapplySweep.checked).toBe(0); // fresh queue, nothing to sweep
  });

  it("returns the MOST RECENT entry, not the first, when a log has multiple runs", async () => {
    // Proves doEcosystemStatus() picks the last array element, not the first -
    // hand-seed two distinguishable entries directly (real run-now entries are
    // identical in shape in this test env, so they can't prove ordering).
    fs.writeFileSync(
      path.join(data, "ecosystem-update-log.json"),
      JSON.stringify([
        { at: "2026-01-01T00:00:00Z", skipped: "FIRST-RUN-MARKER" },
        { at: "2026-01-02T00:00:00Z", skipped: "SECOND-RUN-MARKER" },
      ]),
      "utf8"
    );
    fs.writeFileSync(
      path.join(data, "reapply-sweep-log.json"),
      JSON.stringify([
        { at: "2026-01-01T00:00:00Z", checked: 1, restored: 1, failed: [] },
        { at: "2026-01-02T00:00:00Z", checked: 2, restored: 2, failed: [] },
      ]),
      "utf8"
    );

    const res = await api(port, "GET", "/api/ecosystem-status");
    expect(res.json.ecosystemUpdate.skipped).toBe("SECOND-RUN-MARKER");
    expect(res.json.reapplySweep.checked).toBe(2);
  });
});
