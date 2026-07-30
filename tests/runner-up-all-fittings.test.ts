import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// up() boots EVERY own-port fitting of the composition — fittings share the
// operative's lifecycle, always (2026-07-29 fittings/views refit; the earlier
// eager-toggle model is gone). Regression gate for "a stationed fitting is
// silently left down after up".
//
// startOwnPortFitting is mocked (partial module mock) so no real fitting
// server ever spawns; everything else (composition read, library resolution,
// sandbox GARRISON_HOME) is real. The two fitting ids are genuinely own-port
// members of the default composition.

const FITTING_A = "dev-env";
const FITTING_B = "screen-share-default";

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
  sandbox = mkdtempSync(path.join(tmpdir(), "garrison-up-all-fittings-"));
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

describe("up boots every own-port fitting", () => {
  it("starts all own-port fittings of the composition with the projected env", async () => {
    const envByFitting = await startOperativeBoundFittings("default");

    const startedIds = vi
      .mocked(startOwnPortFitting)
      .mock.calls.map(([entry]) => (entry as { id: string }).id);
    expect(startedIds).toContain(FITTING_A);
    expect(startedIds).toContain(FITTING_B);
    for (const call of vi.mocked(startOwnPortFitting).mock.calls) {
      const env = call[1] as Record<string, string>;
      expect(env.GARRISON_COMPOSITION_ID).toBe("default");
      // heal-on-env-drift semantics: up knows the full desired env, so a
      // running fitting whose env drifted restarts with the fresh values.
      expect(call[2]).toEqual({ healOnEnvDrift: true });
    }

    // The env map covers every own-port fitting, byte-identical to what the
    // spawn received, so fingerprints can never drift between callers.
    expect(envByFitting.has(FITTING_A)).toBe(true);
    expect(envByFitting.has(FITTING_B)).toBe(true);
    expect(envByFitting.get(FITTING_B)?.GARRISON_COMPOSITION_ID).toBe("default");
    // The composition dir is projected too, so own-port servers (e.g. the
    // orchestrator router) key their config off the composition, not a
    // ~/.garrison fallback (config split-brain fix).
    expect(envByFitting.get(FITTING_B)?.GARRISON_COMPOSITION_DIR).toMatch(
      /compositions[/\\]default$/
    );
    // THIS instance's app URL is projected too: fittings that call back into
    // the garrison app (automations vision, drill curation) carry hardcoded
    // per-instance-wrong fallbacks, and a missing projection sent internal
    // calls to the OTHER instance's app, which 403s them.
    expect(envByFitting.get(FITTING_B)?.GARRISON_BASE_URL).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+$/
    );
  });
});

describe("operativeEnvForFitting (manual start env parity)", () => {
  it("returns null when no composition is running", async () => {
    delete (globalThis as Record<string, unknown>).__agentGarrisonRunner;
    expect(await operativeEnvForFitting(FITTING_B)).toBeNull();
  });

  it("returns the runner env — gateway URL + composition id — for a running composition's fitting", async () => {
    seedRunningRecord("default", "http://127.0.0.1:24777");
    const env = await operativeEnvForFitting(FITTING_B);
    expect(env).not.toBeNull();
    expect(env?.GARRISON_COMPOSITION_ID).toBe("default");
    expect(env?.GARRISON_COMPOSITION_DIR).toMatch(/compositions[/\\]default$/);
    expect(env?.GARRISON_GATEWAY_URL).toBe("http://127.0.0.1:24777");
    expect(env?.GARRISON_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("omits the gateway URL when the running record has no gateway, and rejects unknown fittings", async () => {
    seedRunningRecord("default");
    const env = await operativeEnvForFitting(FITTING_B);
    expect(env).not.toBeNull();
    expect(env?.GARRISON_GATEWAY_URL).toBeUndefined();
    expect(await operativeEnvForFitting("not-a-selected-fitting")).toBeNull();
  });
});
