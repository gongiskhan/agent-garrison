import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseGarrisonMetadata } from "@/lib/metadata";
import {
  healVaultConsumingFittings,
  spawnRecordPath,
  startOwnPortFitting,
  stopOwnPortFitting,
  type SpawnRecord
} from "@/lib/own-port-lifecycle";
import { ROOT_DIR } from "@/lib/paths";
import type { LibraryEntry } from "@/lib/types";

// Vault-heal gate — the fix for own-port Fittings spawned KEYLESS (a process
// that could not read the vault: locked vault, or the detached eager-boot
// child). startOwnPortFitting writes a Garrison-side spawn record at
// <ui-fittings>/spawn/<id>.json; when a vault-consuming Fitting is found
// running, a non-empty vault env is in hand, and the record says secrets were
// not delivered (missing record counts as not-delivered), the start HEALS:
// stops the keyless process and respawns with the secrets.
//
// Same sandbox pattern as tests/eager-boot.test.ts: real processes under a
// GARRISON_HOME tmp dir, fixture fittings inside the repo tree (start paths
// must live under ROOT_DIR), fixture start scripts honour GARRISON_HOME. The
// real deepgram-voice is never spawned (it writes to the real ~/.garrison and
// binds 7085); the fixture proves env delivery by writing a probe env var to
// a capture file.

const PROBE_KEY = "HEAL_PROBE_KEY";
const PROBE_VALUE = "test-secret-value";

vi.mock("@/lib/vault", () => ({
  readVaultSecrets: vi.fn(async () => [{ key: "HEAL_PROBE_KEY", value: "test-secret-value" }])
}));

// Writes the ui-fittings status file (removed on SIGTERM), captures the probe
// env var into <id>.env-capture.json, stays alive — the lifecycle contract
// every own-port fitting implements, plus the env proof this gate needs.
// With trapSigterm the fixture refuses to die on SIGTERM (a hung shutdown),
// forcing the heal path's SIGKILL escalation.
function fixtureStartMjs(fittingId: string, trapSigterm = false): string {
  const sigtermHandler = trapSigterm
    ? `process.on("SIGTERM", () => {
  // refuses to die — only SIGKILL works
});`
    : `process.on("SIGTERM", () => {
  try {
    rmSync(statusFile, { force: true });
  } catch {}
  process.exit(0);
});`;
  return `
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const FITTING_ID = ${JSON.stringify(fittingId)};
const home = process.env.GARRISON_HOME;
if (!home) {
  console.error("GARRISON_HOME not set");
  process.exit(1);
}

const uiDir = path.join(home, "ui-fittings");
mkdirSync(uiDir, { recursive: true });
writeFileSync(
  path.join(uiDir, FITTING_ID + ".env-capture.json"),
  JSON.stringify({ fittingId: FITTING_ID, pid: process.pid, probe: process.env.${PROBE_KEY} ?? null })
);
const statusFile = path.join(uiDir, FITTING_ID + ".json");
writeFileSync(
  statusFile,
  JSON.stringify({
    fittingId: FITTING_ID,
    port: 0,
    url: "http://127.0.0.1:0",
    pid: process.pid,
    startedAt: new Date().toISOString()
  })
);

${sigtermHandler}
setInterval(() => {}, 1 << 30);
`;
}

