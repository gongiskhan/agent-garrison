import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fittings share the operative's lifecycle, always (2026-07-29 fittings/views
// refit; the earlier eager/server-lifecycle split is gone): the startup orphan
// sweep reaps every own-port fitting not protected by a RUNNING composition,
// and `down`'s stopOperativeBoundFittings stops every own-port fitting.
//
// Real processes, real status files — all under a sandbox GARRISON_HOME
// (own-port-lifecycle resolves its status dir per-call through garrisonDir(),
// so nothing here can touch the user's live fittings). The composition +
// library are the repo's real ones; the two fitting ids used are genuinely
// own-port members of the default composition.

const FITTING_A = "dev-env";
const FITTING_B = "screen-share-default";

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
  // "New Garrison process" condition: both the module instance AND the
  // globalThis runtime (records map + sweep memo, which lives there so dev
  // hot reloads don't re-trigger the sweep) are reset. A module reset alone
  // simulates a hot reload, not a fresh process.
  vi.resetModules();
  delete (globalThis as Record<string, unknown>).__agentGarrisonRunner;
  return await import("@/lib/runner");
}

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "garrison-runner-lifecycle-"));
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
  // The sweep memo and records map live on globalThis — drop them so one
  // test's "process" state can't leak into the next.
  delete (globalThis as Record<string, unknown>).__agentGarrisonRunner;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("fittings share the operative's lifecycle", () => {
  it("the startup orphan sweep reaps every own-port fitting when nothing is running", async () => {
    const procA = spawnSleeper();
    const procB = spawnSleeper();
    writeStatusFile(FITTING_A, procA.pid!);
    writeStatusFile(FITTING_B, procB.pid!);

    const runner = await freshRunner();
    await runner.reconcileOrphanedOwnPortFittings();
    await waitGone(procA.pid!);
    await waitGone(procB.pid!);

    expect(alive(procA.pid!), "orphan must be reaped").toBe(false);
    expect(alive(procB.pid!), "orphan must be reaped").toBe(false);
    expect(existsSync(path.join(sandbox, "ui-fittings", `${FITTING_A}.json`))).toBe(false);
    expect(existsSync(path.join(sandbox, "ui-fittings", `${FITTING_B}.json`))).toBe(false);
  });

  it("stopping the operative stops every own-port fitting", async () => {
    const procA = spawnSleeper();
    const procB = spawnSleeper();
    writeStatusFile(FITTING_A, procA.pid!);
    writeStatusFile(FITTING_B, procB.pid!);

    const runner = await freshRunner();
    await runner.stopOperativeBoundFittings("default");
    await waitGone(procA.pid!);
    await waitGone(procB.pid!);

    expect(alive(procA.pid!), "own-port fitting must stop with the operative").toBe(false);
    expect(alive(procB.pid!), "own-port fitting must stop with the operative").toBe(false);
  });
});

// Regression gate for the hot-reload incident: minutes after a dev-server
// hot reload, the startup orphan sweep SIGTERM-reaped all operative-bound
// fittings of a RUNNING operative. Two halves: (a) the sweep memo lives on
// globalThis (__agentGarrisonRunner), so a re-instantiated module doesn't
// re-run it; (b) the sweep skips fittings of any composition whose persisted
// record says "running". vi.resetModules() while keeping globalThis is
// exactly the production hot-reload mechanics.
describe("orphan sweep across dev-server hot reloads", () => {
  it("a hot reload (module reset, persisted globalThis) does not re-run the sweep", async () => {
    // First sweep of the "process": nothing on disk to reap, but the memo
    // lands on globalThis.
    const first = await freshRunner();
    await first.reconcileOrphanedOwnPortFittings();

    const proc = spawnSleeper();
    writeStatusFile(FITTING_B, proc.pid!);

    vi.resetModules();
    const reloaded = await import("@/lib/runner");
    await reloaded.reconcileOrphanedOwnPortFittings();
    // Grace window: a regressed sweep would SIGTERM within milliseconds.
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(alive(proc.pid!), "hot reload must not re-trigger the orphan sweep").toBe(true);
    expect(existsSync(path.join(sandbox, "ui-fittings", `${FITTING_B}.json`))).toBe(true);
  });

  it("the sweep skips fittings of a composition whose record is running", async () => {
    const proc = spawnSleeper();
    writeStatusFile(FITTING_B, proc.pid!);

    // Post-hot-reload world with the memo cleared: fresh module instance, but
    // globalThis carries a persisted runner record saying the default
    // composition (which the fitting belongs to) is running. The runtime
    // object is a plain global, so seed it directly.
    vi.resetModules();
    (globalThis as Record<string, unknown>).__agentGarrisonRunner = {
      records: new Map([
        [
          "default",
          {
            state: { compositionId: "default", status: "running", devMode: false, verifyResults: [] },
            logs: [],
            logBytes: 0,
            subscribers: new Set()
          }
        ]
      ])
    };
    const runner = await import("@/lib/runner");
    await runner.reconcileOrphanedOwnPortFittings();
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(alive(proc.pid!), "a running composition's fittings must survive the sweep").toBe(true);
    expect(existsSync(path.join(sandbox, "ui-fittings", `${FITTING_B}.json`))).toBe(true);
  });

  it("with no persisted records the sweep still reaps a true orphan", async () => {
    const proc = spawnSleeper();
    writeStatusFile(FITTING_B, proc.pid!);

    // Genuinely fresh process: empty records map, no memo.
    const runner = await freshRunner();
    await runner.reconcileOrphanedOwnPortFittings();
    await waitGone(proc.pid!);

    expect(alive(proc.pid!), "true orphan must still be reaped on a fresh process").toBe(false);
    expect(existsSync(path.join(sandbox, "ui-fittings", `${FITTING_B}.json`))).toBe(false);
  });
});
