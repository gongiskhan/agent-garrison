import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression gate for the deselected-fitting orphan (the Jul 9 model-router
// squatting port 27087): the startup sweep used to enumerate ONLY the current
// compositions' selections, so a fitting Garrison had spawned but later
// deselected (or whose status slot was clobbered) was unreapable forever. The
// sweep enumerates ~/.garrison/ui-fittings/spawn/*.json - Garrison's own kill
// ledger. Since the 2026-07-29 fittings/views refit there are no eager or
// detached opt-outs: every own-port fitting shares the operative's lifecycle,
// so anything not protected by a RUNNING composition is reaped.

const GHOST_ID = "ghost-sweep-fixture"; // no library entry: a removed/deselected fitting
const LIBRARY_ID = "power-default"; // real own-port library entry

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

function writeSpawnRecordFile(fittingId: string, pid: number): void {
  const dir = path.join(sandbox, "ui-fittings", "spawn");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${fittingId}.json`),
    JSON.stringify({ fittingId, pid, startedAt: new Date().toISOString(), secretsDelivered: true })
  );
}

function spawnRecordFile(fittingId: string): string {
  return path.join(sandbox, "ui-fittings", "spawn", `${fittingId}.json`);
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
  vi.resetModules();
  delete (globalThis as Record<string, unknown>).__agentGarrisonRunner;
  return await import("@/lib/runner");
}

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "garrison-orphan-sweep-"));
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
  delete (globalThis as Record<string, unknown>).__agentGarrisonRunner;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("orphan sweep enumerates the spawn-record kill ledger", () => {
  it("reaps a live spawn-record orphan with no library entry and no composition selection", async () => {
    const ghostProc = spawnSleeper();
    writeSpawnRecordFile(GHOST_ID, ghostProc.pid!);

    const runner = await freshRunner();
    await runner.reconcileOrphanedOwnPortFittings();
    await waitGone(ghostProc.pid!);

    expect(alive(ghostProc.pid!), "deselected/unknown spawn-record orphan must be reaped").toBe(false);
    expect(existsSync(spawnRecordFile(GHOST_ID)), "its spawn record must be cleared").toBe(false);
  });

  it("reaps a library own-port fitting not protected by a running composition", async () => {
    const orphanProc = spawnSleeper();
    writeSpawnRecordFile(LIBRARY_ID, orphanProc.pid!);

    const runner = await freshRunner();
    await runner.reconcileOrphanedOwnPortFittings();
    await waitGone(orphanProc.pid!);

    expect(
      alive(orphanProc.pid!),
      "own-port fitting with no running composition must be reaped (fittings share the operative's lifecycle)"
    ).toBe(false);
    expect(existsSync(spawnRecordFile(LIBRARY_ID)), "its spawn record must be cleared").toBe(false);
  });
});
