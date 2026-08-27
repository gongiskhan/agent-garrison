import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  reapRecordedGateway,
  stopChild,
  withRunnerOperation,
  writeGatewayPidRecord
} from "@/lib/runner";

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
  it("serializes lifecycle mutations for the same composition", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const first = withRunnerOperation("gw-serialized", async () => {
      order.push("first:start");
      markFirstStarted();
      await firstGate;
      order.push("first:end");
    });
    await firstStarted;
    const second = withRunnerOperation("gw-serialized", async () => {
      order.push("second:start");
      order.push("second:end");
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["first:start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end"
    ]);
  });

  it("publishes one immutable PID owner and refuses a racing overwrite", async () => {
    await writeGatewayPidRecord("gw-publish", {
      pid: 111,
      host: "127.0.0.1",
      port: 4999,
      startedAt: new Date().toISOString(),
      fittingId: "http-gateway"
    });

    await expect(
      writeGatewayPidRecord("gw-publish", {
        pid: 222,
        host: "127.0.0.1",
        port: 4999,
        startedAt: new Date().toISOString(),
        fittingId: "http-gateway"
      })
    ).rejects.toMatchObject({ code: "EEXIST" });

    expect(JSON.parse(readFileSync(recordPath("gw-publish", 4999), "utf8")).pid).toBe(111);
  });

  it("recovers abandoned lock artifacts without letting racing publishers overlap", async () => {
    const lockRoot = path.join(ghome, "gateway-pids");
    const ticketDir = path.join(lockRoot, "gw-lock-recovery-4999.lock.d");
    mkdirSync(ticketDir, { recursive: true });
    // The old shared-file implementation could crash after O_EXCL creation but
    // before valid owner JSON was durable. Its abandoned file must no longer
    // wedge the new ticket lock.
    writeFileSync(path.join(lockRoot, "gw-lock-recovery-4999.lock"), "", "utf8");
    // A fully-published ticket from a dead process is independently reclaimable;
    // unique ticket paths mean two contenders can never unlink a successor.
    writeFileSync(
      path.join(ticketDir, "2147483647-abandoned.json"),
      JSON.stringify({
        pid: 2147483647,
        token: "abandoned",
        choosing: false,
        ticket: 1,
        createdAt: Date.now()
      }),
      "utf8"
    );

    const records = [333, 444].map((pid) => ({
      pid,
      host: "127.0.0.1",
      port: 4999,
      startedAt: new Date().toISOString(),
      fittingId: "http-gateway"
    }));
    const outcomes = await Promise.allSettled(
      records.map((record) => writeGatewayPidRecord("gw-lock-recovery", record))
    );

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect([333, 444]).toContain(
      JSON.parse(readFileSync(recordPath("gw-lock-recovery", 4999), "utf8")).pid
    );
  });

  it("does not report an unconfirmed child termination as success", async () => {
    const fake = new EventEmitter() as EventEmitter & {
      pid: number;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: ReturnType<typeof vi.fn>;
    };
    fake.pid = 987654;
    fake.exitCode = null;
    fake.signalCode = null;
    fake.kill = vi.fn(() => true);

    await expect(
      stopChild(fake as unknown as ChildProcessWithoutNullStreams, {
        forceAfterMs: 5,
        timeoutMs: 25
      })
    ).rejects.toThrow(/did not confirm exit/);
    expect(fake.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(fake.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

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