function makeEntry(id: string, fittingDir: string, consumesVault: boolean): LibraryEntry {
  return {
    id,
    name: id,
    faculty: "sessions",
    repo: "local",
    localPath: path.relative(ROOT_DIR, fittingDir),
    summary: "own-port fixture for the vault-heal gate",
    platforms: ["claude-code"],
    ratings: {},
    metadata: parseGarrisonMetadata({
      faculty: "sessions",
      cardinality_hint: "single",
      component_shape: "script",
      platforms: ["claude-code"],
      verify: { command: "node --version", expect: "v" },
      own_port: true,
      default_port: 7098,
      ...(consumesVault ? { consumes: [{ kind: "vault", cardinality: "one" }] } : {})
    })
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

// For waitFor predicates racing a child's writeFileSync: a missing or
// mid-write file reads as null instead of throwing out of the poll loop.
function readJsonSafe<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const VAULT_ID = "vault-heal-fixture";
const PLAIN_ID = "vault-heal-plain-fixture";
const STOPPED_ID = "vault-heal-stopped-fixture";
const TRAP_ID = "vault-heal-trap-fixture";

describe("vault heal (own-port spawn records + keyless re-delivery)", () => {
  let fixtureRoot: string;
  let vaultEntry: LibraryEntry;
  let plainEntry: LibraryEntry;
  let stoppedEntry: LibraryEntry;
  let trapEntry: LibraryEntry;

  let sandbox: string;
  const priorHome = process.env.GARRISON_HOME;
  const livePids: number[] = [];

  const statusFile = (id: string) => path.join(sandbox, "ui-fittings", `${id}.json`);
  const captureFile = (id: string) => path.join(sandbox, "ui-fittings", `${id}.env-capture.json`);
  const recordFile = (id: string) => path.join(sandbox, "ui-fittings", "spawn", `${id}.json`);

  function track(pid: number | undefined): number {
    expect(typeof pid).toBe("number");
    livePids.push(pid!);
    return pid!;
  }

  async function startRunning(entry: LibraryEntry, extraEnv: Record<string, string>): Promise<number> {
    const result = await startOwnPortFitting(entry, extraEnv);
    expect(result.ok).toBe(true);
    const pid = track(result.pid);
    await waitFor(() => existsSync(statusFile(entry.id)), `${entry.id} status file`);
    return pid;
  }

  beforeAll(() => {
    const cacheDir = path.join(ROOT_DIR, "node_modules", ".cache");
    mkdirSync(cacheDir, { recursive: true });
    fixtureRoot = mkdtempSync(path.join(cacheDir, "garrison-vault-heal-"));
    for (const id of [VAULT_ID, PLAIN_ID, TRAP_ID]) {
      const dir = path.join(fixtureRoot, id);
      mkdirSync(path.join(dir, "scripts"), { recursive: true });
      writeFileSync(path.join(dir, "scripts", "start.mjs"), fixtureStartMjs(id, id === TRAP_ID));
    }
    vaultEntry = makeEntry(VAULT_ID, path.join(fixtureRoot, VAULT_ID), true);
    plainEntry = makeEntry(PLAIN_ID, path.join(fixtureRoot, PLAIN_ID), false);
    trapEntry = makeEntry(TRAP_ID, path.join(fixtureRoot, TRAP_ID), true);
    // Never spawned — heal must not boot it, so its dir never needs to exist.
    stoppedEntry = makeEntry(STOPPED_ID, path.join(fixtureRoot, STOPPED_ID), true);
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), "garrison-vault-heal-"));
    process.env.GARRISON_HOME = sandbox;
  });

  afterEach(async () => {
    for (const pid of livePids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    const stillAlive = () => livePids.some(alive);
    if (stillAlive()) {
      await waitFor(() => !stillAlive(), "fixture processes to exit", 1500).catch(() => {});
    }
    // The trap fixture ignores SIGTERM by design; escalate rather than leak.
    for (const pid of livePids.filter(alive)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    if (stillAlive()) {
      await waitFor(() => !stillAlive(), "fixture processes to die after SIGKILL", 2000).catch(
        () => {}
      );
    }
    livePids.length = 0;
    if (priorHome === undefined) {
      delete process.env.GARRISON_HOME;
    } else {
      process.env.GARRISON_HOME = priorHome;
    }
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("writes a spawn record with secretsDelivered false for a keyless vault-consumer", async () => {
    const pid = await startRunning(vaultEntry, {});
    expect(spawnRecordPath(VAULT_ID)).toBe(recordFile(VAULT_ID));
    const record = readJson<SpawnRecord>(recordFile(VAULT_ID));
    expect(record.fittingId).toBe(VAULT_ID);
    expect(record.pid).toBe(pid);
    expect(record.secretsDelivered).toBe(false);
    expect(typeof record.startedAt).toBe("string");
  });

  it("writes secretsDelivered true when the env is non-empty, or when vault is not consumed", async () => {
    await startRunning(vaultEntry, { [PROBE_KEY]: PROBE_VALUE });
    expect(readJson<SpawnRecord>(recordFile(VAULT_ID)).secretsDelivered).toBe(true);

    await startRunning(plainEntry, {});
    expect(readJson<SpawnRecord>(recordFile(PLAIN_ID)).secretsDelivered).toBe(true);
  });

  it("stop removes the spawn record", async () => {
    await startRunning(vaultEntry, {});
    expect(existsSync(recordFile(VAULT_ID))).toBe(true);
    const stopped = await stopOwnPortFitting(VAULT_ID);
    expect(stopped.ok).toBe(true);
    expect(existsSync(recordFile(VAULT_ID))).toBe(false);
  });

  it("heals a running keyless vault-consumer when secrets arrive: new pid, env reaches the child", async () => {
    const oldPid = await startRunning(vaultEntry, {});
    await waitFor(() => existsSync(captureFile(VAULT_ID)), "keyless env capture");
    expect(readJson<{ probe: string | null }>(captureFile(VAULT_ID)).probe).toBeNull();

    const result = await startOwnPortFitting(vaultEntry, { [PROBE_KEY]: PROBE_VALUE });
    expect(result.ok).toBe(true);
    expect(result.healed).toBe(true);
    expect(result.alreadyRunning).toBeUndefined();
    const newPid = track(result.pid);
    expect(newPid).not.toBe(oldPid);

    await waitFor(() => !alive(oldPid), "keyless process to die");
    await waitFor(
      () => readJsonSafe<{ probe: string | null }>(captureFile(VAULT_ID))?.probe === PROBE_VALUE,
      "healed env capture"
    );
    const capture = readJson<{ pid: number; probe: string }>(captureFile(VAULT_ID));
    expect(capture.pid).toBe(newPid);
    // The new record says delivered, so the heal can never loop.
    expect(readJson<SpawnRecord>(recordFile(VAULT_ID)).secretsDelivered).toBe(true);
  });

  it("a missing spawn record counts as not-delivered (pre-fix spawns heal too)", async () => {
    const oldPid = await startRunning(vaultEntry, {});
    rmSync(recordFile(VAULT_ID), { force: true });

    const result = await startOwnPortFitting(vaultEntry, { [PROBE_KEY]: PROBE_VALUE });
    expect(result.ok).toBe(true);
    expect(result.healed).toBe(true);
    track(result.pid);
    await waitFor(() => !alive(oldPid), "keyless process to die");
  });

  it("leaves a running keyless vault-consumer alone when the env is empty", async () => {
    const pid = await startRunning(vaultEntry, {});

    for (const env of [{}, undefined]) {
      const result = await startOwnPortFitting(vaultEntry, env);
      expect(result.ok).toBe(true);
      expect(result.alreadyRunning).toBe(true);
      expect(result.healed).toBeUndefined();
    }
    expect(alive(pid)).toBe(true);
    expect(readJson<{ pid: number }>(statusFile(VAULT_ID)).pid).toBe(pid);
  });

  it("leaves a running fitting alone when the record says secrets were delivered", async () => {
    const pid = await startRunning(vaultEntry, { [PROBE_KEY]: "first-delivery" });

    const result = await startOwnPortFitting(vaultEntry, { [PROBE_KEY]: "second-delivery" });
    expect(result.ok).toBe(true);
    expect(result.alreadyRunning).toBe(true);
    expect(result.healed).toBeUndefined();
    expect(alive(pid)).toBe(true);
    expect(readJson<{ probe: string }>(captureFile(VAULT_ID)).probe).toBe("first-delivery");
  });

  it("serializes concurrent starts: exactly one heal, no second spawn, healed child not SIGTERMed", async () => {
    const oldPid = await startRunning(vaultEntry, {});

    const [a, b] = await Promise.all([
      startOwnPortFitting(vaultEntry, { [PROBE_KEY]: PROBE_VALUE }),
      startOwnPortFitting(vaultEntry, { [PROBE_KEY]: PROBE_VALUE })
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const healedResults = [a, b].filter((r) => r.healed === true);
    const alreadyResults = [a, b].filter((r) => r.alreadyRunning === true);
    expect(healedResults).toHaveLength(1);
    expect(alreadyResults).toHaveLength(1);
    // The serialized loser spawned nothing.
    expect(alreadyResults[0].pid).toBeUndefined();

    const newPid = track(healedResults[0].pid);
    await waitFor(() => !alive(oldPid), "keyless process to die");
    expect(alive(newPid)).toBe(true);
    await waitFor(
      () => readJsonSafe<{ pid: number }>(statusFile(VAULT_ID))?.pid === newPid,
      "healed status file"
    );
    const record = readJson<SpawnRecord>(recordFile(VAULT_ID));
    expect(record.pid).toBe(newPid);
    expect(record.secretsDelivered).toBe(true);
  });

  it("pid mismatch — restarted outside Garrison — defeats a stale delivered record and heals", async () => {
    // A delivered run exits OUTSIDE Garrison: the fixture removes its status
    // file on SIGTERM, but Garrison's spawn record (secretsDelivered: true)
    // survives because stopOwnPortFitting never ran.
    const firstPid = await startRunning(vaultEntry, { [PROBE_KEY]: "old-delivery" });
    process.kill(firstPid, "SIGTERM");
    await waitFor(() => !alive(firstPid), "external exit");
    await waitFor(() => !existsSync(statusFile(VAULT_ID)), "status file removal");
    expect(readJson<SpawnRecord>(recordFile(VAULT_ID)).secretsDelivered).toBe(true);

    // Keyless relaunch outside Garrison: live status pid != recorded pid.
    const external = spawn(
      process.execPath,
      [path.join(fixtureRoot, VAULT_ID, "scripts", "start.mjs")],
      { cwd: path.join(fixtureRoot, VAULT_ID), env: { ...process.env }, stdio: "ignore" }
    );
    const externalPid = track(external.pid);
    await waitFor(
      () => readJsonSafe<{ pid: number }>(statusFile(VAULT_ID))?.pid === externalPid,
      "external relaunch status file"
    );

    // secretsDelivered:true alone is not believed: the recorded pid is not
    // the live process, so this run's env is unknown — heal.
    const result = await startOwnPortFitting(vaultEntry, { [PROBE_KEY]: PROBE_VALUE });
    expect(result.ok).toBe(true);
    expect(result.healed).toBe(true);
    const newPid = track(result.pid);
    await waitFor(() => !alive(externalPid), "externally-relaunched process to die");
    await waitFor(
      () => readJsonSafe<{ probe: string | null }>(captureFile(VAULT_ID))?.probe === PROBE_VALUE,
      "healed env capture"
    );
    expect(readJson<SpawnRecord>(recordFile(VAULT_ID)).pid).toBe(newPid);
  });

  it("a Garrison stop after an external exit still removes the spawn record", async () => {
    const pid = await startRunning(vaultEntry, { [PROBE_KEY]: PROBE_VALUE });
    process.kill(pid, "SIGTERM");
    await waitFor(() => !alive(pid), "external exit");
    await waitFor(() => !existsSync(statusFile(VAULT_ID)), "status file removal");
    expect(existsSync(recordFile(VAULT_ID))).toBe(true);

    const stopped = await stopOwnPortFitting(VAULT_ID);
    expect(stopped.ok).toBe(true);
    expect(stopped.wasRunning).toBe(false);
    // The stale secretsDelivered:true record is gone — it can no longer mask
    // a future keyless run.
    expect(existsSync(recordFile(VAULT_ID))).toBe(false);
  });

  it(
    "escalates to SIGKILL when the old process traps SIGTERM, then heals",
    async () => {
      const oldPid = await startRunning(trapEntry, {});

      const result = await startOwnPortFitting(trapEntry, { [PROBE_KEY]: PROBE_VALUE });
      expect(result.ok).toBe(true);
      expect(result.healed).toBe(true);
      const newPid = track(result.pid);
      // The respawn only happened because the SIGTERM-trapping process was
      // SIGKILLed first.
      expect(alive(oldPid)).toBe(false);
      await waitFor(
        () => readJsonSafe<{ probe: string | null }>(captureFile(TRAP_ID))?.probe === PROBE_VALUE,
        "healed env capture"
      );
      expect(readJson<{ pid: number }>(captureFile(TRAP_ID)).pid).toBe(newPid);
      expect(readJson<SpawnRecord>(recordFile(TRAP_ID)).secretsDelivered).toBe(true);
    },
    20000
  );

  it(
    "reports heal failure honestly when the old process cannot die: no respawn, no delivered record",
    async () => {
      const oldPid = await startRunning(vaultEntry, {});
      // SIGKILL survival cannot be fixtured (SIGKILL is untrappable), so make
      // the pid immortal at the API boundary: liveness probes say alive,
      // signals are swallowed. Everything below process.kill is real.
      const realKill = process.kill.bind(process);
      const killSpy = vi
        .spyOn(process, "kill")
        .mockImplementation((pid: number, signal?: string | number) => {
          if (pid === oldPid) return true;
          return realKill(pid, signal);
        });
      try {
        const result = await startOwnPortFitting(vaultEntry, { [PROBE_KEY]: PROBE_VALUE });
        expect(result.ok).toBe(false);
        expect(result.status).toBe(500);
        expect(result.error).toMatch(/survived SIGTERM and SIGKILL/);
        expect(result.healed).toBeUndefined();
        expect(result.pid).toBeUndefined();
        // No new child, and no record claiming the secrets arrived.
        expect(existsSync(recordFile(VAULT_ID))).toBe(false);
        expect(
          killSpy.mock.calls.filter(([pid, signal]) => pid === oldPid && signal === "SIGKILL")
        ).toHaveLength(1);
      } finally {
        killSpy.mockRestore();
      }
      // The old process really is still alive (its signals were swallowed).
      expect(alive(oldPid)).toBe(true);
    },
    20000
  );

  it("healVaultConsumingFittings surfaces start failures in failed[] and warns", async () => {
    const BROKEN_ID = "vault-heal-broken-fixture";
    // "Running" (live pid in the status file) but unhealable: no start
    // script. process.pid is never signalled — start fails before the heal
    // stop runs.
    const brokenEntry = makeEntry(BROKEN_ID, path.join(fixtureRoot, BROKEN_ID), true);
    mkdirSync(path.join(sandbox, "ui-fittings"), { recursive: true });
    writeFileSync(
      statusFile(BROKEN_ID),
      JSON.stringify({
        fittingId: BROKEN_ID,
        port: 0,
        url: "http://127.0.0.1:0",
        pid: process.pid,
        startedAt: new Date().toISOString()
      })
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const summary = await healVaultConsumingFittings({ library: [brokenEntry] });
      expect(summary.healed).toEqual([]);
      expect(summary.skipped).toEqual([]);
      expect(summary.failed).toHaveLength(1);
      expect(summary.failed[0].id).toBe(BROKEN_ID);
      expect(summary.failed[0].error).toContain("no start script");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(BROKEN_ID));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("healVaultConsumingFittings heals only RUNNING vault-consumers; unlock never boots a stopped one", async () => {
    const keylessPid = await startRunning(vaultEntry, {});
    const plainPid = await startRunning(plainEntry, {});

    const summary = await healVaultConsumingFittings({
      library: [vaultEntry, stoppedEntry, plainEntry]
    });
    expect(summary.healed).toEqual([VAULT_ID]);
    expect(summary.skipped).toEqual([STOPPED_ID]);
    expect(summary.failed).toEqual([]);

    await waitFor(() => !alive(keylessPid), "keyless process to die");
    await waitFor(() => {
      const status = readJsonSafe<{ pid: number }>(statusFile(VAULT_ID));
      return status !== null && status.pid !== keylessPid;
    }, "healed status file");
    track(readJson<{ pid: number }>(statusFile(VAULT_ID)).pid);
    await waitFor(
      () => readJsonSafe<{ probe: string | null }>(captureFile(VAULT_ID))?.probe === PROBE_VALUE,
      "healed env capture"
    );
    // The non-vault fitting is untouched; the stopped one was never started.
    expect(alive(plainPid)).toBe(true);
    await sleep(300);
    expect(existsSync(statusFile(STOPPED_ID))).toBe(false);
    expect(existsSync(recordFile(STOPPED_ID))).toBe(false);
  });

  it("a stale spawn record never vouches for a reused pid: no kill, fresh spawn", async () => {
    // Simulates the post-reboot shape: a record left behind (no status file)
    // whose pid the OS has since handed to an UNRELATED process. The record is
    // older than the boot window, so it must not count as "running" — acting
    // on it would kill the unrelated process or refuse a legitimate start.
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
      stdio: "ignore"
    });
    const unrelatedPid = track(unrelated.pid);
    mkdirSync(path.join(sandbox, "ui-fittings", "spawn"), { recursive: true });
    writeFileSync(
      recordFile(VAULT_ID),
      JSON.stringify({
        fittingId: VAULT_ID,
        pid: unrelatedPid,
        startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        secretsDelivered: false
      })
    );

    const result = await startOwnPortFitting(vaultEntry, { [PROBE_KEY]: PROBE_VALUE });
    expect(result.ok).toBe(true);
    expect(result.alreadyRunning).toBeUndefined();
    expect(result.healed).toBeUndefined();
    const newPid = track(result.pid);
    expect(newPid).not.toBe(unrelatedPid);
    // The unrelated process was never signalled.
    expect(alive(unrelatedPid)).toBe(true);
    // The stale record was replaced by the fresh spawn's record.
    await waitFor(
      () => readJsonSafe<SpawnRecord>(recordFile(VAULT_ID))?.pid === newPid,
      "fresh spawn record"
    );
  });

  it("onlyIfRunning does nothing for a stopped fitting", async () => {
    const result = await startOwnPortFitting(stoppedEntry, { [PROBE_KEY]: PROBE_VALUE }, {
      onlyIfRunning: true
    });
    expect(result.ok).toBe(true);
    expect(result.notRunning).toBe(true);
    expect(result.pid).toBeUndefined();
    expect(existsSync(statusFile(STOPPED_ID))).toBe(false);
    expect(existsSync(recordFile(STOPPED_ID))).toBe(false);
  });

  it("the spawn/ subdir is invisible to the /api/fittings/views status enumeration", async () => {
    const uiDir = path.join(sandbox, "ui-fittings");
    mkdirSync(path.join(uiDir, "spawn"), { recursive: true });
    writeFileSync(
      path.join(uiDir, "some-fitting.json"),
      JSON.stringify({
        fittingId: "some-fitting",
        port: 65000,
        url: "http://127.0.0.1:65000",
        pid: 12345,
        startedAt: new Date().toISOString()
      })
    );
    writeFileSync(
      path.join(uiDir, "spawn", "deepgram-voice.json"),
      JSON.stringify({
        fittingId: "deepgram-voice",
        pid: 54321,
        startedAt: new Date().toISOString(),
        secretsDelivered: false
      })
    );

    const { GET } = await import("@/app/api/fittings/views/route");
    const response = await GET();
    const body = (await response.json()) as { views: Array<{ fittingId: string }> };
    expect(body.views.map((v) => v.fittingId)).toEqual(["some-fitting"]);
  });

  it("the logs route reads through the status-dir contract (GARRISON_HOME-aware)", async () => {
    const uiDir = path.join(sandbox, "ui-fittings");
    mkdirSync(uiDir, { recursive: true });
    writeFileSync(path.join(uiDir, "some-fitting.log"), "hello from sandbox\n");

    const { GET } = await import("@/app/api/fittings/[id]/logs/route");
    const response = await GET(new Request("http://localhost/api/fittings/some-fitting/logs"), {
      params: { id: "some-fitting" }
    });
    const body = (await response.json()) as { exists: boolean; content: string };
    expect(body.exists).toBe(true);
    expect(body.content).toBe("hello from sandbox\n");
  });
});
