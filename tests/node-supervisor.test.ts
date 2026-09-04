// node-supervisor.sh - the POSIX-sh process supervisor a tethered node (csg:
// WSL2, commonly no systemd-user) uses to keep the Garrison node process
// alive. What matters here is the supervisor's own lifecycle contract (a
// crashing child gets restarted, `stop` really kills the whole group, `ensure`
// never double-spawns) - never the real garrison-instance.sh, which these
// tests replace with tests/fixtures/node-supervisor/fake-instance.sh via
// NODE_SUPERVISOR_TARGET so nothing here touches the real node process, its
// ports, or the composition-owner lock.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "..", "scripts", "remote-shell", "node-supervisor.sh");
const FIXTURE = path.resolve(__dirname, "fixtures", "node-supervisor", "fake-instance.sh");

let TEST_HOME: string;
let MARKERS: string;
let baseEnv: NodeJS.ProcessEnv;

function run(args: string[], extraEnv: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(SCRIPT, args, {
      encoding: "utf8",
      env: { ...baseEnv, ...extraEnv } as unknown as NodeJS.ProcessEnv,
      timeout: 10_000
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err: any) {
    return { status: err.status ?? null, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
  }
}

function markerLines(): string[] {
  try {
    return readFileSync(MARKERS, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function waitFor(pred: () => boolean, { timeoutMs = 5000, intervalMs = 100 } = {}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (!pred()) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

beforeEach(() => {
  TEST_HOME = mkdtempSync(path.join(tmpdir(), "node-supervisor-test-"));
  MARKERS = path.join(TEST_HOME, "markers.log");
  baseEnv = {
    PATH: process.env.PATH,
    HOME: TEST_HOME,
    GARRISON_HOME: TEST_HOME,
    NODE_SUPERVISOR_TARGET: FIXTURE,
    NODE_SUPERVISOR_BACKOFF: "1",
    NODE_SUPERVISOR_TEST_MARKERS: MARKERS
  } as unknown as NodeJS.ProcessEnv;
});

afterEach(async () => {
  // Best-effort: whatever the test left running, tear it down before the
  // scratch home is removed, or a real process would leak past the test.
  run(["stop"]);
  await new Promise((r) => setTimeout(r, 200));
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("node-supervisor.sh", () => {
  it("reports stopped (exit 1) when nothing has ever been started", () => {
    const result = run(["status"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/stopped/);
  });

  it("refuses an unknown verb with usage on stderr and exit 2", () => {
    const result = run(["bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage: node-supervisor\.sh/);
  });

  it("daemon starts the supervised process and status reflects it running", async () => {
    const started = run(["daemon"]);
    expect(started.stdout).toMatch(/started/);

    await waitFor(() => markerLines().some((l) => l.startsWith("started pid=")));
    await waitFor(() => run(["status"]).status === 0);

    const status = run(["status"]);
    expect(status.stdout).toMatch(/running \(pid \d+\)/);
  });

  it("ensure is idempotent - a second call while already running does not spawn a duplicate", async () => {
    run(["ensure"]);
    await waitFor(() => markerLines().length >= 1);

    const again = run(["ensure"]);
    expect(again.stdout).toMatch(/already running/);

    // Give the (idempotent, no-op) call a moment, then confirm exactly one
    // "started" line - a real double-spawn would show two.
    await new Promise((r) => setTimeout(r, 300));
    expect(markerLines().filter((l) => l.startsWith("started"))).toHaveLength(1);
  });

  it("stop kills the whole process group - the child observably receives TERM and status flips back to stopped", async () => {
    run(["daemon"]);
    await waitFor(() => markerLines().some((l) => l.startsWith("started pid=")));

    const stopped = run(["stop"]);
    expect(stopped.stdout).toMatch(/stopped/);

    await waitFor(() => markerLines().some((l) => l.startsWith("stopped pid=")));
    expect(run(["status"]).status).toBe(1);
  });

  it("stop on an already-stopped supervisor says so instead of erroring", () => {
    const result = run(["stop"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/not running/);
  });

  it("restart stops the old child and brings up a fresh one", async () => {
    run(["daemon"]);
    await waitFor(() => markerLines().some((l) => l.startsWith("started pid=")));
    const firstPid = markerLines()[0].match(/pid=(\d+)/)?.[1];

    run(["restart"]);
    await waitFor(() => markerLines().filter((l) => l.startsWith("started pid=")).length >= 2);

    const secondPid = markerLines()
      .filter((l) => l.startsWith("started pid="))[1]
      .match(/pid=(\d+)/)?.[1];
    expect(secondPid).toBeDefined();
    expect(secondPid).not.toBe(firstPid);
  });

  it("retries a child that crashes on startup - not stuck after one failed attempt", async () => {
    run(["daemon"], { NODE_SUPERVISOR_TEST_EXIT_IMMEDIATELY: "1" });

    // BASE_BACKOFF=1s: within a few seconds the loop should have tried
    // several times, proving a startup-crashing child is retried forever
    // rather than leaving the supervisor silently dead.
    await waitFor(() => markerLines().filter((l) => l.startsWith("started pid=")).length >= 3, { timeoutMs: 8000 });
  });

  it("derives GARRISON_NODE_NAME from node.json's id when the caller does not pass it - found live: a bare 'restart' (no env re-passed) fell through to the raw machine hostname", async () => {
    // No GARRISON_NODE_NAME anywhere in baseEnv - this is exactly the shape
    // of install-node.sh's own restart call, which does not re-export it.
    writeFileSync(path.join(TEST_HOME, "node.json"), JSON.stringify({ id: "csg-test-node" }));
    run(["daemon"]);
    await waitFor(() => markerLines().some((l) => l.startsWith("started pid=")));
    expect(markerLines()[0]).toMatch(/GARRISON_NODE_NAME=csg-test-node/);
  });

  it("falls back to the raw hostname when node.json is absent (first-ever start, before install-node.sh writes it)", async () => {
    run(["daemon"]);
    await waitFor(() => markerLines().some((l) => l.startsWith("started pid=")));
    expect(markerLines()[0]).not.toMatch(/GARRISON_NODE_NAME=<unset>/);
    expect(markerLines()[0]).toMatch(/GARRISON_NODE_NAME=\S+/);
  });

  it("an explicitly-passed GARRISON_NODE_NAME still wins over node.json", async () => {
    writeFileSync(path.join(TEST_HOME, "node.json"), JSON.stringify({ id: "csg-test-node" }));
    run(["daemon"], { GARRISON_NODE_NAME: "explicit-override" });
    await waitFor(() => markerLines().some((l) => l.startsWith("started pid=")));
    expect(markerLines()[0]).toMatch(/GARRISON_NODE_NAME=explicit-override/);
  });
});
