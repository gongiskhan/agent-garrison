import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

// U1 — a REAL prompt THROUGH the gateway HTTP surface (live-route-ok /
// live-switch-ok). Boots the actual gateway-pty.mjs as a child process with the
// documented runtime stub (GARRISON_GATEWAY_RUNTIME_STUB) so the path is real —
// HTTP → classify → resolve → decisions.jsonl → pool serves → honored token —
// but deterministic and free (no live model). The live-claude counterpart is
// scripts/probe-live-gateway.mjs. Runs in the normal suite.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATEWAY = path.join(REPO_ROOT, "fittings", "seed", "http-gateway", "scripts", "gateway-pty.mjs");
const STUB = path.join(REPO_ROOT, "tests", "fixtures", "gateway-runtime-stub.mjs");

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

async function waitReady(port: number, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      const j = (await r.json()) as { pty_status?: string; error?: string };
      if (j.pty_status === "ready") return;
      if (j.pty_status === "failed") throw new Error(`gateway failed: ${j.error}`);
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("gateway did not become ready in time");
}

async function chat(port: number, message: string): Promise<{ reply: string; route?: string; honored?: boolean }> {
  const r = await fetch(`http://127.0.0.1:${port}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`/chat ${r.status}: ${await r.text()}`);
  return (await r.json()) as { reply: string; route?: string; honored?: boolean };
}

function readDecisions(file: string): any[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("U1 — real prompt through the gateway HTTP surface (stub runtime)", () => {
  let proc: ChildProcess | undefined;
  let tmp: string;
  let port: number;

  beforeAll(async () => {
    port = await freePort();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "garrison-gw-route-"));
    fs.mkdirSync(path.join(tmp, ".garrison"), { recursive: true });
    proc = spawn("node", [GATEWAY], {
      env: {
        ...process.env,
        GARRISON_GATEWAY_PORT: String(port),
        GARRISON_GATEWAY_HOST: "127.0.0.1",
        GARRISON_COMPOSITION_DIR: tmp,
        GARRISON_PERMISSION_MODE: "bypassPermissions",
        GARRISON_MODEL: "sonnet",
        GARRISON_GATEWAY_RUNTIME_STUB: STUB,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitReady(port);
  }, 30_000);

  afterAll(() => {
    try {
      proc?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  });

  it("health reports the pty engine, ready", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    const j = (await r.json()) as { engine: string; pty_status: string };
    expect(j.engine).toBe("pty");
    expect(j.pty_status).toBe("ready");
  });

  it("live-route-ok: classifies, resolves, logs, serves, and the reply honors the route", async () => {
    const res = await chat(port, "fix the failing login unit test");
    // the operative reply ends with the resolved route token
    expect(res.reply).toContain("[route: cc-sonnet-med");
    expect(res.route).toBe("cc-sonnet-med");
    expect(res.honored).toBe(true);

    // the gateway logged the decision to decisions.jsonl AT RESOLUTION TIME
    const decisions = readDecisions(path.join(tmp, ".garrison", "decisions.jsonl"));
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    const d = decisions[decisions.length - 1];
    expect(d.targetId).toBe("cc-sonnet-med");
    expect(d.profile).toBe("balanced");
    expect(d.role).toBe("standard");
  }, 20_000);

  it("live-switch-ok: a trivial prompt resolves to a different model and lands on it", async () => {
    const res = await chat(port, "quick: what is 2 plus 2");
    expect(res.reply).toContain("[route: cc-haiku-low");
    expect(res.route).toBe("cc-haiku-low");
    expect(res.honored).toBe(true);

    const decisions = readDecisions(path.join(tmp, ".garrison", "decisions.jsonl"));
    const targets = decisions.map((d) => d.targetId);
    expect(targets).toContain("cc-sonnet-med");
    expect(targets).toContain("cc-haiku-low");
  }, 20_000);
});
