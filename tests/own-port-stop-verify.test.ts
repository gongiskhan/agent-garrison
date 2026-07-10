import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnRecordPath, statusFilePath, stopOwnPortFitting } from "@/lib/own-port-lifecycle";

// Regression gate for the orphan-process incident: the plain stop path used to
// fire-and-forget SIGTERM and then delete BOTH tracking files without
// verifying exit, converting any process that survived (or was never hit,
// because only the spawn record still knew its pid) into an untracked orphan
// squatting its port. The stop must now (a) wait for exit and SIGKILL-escalate
// like the heal/restart paths, (b) fall back to Garrison's own spawn record
// when the status file is gone, and (c) keep the tracking files whenever the
// process is not confirmed dead.

const FITTING_ID = "stop-verify-fixture";

let sandbox: string;
const priorHome = process.env.GARRISON_HOME;
const children: ChildProcess[] = [];

function spawnSleeper(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore"
  });
  children.push(child);
  return child;
}

// A sleeper that traps SIGTERM, signalling readiness on stdout so the test
// only proceeds once the trap is INSTALLED (otherwise the stop's SIGTERM can
// land before the handler exists and the escalation path is never exercised).
async function spawnSigtermTrappingSleeper(): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
    { stdio: ["ignore", "pipe", "ignore"] }
  );
  children.push(child);
  await new Promise<void>((resolve) => {
    child.stdout!.once("data", () => resolve());
  });
  return child;
}

function writeStatusFile(pid: number): void {
  mkdirSync(path.dirname(statusFilePath(FITTING_ID)), { recursive: true });
  writeFileSync(
    statusFilePath(FITTING_ID),
    JSON.stringify({ fittingId: FITTING_ID, port: 65001, pid, startedAt: new Date().toISOString() })
  );
}

function writeSpawnRecordFile(pid: number, startedAt = new Date().toISOString()): void {
  mkdirSync(path.dirname(spawnRecordPath(FITTING_ID)), { recursive: true });
  writeFileSync(
    spawnRecordPath(FITTING_ID),
    JSON.stringify({ fittingId: FITTING_ID, pid, startedAt, secretsDelivered: true })
  );
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGone(pid: number): Promise<void> {
  for (let i = 0; i < 40 && alive(pid); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "garrison-stop-verify-"));
  process.env.GARRISON_HOME = sandbox;
});

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  if (priorHome === undefined) {
    delete process.env.GARRISON_HOME;
  } else {
    process.env.GARRISON_HOME = priorHome;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

describe("stopOwnPortFitting verifies exit before dropping tracking", () => {
  it("kills the status-file pid, waits for exit, and only then removes both tracking files", async () => {
    const proc = spawnSleeper();
    writeStatusFile(proc.pid!);
    writeSpawnRecordFile(proc.pid!);

    const result = await stopOwnPortFitting(FITTING_ID);

    expect(result.ok).toBe(true);
    expect(result.wasRunning).toBe(true);
    expect(result.pid).toBe(proc.pid);
    expect(alive(proc.pid!), "process must be confirmed dead before stop returns").toBe(false);
    expect(existsSync(statusFilePath(FITTING_ID))).toBe(false);
    expect(existsSync(spawnRecordPath(FITTING_ID))).toBe(false);
  });

  it("escalates to SIGKILL when SIGTERM is trapped, still confirming exit", async () => {
    const proc = await spawnSigtermTrappingSleeper();
    writeStatusFile(proc.pid!);
    writeSpawnRecordFile(proc.pid!);

    const result = await stopOwnPortFitting(FITTING_ID);

    expect(result.ok).toBe(true);
    expect(result.wasRunning).toBe(true);
    expect(alive(proc.pid!), "SIGTERM-trapping process must be SIGKILLed").toBe(false);
    expect(existsSync(statusFilePath(FITTING_ID))).toBe(false);
    expect(existsSync(spawnRecordPath(FITTING_ID))).toBe(false);
  }, 15000);

  it("falls back to the spawn record pid when the status file is missing (a live recorded process never becomes untracked)", async () => {
    const proc = spawnSleeper();
    writeSpawnRecordFile(proc.pid!);
    expect(existsSync(statusFilePath(FITTING_ID))).toBe(false);

    const result = await stopOwnPortFitting(FITTING_ID);
    await waitGone(proc.pid!);

    expect(result.ok).toBe(true);
    expect(result.wasRunning).toBe(true);
    expect(result.pid).toBe(proc.pid);
    expect(alive(proc.pid!), "recorded pid must be reaped via the spawn record").toBe(false);
    expect(existsSync(spawnRecordPath(FITTING_ID))).toBe(false);
  });

  it("a status file with a dead pid reads as not running and both tracking files are cleaned up", async () => {
    const proc = spawnSleeper();
    const pid = proc.pid!;
    proc.kill("SIGKILL");
    await waitGone(pid);
    writeStatusFile(pid);
    writeSpawnRecordFile(pid);

    const result = await stopOwnPortFitting(FITTING_ID);

    expect(result.ok).toBe(true);
    expect(result.wasRunning).toBe(false);
    expect(existsSync(statusFilePath(FITTING_ID))).toBe(false);
    expect(existsSync(spawnRecordPath(FITTING_ID))).toBe(false);
  });

  // The guard reads /proc/<pid> birth time, so it can only be asserted on Linux.
  it.runIf(process.platform === "linux")("does not kill a spawn-record pid born long after the record was written (OS pid-reuse guard)", async () => {
    const proc = spawnSleeper();
    // Record written "before a reboot": an hour older than the live process.
    writeSpawnRecordFile(proc.pid!, new Date(Date.now() - 60 * 60 * 1000).toISOString());

    const result = await stopOwnPortFitting(FITTING_ID);

    expect(result.ok).toBe(true);
    expect(result.wasRunning).toBe(false);
    expect(alive(proc.pid!), "a reused pid must never be killed off a stale record").toBe(true);
    expect(existsSync(spawnRecordPath(FITTING_ID)), "the stale record is cleared").toBe(false);
  });
});
