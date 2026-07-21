// Run-entry self-heal for the Automations engine. The engine is a non-eager
// own-port fitting, so a redeploy's down() kills it; ensureAutomationsUp must
// then request Garrison's on-demand lifecycle start and wait for /health
// instead of failing the run with one incident per planned check. Without
// GARRISON_BASE_URL (fitting running outside Garrison) it fails exactly like
// the plain health check, and every failure keeps the "automations fitting
// not running" prefix the infra classifiers key automations-unavailable off.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - plain .mjs fitting module (see tests/drill-mjs.d.ts)
import { ensureAutomationsUp } from "../fittings/seed/drill/lib/automations-client.mjs";
import { terminalFromTransportError } from "../fittings/seed/drill/lib/run-outcome.mjs";

const GARRISON_BASE = "http://garrison.test";
const ENGINE_BASE = "http://automations.test";

let ghome: string;
const savedEnv: Record<string, string | undefined> = {};

function statusFilePath() {
  return path.join(ghome, "ui-fittings", "automations.json");
}

function writeStatusFile() {
  mkdirSync(path.dirname(statusFilePath()), { recursive: true });
  writeFileSync(statusFilePath(), JSON.stringify({ fittingId: "automations", url: ENGINE_BASE }));
}

interface FakeWorld {
  engineHealthy: boolean;
  startCalls: number;
  startBodies: unknown[];
  startResponse?: { status: number; body: unknown };
  onStart?: () => void;
}

function fakeFetch(world: FakeWorld) {
  const calls: string[] = [];
  const impl = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === `${ENGINE_BASE}/health`) {
      if (!world.engineHealthy) throw new Error("fetch failed");
      return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
    }
    if (url === `${GARRISON_BASE}/api/fittings/automations/start`) {
      world.startCalls += 1;
      world.startBodies.push(init?.body ? JSON.parse(init.body) : null);
      world.onStart?.();
      const r = world.startResponse ?? { status: 200, body: { ok: true, pid: 4242 } };
      return { ok: r.status < 400, status: r.status, json: async () => r.body };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

beforeEach(() => {
  ghome = mkdtempSync(path.join(tmpdir(), "garrison-drill-selfheal-"));
  for (const key of ["GARRISON_HOME", "GARRISON_BASE_URL", "GARRISON_AUTOMATIONS_URL"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.GARRISON_HOME = ghome;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(ghome, { recursive: true, force: true });
});

describe("ensureAutomationsUp", () => {
  it("returns without touching Garrison when the engine is already healthy", async () => {
    writeStatusFile();
    const world: FakeWorld = { engineHealthy: true, startCalls: 0, startBodies: [] };
    const { impl } = fakeFetch(world);
    process.env.GARRISON_BASE_URL = GARRISON_BASE;
    await expect(ensureAutomationsUp({ fetchImpl: impl })).resolves.toBe(true);
    expect(world.startCalls).toBe(0);
  });

  it("lifecycle-starts a dead engine via Garrison and waits for health", async () => {
    // No status file at entry - exactly the post-redeploy state. The start
    // call writes it (the spawn's status file) and flips health on.
    const world: FakeWorld = {
      engineHealthy: false,
      startCalls: 0,
      startBodies: [],
      onStart: () => {
        writeStatusFile();
        world.engineHealthy = true;
      }
    };
    const { impl, calls } = fakeFetch(world);
    process.env.GARRISON_BASE_URL = `${GARRISON_BASE}/`; // trailing slash must not double up
    await expect(ensureAutomationsUp({ fetchImpl: impl, timeoutMs: 3000, pollMs: 20 })).resolves.toBe(true);
    expect(world.startCalls).toBe(1);
    expect(calls).toContain(`POST ${GARRISON_BASE}/api/fittings/automations/start`);
    // The heal must never spawn an env-less engine: the start request asks
    // Garrison to refuse when no running composition provides the env.
    expect(world.startBodies[0]).toMatchObject({ requireCompositionEnv: true });
  });

  it("maps Garrison's no-composition 409 refusal into the classifier-prefixed failure", async () => {
    const world: FakeWorld = {
      engineHealthy: false,
      startCalls: 0,
      startBodies: [],
      startResponse: { status: 409, body: { error: "no running composition provides env for automations" } }
    };
    const { impl } = fakeFetch(world);
    process.env.GARRISON_BASE_URL = GARRISON_BASE;
    const err = await ensureAutomationsUp({ fetchImpl: impl }).then(
      () => null,
      (e: Error) => e
    );
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/^automations fitting not running \(auto-start failed:/);
    expect(err!.message).toContain("no running composition provides env for automations");
    expect(terminalFromTransportError(err!)).toMatchObject({
      component: "automations",
      code: "automations-unavailable"
    });
  });

  it("fails with the original discovery error when GARRISON_BASE_URL is absent", async () => {
    const world: FakeWorld = { engineHealthy: false, startCalls: 0, startBodies: [] };
    const { impl } = fakeFetch(world);
    await expect(ensureAutomationsUp({ fetchImpl: impl })).rejects.toThrow(
      /^automations fitting not running \(no GARRISON_AUTOMATIONS_URL/
    );
    expect(world.startCalls).toBe(0);
  });

  it("keeps the classifier prefix when the Garrison start fails", async () => {
    const world: FakeWorld = {
      engineHealthy: false,
      startCalls: 0,
      startBodies: [],
      startResponse: { status: 500, body: { error: "no running composition selects automations" } }
    };
    const { impl } = fakeFetch(world);
    process.env.GARRISON_BASE_URL = GARRISON_BASE;
    const err = await ensureAutomationsUp({ fetchImpl: impl }).then(
      () => null,
      (e: Error) => e
    );
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/^automations fitting not running \(auto-start failed:/);
    expect(err!.message).toContain("no running composition selects automations");
    // The preflight classifier must still bucket this as automations-unavailable.
    expect(terminalFromTransportError(err!)).toMatchObject({
      component: "automations",
      code: "automations-unavailable"
    });
  });

  it("keeps the classifier prefix when the started engine never becomes healthy", async () => {
    const world: FakeWorld = { engineHealthy: false, startCalls: 0, startBodies: [], onStart: () => writeStatusFile() };
    const { impl } = fakeFetch(world);
    process.env.GARRISON_BASE_URL = GARRISON_BASE;
    const err = await ensureAutomationsUp({ fetchImpl: impl, timeoutMs: 120, pollMs: 20 }).then(
      () => null,
      (e: Error) => e
    );
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/^automations fitting not running \(auto-start failed: engine not healthy/);
    expect(terminalFromTransportError(err!)).toMatchObject({
      component: "automations",
      code: "automations-unavailable"
    });
  });
});
