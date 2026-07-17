import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// up() must NOT mass-boot every operative-bound own-port view — only the
// eager-toggled ones boot with the operative; the rest are on-demand from the
// Views UI (which gets the same runner env via operativeEnvForFitting).
// Regression gate for "restarting the operative brings up all the views".
//
// startOwnPortFitting is mocked (partial module mock) so no real fitting
// server ever spawns; everything else (composition read, library resolution,
// eager prefs under a sandbox GARRISON_HOME) is real. The two fitting ids are
// genuinely operative-bound members of the default composition.

const EAGER_ID = "dev-env";
const PLAIN_ID = "screen-share-default";

vi.mock("@/lib/own-port-lifecycle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/own-port-lifecycle")>();
  return {
    ...actual,
    startOwnPortFitting: vi.fn(async () => ({ ok: true, pid: 424242 }))
  };
});

import { startOwnPortFitting } from "@/lib/own-port-lifecycle";
import {
  startOperativeBoundFittings,
  operativeEnvForFitting
} from "@/lib/runner";
import { setEagerBoot } from "@/lib/eager-boot";

let sandbox: string;
const priorHome = process.env.GARRISON_HOME;

function seedRunningRecord(compositionId: string, gatewayBaseUrl?: string): void {
  (globalThis as Record<string, unknown>).__agentGarrisonRunner = {
    records: new Map([
      [
        compositionId,
        {
          state: { compositionId, status: "running", devMode: false, verifyResults: [] },
          logs: [],
          logBytes: 0,
          subscribers: new Set(),
          ...(gatewayBaseUrl ? { gateway: { baseUrl: gatewayBaseUrl } } : {})
        }
      ]
    ])
  };
}

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "garrison-up-eager-only-"));
  process.env.GARRISON_HOME = sandbox;
  vi.mocked(startOwnPortFitting).mockClear();
});

afterEach(() => {
  if (priorHome === undefined) {
    delete process.env.GARRISON_HOME;
  } else {
    process.env.GARRISON_HOME = priorHome;
  }
  delete (globalThis as Record<string, unknown>).__agentGarrisonRunner;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("up boots only eager views", () => {
  it("with no eager prefs, no own-port view is started — but every env is still built", async () => {
    const envByFitting = await startOperativeBoundFittings("default");

    expect(vi.mocked(startOwnPortFitting)).not.toHaveBeenCalled();
    // The env map still covers all operative-bound fittings so the in-up
    // eager boot (and its fingerprint) stays byte-identical.
    expect(envByFitting.has(EAGER_ID)).toBe(true);
    expect(envByFitting.has(PLAIN_ID)).toBe(true);
    expect(envByFitting.get(PLAIN_ID)?.GARRISON_COMPOSITION_ID).toBe("default");
    // The composition dir is projected too, so own-port servers (e.g. the
    // orchestrator router) key their config off the composition, not a
    // ~/.garrison fallback (config split-brain fix).
    expect(envByFitting.get(PLAIN_ID)?.GARRISON_COMPOSITION_DIR).toMatch(
      /compositions[/\\]default$/
    );
  });

  it("an eager-toggled view still boots with the operative; non-eager siblings do not", async () => {
    await setEagerBoot(EAGER_ID, true);

    const envByFitting = await startOperativeBoundFittings("default");

    const startedIds = vi
      .mocked(startOwnPortFitting)
      .mock.calls.map(([entry]) => (entry as { id: string }).id);
    expect(startedIds).toContain(EAGER_ID);
    expect(startedIds).not.toContain(PLAIN_ID);
    const eagerCall = vi
      .mocked(startOwnPortFitting)
      .mock.calls.find(([entry]) => (entry as { id: string }).id === EAGER_ID);
    expect((eagerCall?.[1] as Record<string, string>).GARRISON_COMPOSITION_ID).toBe("default");
    // heal-on-env-drift semantics preserved for the views up DOES manage
    expect(eagerCall?.[2]).toEqual({ healOnEnvDrift: true });
    expect(envByFitting.has(PLAIN_ID)).toBe(true);
  });
});

describe("operativeEnvForFitting (manual Views start env parity)", () => {
  it("returns null when no composition is running", async () => {
    delete (globalThis as Record<string, unknown>).__agentGarrisonRunner;
    expect(await operativeEnvForFitting(PLAIN_ID)).toBeNull();
  });

  it("returns the runner env — gateway URL + composition id — for a running composition's fitting", async () => {
    seedRunningRecord("default", "http://127.0.0.1:24777");
    const env = await operativeEnvForFitting(PLAIN_ID);
    expect(env).not.toBeNull();
    expect(env?.GARRISON_COMPOSITION_ID).toBe("default");
    expect(env?.GARRISON_COMPOSITION_DIR).toMatch(/compositions[/\\]default$/);
    expect(env?.GARRISON_GATEWAY_URL).toBe("http://127.0.0.1:24777");
  });

  it("omits the gateway URL when the running record has no gateway, and rejects unknown fittings", async () => {
    seedRunningRecord("default");
    const env = await operativeEnvForFitting(PLAIN_ID);
    expect(env).not.toBeNull();
    expect(env?.GARRISON_GATEWAY_URL).toBeUndefined();
    expect(await operativeEnvForFitting("not-a-selected-fitting")).toBeNull();
  });
});
