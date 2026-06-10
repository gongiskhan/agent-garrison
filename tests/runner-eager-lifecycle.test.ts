import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Eager views are server-lifecycle citizens — the runner must not reap them.
// Regression gate for the bug where eager-booted fittings were SIGTERM'd by
// (a) the runner's startup orphan sweep (reconcileOrphanedOwnPortFittings on
// the first getRunnerState of a fresh process) and (b) `down`'s
// stopOperativeBoundFittings. Both now skip fittings toggled eager.
//
// Real processes, real status files, real prefs — all under a sandbox
// GARRISON_HOME (own-port-lifecycle resolves its status dir per-call through
// garrisonDir(), so nothing here can touch the user's live fittings). The
// composition + library are the repo's real ones; the two fitting ids used
// are genuinely operative-bound members of the default composition.

const EAGER_ID = "terminal-armory-default";
const PLAIN_ID = "screen-share-default";

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

function writeStatusFile(fittingId: string, pid: number): void {
  const dir = path.join(sandbox, "ui-fittings");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${fittingId}.json`),
    JSON.stringify({ fittingId, port: 65000, url: "http://127.0.0.1:65000", pid, startedAt: new Date().toISOString() })
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

const waitGone = async (pid: number) => {
  for (let i = 0; i < 40 && alive(pid); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

async function freshRunner() {
  // Fresh module instance: resets the memoized reconciliation promise, which
  // is exactly the "first state read of a new Garrison process" condition.
  vi.resetModules();
  delete (globalThis as Record<string, unknown>).__agentGarrisonRunner;
  return await import("@/lib/runner");
}

beforeEach(async () => {
  sandbox = mkdtempSync(path.join(tmpdir(), "garrison-runner-eager-"));
  process.env.GARRISON_HOME = sandbox;
  const { setEagerBoot } = await import("@/lib/eager-boot");
  await setEagerBoot(EAGER_ID, true);
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

describe("runner respects eager lifecycle", () => {
  it("the startup orphan sweep leaves an eager fitting running and reaps a non-eager one", async () => {
    const eagerProc = spawnSleeper();
    const plainProc = spawnSleeper();
    writeStatusFile(EAGER_ID, eagerProc.pid!);
    writeStatusFile(PLAIN_ID, plainProc.pid!);

    const runner = await freshRunner();
    await runner.reconcileOrphanedOwnPortFittings();
    await waitGone(plainProc.pid!);

    expect(alive(eagerProc.pid!), "eager fitting must survive the orphan sweep").toBe(true);
    expect(alive(plainProc.pid!), "non-eager orphan must be reaped").toBe(false);
    expect(existsSync(path.join(sandbox, "ui-fittings", `${EAGER_ID}.json`))).toBe(true);
    expect(existsSync(path.join(sandbox, "ui-fittings", `${PLAIN_ID}.json`))).toBe(false);
  });

  it("stopping the operative leaves an eager fitting running and stops a non-eager one", async () => {
    const eagerProc = spawnSleeper();
    const plainProc = spawnSleeper();
    writeStatusFile(EAGER_ID, eagerProc.pid!);
    writeStatusFile(PLAIN_ID, plainProc.pid!);

    const runner = await freshRunner();
    await runner.stopOperativeBoundFittings("default");
    await waitGone(plainProc.pid!);

    expect(alive(eagerProc.pid!), "eager fitting must survive operative down").toBe(true);
    expect(alive(plainProc.pid!), "non-eager operative-bound fitting must stop with the operative").toBe(false);
  });

  it("with no eager prefs everything reconciles exactly as before", async () => {
    const { setEagerBoot } = await import("@/lib/eager-boot");
    await setEagerBoot(EAGER_ID, false);

    const eagerProc = spawnSleeper();
    writeStatusFile(EAGER_ID, eagerProc.pid!);

    const runner = await freshRunner();
    await runner.reconcileOrphanedOwnPortFittings();
    await waitGone(eagerProc.pid!);

    expect(alive(eagerProc.pid!), "untoggled fitting is an orphan again").toBe(false);
  });
});
