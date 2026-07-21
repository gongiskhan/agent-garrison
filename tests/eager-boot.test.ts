import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  eagerBootPrefsPath,
  isEagerBoot,
  readEagerBootPrefs,
  runEagerBoot,
  setEagerBoot
} from "@/lib/eager-boot";
import { parseGarrisonMetadata } from "@/lib/metadata";
import { logFilePath } from "@/lib/own-port-lifecycle";
import { ROOT_DIR } from "@/lib/paths";
import type { LibraryEntry } from "@/lib/types";
import { writeViewState } from "@/lib/view-state";

// W3 gate — eager-boot toggles + the real boot sequence.
//
// Real on-disk store under a sandbox GARRISON_HOME; the own-port fitting is a
// minimal REAL process (a fixture start.mjs spawned for real through
// startOwnPortFitting) that rehydrates from the REAL view-state dir and writes
// the same status-file contract the terminal does. Nothing on the persistence
// path is mocked. Sentinels for the goal evaluator (printed only after the
// assertions pass): EAGER_BOOT_OK <view>, LAZY_RESTORE_OK <view>.
//
// startOwnPortFitting refuses paths outside the repo root, so the fixture
// fitting lives under node_modules/.cache (inside ROOT_DIR, never committed)
// rather than os.tmpdir().

const FIXTURE_ID = "eager-boot-fixture";

// On boot: read persisted instances from the real view-state store, record the
// rehydrated ids in an active-instances marker, write the ui-fittings status
// file, stay alive until SIGTERM (which removes the status file) — the same
// lifecycle contract the terminal fitting implements.
const FIXTURE_START_MJS = `
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const FITTING_ID = ${JSON.stringify(FIXTURE_ID)};
const home = process.env.GARRISON_HOME;
if (!home) {
  console.error("GARRISON_HOME not set");
  process.exit(1);
}

const stateDir = path.join(home, "view-state", FITTING_ID);
let instanceIds = [];
try {
  instanceIds = readdirSync(stateDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
} catch {
  // no persisted instances yet
}
const active = instanceIds.map((instanceId) => {
  const envelope = JSON.parse(readFileSync(path.join(stateDir, instanceId + ".json"), "utf8"));
  return envelope.instanceId ?? instanceId;
});

const uiDir = path.join(home, "ui-fittings");
mkdirSync(uiDir, { recursive: true });
writeFileSync(
  path.join(uiDir, FITTING_ID + ".active.json"),
  JSON.stringify({ fittingId: FITTING_ID, active }, null, 2)
);
const statusFile = path.join(uiDir, FITTING_ID + ".json");
writeFileSync(
  statusFile,
  JSON.stringify(
    {
      fittingId: FITTING_ID,
      port: 0,
      url: "http://127.0.0.1:0",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      gatewayUrl: process.env.GARRISON_GATEWAY_URL ?? null,
      compositionId: process.env.GARRISON_COMPOSITION_ID ?? null
    },
    null,
    2
  )
);

process.on("SIGTERM", () => {
  try {
    rmSync(statusFile, { force: true });
  } catch {}
  process.exit(0);
});
setInterval(() => {}, 1 << 30);
`;

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

