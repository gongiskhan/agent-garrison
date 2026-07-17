import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reapRecordedGateway } from "@/lib/runner";

// The gateway child outlives the Garrison server process (a dead server takes
// the in-memory RunnerRecord with it, not the child). The on-disk pid record
// is the only handle a fresh server has on that orphan; these tests gate the
// reap that runs from down() and from spawnGateway()'s pre-flight.

let ghome: string;
let prevHome: string | undefined;
const survivors: number[] = [];

function recordPath(compositionId: string): string {
  return path.join(ghome, "gateway-pids", `${compositionId}.json`);
}

function writeRecord(compositionId: string, record: Record<string, unknown>): void {
  mkdirSync(path.dirname(recordPath(compositionId)), { recursive: true });
  writeFileSync(recordPath(compositionId), JSON.stringify(record), "utf8");
}

function spawnDummy(): number {
  const child = spawn("sleep", ["60"], { stdio: "ignore", detached: true });
  child.unref();
  survivors.push(child.pid!);
  return child.pid!;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !pidAlive(pid);
}

beforeEach(() => {
  ghome = mkdtempSync(path.join(os.tmpdir(), "garrison-gwreap-"));
  prevHome = process.env.GARRISON_HOME;
  process.env.GARRISON_HOME = ghome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = prevHome;
  for (const pid of survivors.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  rmSync(ghome, { recursive: true, force: true });
});

describe("recorded-gateway reap", () => {
  it("kills a live recorded gateway and clears the record", async () => {
    const pid = spawnDummy();
    writeRecord("gwreap-live", {
      pid,
      host: "127.0.0.1",
      port: 4999,
      startedAt: new Date().toISOString(),
      fittingId: "http-gateway"
    });

    await reapRecordedGateway("gwreap-live");

    expect(await waitDead(pid, 3000)).toBe(true);
    expect(existsSync(recordPath("gwreap-live"))).toBe(false);
  });

  it("never signals a pre-boot record's recycled pid, but still clears it", async () => {
    const pid = spawnDummy();
    // startedAt before the machine's last boot: the recorded pid cannot be
    // the same process anymore - signalling it could kill an innocent one.
    const preBoot = new Date(Date.now() - os.uptime() * 1000 - 60_000).toISOString();
    writeRecord("gwreap-preboot", {
      pid,
      host: "127.0.0.1",
      port: 4999,
      startedAt: preBoot,
      fittingId: "http-gateway"
    });

    await reapRecordedGateway("gwreap-preboot");

    expect(pidAlive(pid)).toBe(true);
    expect(existsSync(recordPath("gwreap-preboot"))).toBe(false);
  });

  it("is a no-op without a record", async () => {
    await expect(reapRecordedGateway("gwreap-none")).resolves.toBeUndefined();
  });

  it("clears a record whose pid is already dead", async () => {
    const pid = spawnDummy();
    process.kill(pid, "SIGKILL");
    await waitDead(pid, 2000);
    writeRecord("gwreap-dead", {
      pid,
      host: "127.0.0.1",
      port: 4999,
      startedAt: new Date().toISOString(),
      fittingId: "http-gateway"
    });

    await reapRecordedGateway("gwreap-dead");

    expect(existsSync(recordPath("gwreap-dead"))).toBe(false);
  });
});
