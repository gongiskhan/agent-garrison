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

function recordPath(compositionId: string, port?: number): string {
  const name = port === undefined ? `${compositionId}.json` : `${compositionId}-${port}.json`;
  return path.join(ghome, "gateway-pids", name);
}

// port omitted → the legacy composition-only file name.
function writeRecord(compositionId: string, record: Record<string, unknown>, port?: number): void {
  const file = recordPath(compositionId, port);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(record), "utf8");
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
    }, 4999);

    await reapRecordedGateway("gwreap-live", 4999);

    expect(await waitDead(pid, 3000)).toBe(true);
    expect(existsSync(recordPath("gwreap-live", 4999))).toBe(false);
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
    }, 4999);

    await reapRecordedGateway("gwreap-preboot", 4999);

    expect(pidAlive(pid)).toBe(true);
    expect(existsSync(recordPath("gwreap-preboot", 4999))).toBe(false);
  });

  it("is a no-op without a record", async () => {
    await expect(reapRecordedGateway("gwreap-none", 4999)).resolves.toBeUndefined();
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
    }, 4999);

    await reapRecordedGateway("gwreap-dead", 4999);

    expect(existsSync(recordPath("gwreap-dead", 4999))).toBe(false);
  });

  it("reaps a legacy composition-only record when its port matches", async () => {
    const pid = spawnDummy();
    writeRecord("gwreap-legacy", {
      pid,
      host: "127.0.0.1",
      port: 4999,
      startedAt: new Date().toISOString(),
      fittingId: "http-gateway"
    });

    await reapRecordedGateway("gwreap-legacy", 4999);

    expect(await waitDead(pid, 3000)).toBe(true);
    expect(existsSync(recordPath("gwreap-legacy"))).toBe(false);
  });

  it("never touches another instance's record on a different port", async () => {
    // Two Garrison checkouts share ~/.garrison and run the same composition id
    // on shifted ports; each reap must be blind to the other's gateway - both
    // the port-keyed record and a legacy record naming a different port.
    const otherPid = spawnDummy();
    writeRecord("gwreap-shared", {
      pid: otherPid,
      host: "127.0.0.1",
      port: 24999,
      startedAt: new Date().toISOString(),
      fittingId: "http-gateway"
    }, 24999);
    writeRecord("gwreap-shared", {
      pid: otherPid,
      host: "127.0.0.1",
      port: 24999,
      startedAt: new Date().toISOString(),
      fittingId: "http-gateway"
    });

    await reapRecordedGateway("gwreap-shared", 4999);

    expect(pidAlive(otherPid)).toBe(true);
    expect(existsSync(recordPath("gwreap-shared", 24999))).toBe(true);
    expect(existsSync(recordPath("gwreap-shared"))).toBe(true);
  });
});