describe("eager boot (Layer 3)", () => {
  let fixtureRoot: string;
  let fittingDir: string;
  let startScript: string;
  let ownPortEntry: LibraryEntry;
  let embeddedEntry: LibraryEntry;

  let sandbox: string;
  const priorHome = process.env.GARRISON_HOME;
  const livePids: number[] = [];
  const children: ChildProcess[] = [];

  const statusFile = () => path.join(sandbox, "ui-fittings", `${FIXTURE_ID}.json`);
  const markerFile = () => path.join(sandbox, "ui-fittings", `${FIXTURE_ID}.active.json`);

  beforeAll(() => {
    const cacheDir = path.join(ROOT_DIR, "node_modules", ".cache");
    mkdirSync(cacheDir, { recursive: true });
    fixtureRoot = mkdtempSync(path.join(cacheDir, "garrison-eager-boot-"));
    fittingDir = path.join(fixtureRoot, FIXTURE_ID);
    startScript = path.join(fittingDir, "scripts", "start.mjs");
    mkdirSync(path.dirname(startScript), { recursive: true });
    writeFileSync(startScript, FIXTURE_START_MJS);

    ownPortEntry = {
      id: FIXTURE_ID,
      name: "Eager Boot Fixture",
      faculty: "sessions",
      repo: "local",
      localPath: path.relative(ROOT_DIR, fittingDir),
      summary: "own-port fixture for the eager-boot gate",
      platforms: ["claude-code"],
      ratings: {},
      metadata: parseGarrisonMetadata({
        faculty: "sessions",
        cardinality_hint: "single",
        component_shape: "script",
        platforms: ["claude-code"],
        verify: { command: "node --version", expect: "v" },
        own_port: true,
        default_port: 7099
      })
    };

    embeddedEntry = {
      id: "embedded-fixture",
      name: "Embedded Fixture",
      faculty: "sessions",
      repo: "local",
      localPath: path.relative(ROOT_DIR, fittingDir),
      summary: "embedded fixture for the eager-boot gate",
      platforms: ["claude-code"],
      ratings: {},
      metadata: parseGarrisonMetadata({
        faculty: "sessions",
        cardinality_hint: "single",
        component_shape: "script",
        platforms: ["claude-code"],
        verify: { command: "node --version", expect: "v" },
        ui: {
          views: [{ id: "main", placement: "sidebar-surface", entry: "./ui/Main.tsx", route: "/" }]
        }
      })
    };
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    // Defensive: the status dir honours GARRISON_HOME (garrisonDir()), so
    // spawn logs land in the sandbox — but if a spec ever runs without the
    // override, don't leave a stray log in the real ~/.garrison.
    rmSync(logFilePath(FIXTURE_ID), { force: true });
  });

  beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), "garrison-eager-boot-"));
    process.env.GARRISON_HOME = sandbox;
  });

  afterEach(async () => {
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
    children.length = 0;
    for (const pid of livePids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    // Let SIGTERM handlers run before the sandbox is removed under them.
    const stillAlive = () =>
      livePids.some((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
    if (stillAlive()) {
      await waitFor(() => !stillAlive(), "fixture processes to exit", 4000).catch(() => {});
    }
    livePids.length = 0;
    if (priorHome === undefined) {
      delete process.env.GARRISON_HOME;
    } else {
      process.env.GARRISON_HOME = priorHome;
    }
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("toggle on -> runEagerBoot starts the own-port fitting, which rehydrates its persisted instance (EAGER_BOOT_OK)", async () => {
    // Seed a persisted instance through the real store, then boot for real.
    await writeViewState(FIXTURE_ID, "sess-1", { cwd: "/tmp/restored-place" });
    await setEagerBoot(FIXTURE_ID, true);

    const summary = await runEagerBoot({ library: [ownPortEntry] });
    expect(summary.booted).toEqual([FIXTURE_ID]);
    expect(summary.warmed).toEqual([]);
    expect(summary.skipped).toEqual([]);

    await waitFor(
      () => existsSync(statusFile()) && existsSync(markerFile()),
      "fixture status + active-instances marker"
    );
    const status = readJson<{ fittingId: string; pid: number }>(statusFile());
    expect(status.fittingId).toBe(FIXTURE_ID);
    expect(typeof status.pid).toBe("number");
    livePids.push(status.pid);
    // The process is genuinely alive, not just a stale file.
    expect(() => process.kill(status.pid, 0)).not.toThrow();

    const marker = readJson<{ active: string[] }>(markerFile());
    expect(marker.active).toContain("sess-1");
    console.log(`EAGER_BOOT_OK ${FIXTURE_ID}`);
  });

  it("toggle off -> runEagerBoot leaves it cold; opening lazily still restores state (LAZY_RESTORE_OK)", async () => {
    await writeViewState(FIXTURE_ID, "sess-2", { cwd: "/tmp/lazy-place" });
    await setEagerBoot(FIXTURE_ID, true);
    await setEagerBoot(FIXTURE_ID, false);

    const summary = await runEagerBoot({ library: [ownPortEntry] });
    expect(summary.booted).toEqual([]);
    expect(summary.warmed).toEqual([]);
    expect(summary.skipped).toEqual([]);
    // Nothing was spawned: no status file appears even after a grace period.
    await sleep(400);
    expect(existsSync(statusFile())).toBe(false);
    expect(existsSync(markerFile())).toBe(false);

    // "Open" the view: the lazy path starts the fitting on demand, and the
    // always-on persistence still restores the instance.
    const child = spawn(process.execPath, [startScript], {
      cwd: fittingDir,
      env: { ...process.env },
      stdio: "ignore"
    });
    children.push(child);
    await waitFor(() => existsSync(markerFile()), "lazy-open active-instances marker");
    const marker = readJson<{ active: string[] }>(markerFile());
    expect(marker.active).toContain("sess-2");
    console.log(`LAZY_RESTORE_OK ${FIXTURE_ID}`);
  });

  it("passes the runner-provided extraEnv to the spawned fitting (eager respawns are not gatewayless)", async () => {
    await setEagerBoot(FIXTURE_ID, true);

    const summary = await runEagerBoot({
      library: [ownPortEntry],
      extraEnv: {
        GARRISON_GATEWAY_URL: "http://127.0.0.1:49777",
        GARRISON_COMPOSITION_ID: "default"
      },
      // Per-fitting env (the runner's own operative-bound env) wins over the
      // flat fallback, keeping the fingerprints of both callers identical.
      extraEnvById: {
        [FIXTURE_ID]: {
          GARRISON_GATEWAY_URL: "http://127.0.0.1:48777",
          GARRISON_COMPOSITION_ID: "default"
        }
      }
    });
    expect(summary.booted).toEqual([FIXTURE_ID]);

    await waitFor(() => existsSync(statusFile()), "fixture status file");
    const status = readJson<{ pid: number; gatewayUrl: string | null; compositionId: string | null }>(
      statusFile()
    );
    livePids.push(status.pid);
    expect(status.gatewayUrl).toBe("http://127.0.0.1:48777");
    expect(status.compositionId).toBe("default");
  });

  it("prefs round-trip on disk; invalid ids are rejected", async () => {
    expect(await readEagerBootPrefs()).toEqual({ version: 1, eager: {} });
    expect(await isEagerBoot("fit-a")).toBe(false);

    let prefs = await setEagerBoot("fit-a", true);
    expect(prefs).toEqual({ version: 1, eager: { "fit-a": true } });
    expect(await isEagerBoot("fit-a")).toBe(true);
    // The documented on-disk contract: { version: 1, eager: { [id]: true } }
    // at the view-state root.
    expect(eagerBootPrefsPath()).toBe(path.join(sandbox, "view-state", "eager-boot.json"));
    expect(readJson(eagerBootPrefsPath())).toEqual({ version: 1, eager: { "fit-a": true } });

    prefs = await setEagerBoot("fit-a", false);
    expect(prefs).toEqual({ version: 1, eager: {} });
    expect(await isEagerBoot("fit-a")).toBe(false);

    await expect(setEagerBoot("../evil", true)).rejects.toThrow(/invalid fitting id/);
    await expect(setEagerBoot(".hidden", true)).rejects.toThrow(/invalid fitting id/);
    await expect(setEagerBoot("a/b", true)).rejects.toThrow(/invalid fitting id/);
  });

  it("embedded fittings are warmed (no process to start); unknown ids are skipped", async () => {
    await writeViewState("embedded-fixture", "tab-1", { selection: ["a.ts"] });
    await setEagerBoot("embedded-fixture", true);
    await setEagerBoot("ghost-fitting", true);

    const summary = await runEagerBoot({ library: [embeddedEntry] });
    expect(summary.warmed).toEqual(["embedded-fixture"]);
    expect(summary.skipped).toEqual(["ghost-fitting"]);
    expect(summary.booted).toEqual([]);
    // No process, no status file — embedded views restore in-browser on open.
    expect(existsSync(path.join(sandbox, "ui-fittings"))).toBe(false);
  });

  it("a corrupt prefs file reads as empty, never crashes the boot path", async () => {
    mkdirSync(path.dirname(eagerBootPrefsPath()), { recursive: true });
    writeFileSync(eagerBootPrefsPath(), "{ not json ");
    expect(await readEagerBootPrefs()).toEqual({ version: 1, eager: {} });
    const summary = await runEagerBoot({ library: [ownPortEntry] });
    expect(summary).toEqual({ booted: [], warmed: [], skipped: [], failed: [] });
  });
});
