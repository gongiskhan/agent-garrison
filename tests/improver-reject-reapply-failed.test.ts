import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

// Codex adversarial-review finding (Slice 3, run 20260701-092738-9b939e7a):
// dismissing a "reapply-failed" entry via Reject must NOT record a rule-level
// "reject" autonomy outcome - that signal means "a human turned down a fresh
// proposal", not "an already-approved change got stuck after an ecosystem
// update". Recording it would silently demote an auto rule or reset its
// promotion streak for reasons unrelated to the rule's quality.

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

describe("Reject on a reapply-failed entry does not touch rule autonomy", () => {
  let proc: ChildProcess | undefined;
  let tmp: string;
  let data: string;
  let port: number;

  beforeAll(async () => {
    port = await freePort();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "garrison-improver-rejectrf-"));
    data = path.join(tmp, "improver-data");
    fs.mkdirSync(data, { recursive: true });

    // Seed a rule already promoted to "auto" with a real accept streak, and a
    // reapply-failed queue entry for that same rule.
    fs.writeFileSync(
      path.join(data, "autonomy.json"),
      JSON.stringify({ "memory-consolidation": { autonomy: "auto", streak: 3, accepted: 5, rejected: 0, reverted: 0 } }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(data, "review-queue.json"),
      JSON.stringify([
        {
          id: "stuck-1",
          rule: "memory-consolidation",
          targetClass: "memory",
          claim: "test",
          diff: "+ line",
          decision: "approved",
          applyVia: "reconcile",
          status: "reapply-failed",
          at: "2026-06-15T00:00:00Z",
          reapplyFailureReason: "conflict: target changed again mid-reapply",
          reapplyFailedAt: "2026-06-16T00:00:00Z",
        },
      ]),
      "utf8"
    );

    proc = spawn("node", [SERVER], {
      env: { ...process.env, IMPROVER_PORT: String(port), IMPROVER_HOST: "127.0.0.1", IMPROVER_DATA: data, GARRISON_HOME: tmp },
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

  it("rejects (dismisses) the entry but leaves autonomy state untouched", async () => {
    const before = await api(port, "GET", "/api/autonomy");
    expect(before.json.autonomy["memory-consolidation"]).toEqual({ autonomy: "auto", streak: 3, accepted: 5, rejected: 0, reverted: 0 });

    const res = await api(port, "POST", "/api/proposals/stuck-1/reject");
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.status).toBe("rejected");
    expect(res.json.autonomyEvent).toBeNull(); // no autonomy outcome was recorded

    const queue = await api(port, "GET", "/api/queue");
    expect(queue.json.queue.find((p: any) => p.id === "stuck-1").status).toBe("rejected");

    const after = await api(port, "GET", "/api/autonomy");
    expect(after.json.autonomy["memory-consolidation"]).toEqual({ autonomy: "auto", streak: 3, accepted: 5, rejected: 0, reverted: 0 });
  });
});
