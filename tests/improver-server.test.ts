import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

// U3 — the Improver review-queue own-port server, live round-trip over HTTP:
// run-now → proposal in queue → Approve (apply via the baselineSha contract +
// reconcile) → applied with evidence; Reject → target untouched; a rule set auto
// applies with no streak. Boots the real server child process. Free + fast (no
// model). Tokens: improver-proposal-ok, improver-apply-ok, improver-reject-ok,
// autonomy-direct-ok.

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

async function api(port: number, method: string, p: string, body?: any) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  return { status: r.status, json: (await r.json()) as any };
}

function writeMemory(file: string, n: number) {
  const lines = ["alpha", "beta", "gamma", "delta", "epsilon"].slice(0, n).map((x, i) => `- [${x}](${x}.md) — hook ${i}`);
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
}

describe("U3 — Improver review-queue server (live round-trip)", () => {
  let proc: ChildProcess | undefined;
  let tmp: string;
  let data: string;
  let memory: string;
  let target: string;
  let port: number;

  beforeAll(async () => {
    port = await freePort();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "garrison-improver-srv-"));
    data = path.join(tmp, "improver-data");
    memory = path.join(tmp, "MEMORY.md");
    target = path.join(tmp, "knowledge-memory.md");
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(target, "# Knowledge memory\n", "utf8");
    writeMemory(memory, 2);
    proc = spawn("node", [SERVER], {
      env: {
        ...process.env,
        IMPROVER_PORT: String(port),
        IMPROVER_HOST: "127.0.0.1",
        IMPROVER_DATA: data,
        IMPROVER_MEMORY: memory,
        IMPROVER_TARGET: target,
        GARRISON_HOME: tmp, // status file → tmp, never the real ~/.garrison
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

  it("improver-proposal-ok: run-now produces a pending proposal in the queue", async () => {
    const run = await api(port, "POST", "/api/run-now");
    expect(run.json.proposals).toBeGreaterThanOrEqual(1);
    const q = await api(port, "GET", "/api/queue");
    const pending = q.json.queue.find((p: any) => p.id === "memory-consolidation-2");
    expect(pending).toBeTruthy();
    expect(pending.status).toBe("pending");
  });

  it("improver-apply-ok: Approve applies via the contract, runs reconcile, marks applied with evidence", async () => {
    const res = await api(port, "POST", "/api/proposals/memory-consolidation-2/apply");
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.evidence.bytes).toBeGreaterThan(0);
    expect(res.json.reconciled).toBeTruthy();

    // target written with the marked block
    const after = fs.readFileSync(target, "utf8");
    expect(after).toContain("<!-- improver:memory-consolidation-2 -->");
    // reconcile('post-authoring') was invoked (recorded marker)
    const marker = JSON.parse(fs.readFileSync(path.join(data, "reconcile-invoked.json"), "utf8"));
    expect(marker.some((m: any) => m.trigger === "post-authoring")).toBe(true);
    // queue entry is now applied with evidence
    const q = await api(port, "GET", "/api/queue");
    const entry = q.json.queue.find((p: any) => p.id === "memory-consolidation-2");
    expect(entry.status).toBe("applied");
    expect(entry.evidence).toBeTruthy();
  });

  it("improver-reject-ok: Reject marks rejected and leaves the target untouched", async () => {
    writeMemory(memory, 3); // a fresh proposal id memory-consolidation-3
    await api(port, "POST", "/api/run-now");
    const before = fs.readFileSync(target, "utf8");
    const res = await api(port, "POST", "/api/proposals/memory-consolidation-3/reject");
    expect(res.json.ok).toBe(true);
    expect(res.json.status).toBe("rejected");
    const after = fs.readFileSync(target, "utf8");
    expect(after).toBe(before); // untouched
    expect(after).not.toContain("memory-consolidation-3");
    const q = await api(port, "GET", "/api/queue");
    expect(q.json.queue.find((p: any) => p.id === "memory-consolidation-3").status).toBe("rejected");
  });

  it("autonomy-direct-ok: a rule set auto applies with no streak at run-now", async () => {
    await api(port, "PUT", "/api/autonomy", { rule: "memory-consolidation", mode: "auto" });
    writeMemory(memory, 4); // a fresh proposal id memory-consolidation-4
    const run = await api(port, "POST", "/api/run-now");
    expect(run.json.autoApplied).toContain("memory-consolidation-4");
    const after = fs.readFileSync(target, "utf8");
    expect(after).toContain("<!-- improver:memory-consolidation-4 -->");
    const q = await api(port, "GET", "/api/queue");
    expect(q.json.queue.find((p: any) => p.id === "memory-consolidation-4").status).toBe("applied");
    // the auto rule did not earn a streak — it was set directly
    expect(q.json.autonomy["memory-consolidation"].autonomy).toBe("auto");
  });
});
