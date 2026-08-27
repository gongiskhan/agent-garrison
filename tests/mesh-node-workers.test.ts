import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listWorkerViews,
  normaliseWorkerPulse,
  recordWorkerPulse,
  workerClaimVerdict,
  workerView,
  DISPATCH_PROTOCOL_VERSION,
  WORKER_STALE_MS
} from "@/lib/mesh/node-workers";

let sandbox: string;
let previous: string | undefined;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "node-workers-"));
  previous = process.env.GARRISON_HOME;
  process.env.GARRISON_HOME = sandbox;
});

afterEach(() => {
  if (previous === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = previous;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("node task-runner presence", () => {
  it("bounds and secret-redacts remote diagnostics", () => {
    process.env.OUTPOST_TEST_TOKEN = "host-known-token-value";
    const pulse = normaliseWorkerPulse({
      workerId: "w1",
      activity: "degraded",
      runtimes: ["agent-sdk", "agent-sdk", 42],
      detail: "Authorization: Bearer eyJheader123.payload456.signature789",
      error: "bad\u0000 token=sk-ant-supersecretvalue and host-known-token-value at https://me:password123@example.test"
    });
    delete process.env.OUTPOST_TEST_TOKEN;
    expect(pulse.activity).toBe("degraded");
    expect(pulse.runtimes).toEqual(["agent-sdk"]);
    expect(pulse.detail).toContain("***REDACTED***");
    expect(pulse.error).toContain("***REDACTED***");
    expect(`${pulse.detail} ${pulse.error}`).not.toMatch(/eyJheader|sk-ant-supersecret|host-known-token|password123/);
  });

  it("keeps one 0600 record per machine and marks stale workers offline", async () => {
    const record = await recordWorkerPulse("studio/mac", {
      workerId: "w1",
      protocolVersion: "1.1",
      workerVersion: "0.2.0",
      activity: "idle",
      runtimes: ["agent-sdk"],
      ready: true
    });
    const views = await listWorkerViews(Date.parse(record.lastSeenAt));
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ machine: "studio/mac", state: "ready", ready: true });
    expect(workerView(record, Date.parse(record.lastSeenAt) + WORKER_STALE_MS + 1).state).toBe("offline");
    const file = join(sandbox, "node-workers");
    const { readdirSync } = await import("node:fs");
    const recordPath = join(file, readdirSync(file)[0]);
    expect(statSync(recordPath).mode & 0o777).toBe(0o600);
  });

  it("permits claims only from the fresh compatible process and an advertised runtime", async () => {
    const now = Date.now();
    const view = workerView({
      machine: "studio",
      workerId: "worker-new",
      protocolVersion: DISPATCH_PROTOCOL_VERSION,
      workerVersion: "0.2.0",
      activity: "idle",
      currentCardId: null,
      runtimes: ["agent-sdk:anthropic"],
      ready: true,
      detail: "ready",
      error: null,
      lastSeenAt: new Date(now).toISOString()
    }, now);
    expect(workerClaimVerdict(view, {
      machine: "studio", workerId: "worker-new", runtimeKey: "agent-sdk:anthropic"
    }).ok).toBe(true);
    expect(workerClaimVerdict(view, { machine: "studio", workerId: "worker-old" }).code).toBe("worker-replaced");
    expect(workerClaimVerdict(view, {
      machine: "studio", workerId: "worker-new", runtimeKey: "codex:openai"
    }).code).toBe("runtime-unsupported");

    expect(workerClaimVerdict({ ...view, protocolVersion: "0.9" }, {
      machine: "studio", workerId: "worker-new"
    }).code).toBe("protocol-mismatch");
    expect(workerClaimVerdict({ ...view, stale: true, state: "offline" }, {
      machine: "studio", workerId: "worker-new"
    }).code).toBe("worker-offline");
    expect(workerClaimVerdict({ ...view, activity: "busy", state: "busy", currentCardId: "CARD" }, {
      machine: "studio", workerId: "worker-new"
    }).code).toBe("worker-busy");
  });
});
