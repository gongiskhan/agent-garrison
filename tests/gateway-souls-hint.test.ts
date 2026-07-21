// FINDING 11 proof: the explicit {taskType,tier} classification hint the Kanban
// board POSTs to /chat must be HONORED in souls/orchestrator mode (not only in
// PTY-gateway mode). The souls-mode handler now resolves the hint through the
// SAME pure model-router resolver PTY mode uses (resolveRoute), so a composition
// switching to the souls stack does not silently break the board.
//
// We test the pure helper directly with the real seed routing config + the real
// resolveRoute — this is the "routing resolves correctly with the souls stack
// present" proof.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  parseClassificationHint,
  resolveSoulsHint,
} from "../fittings/seed/http-gateway/scripts/lib/souls-route.mjs";

const SEED_CONFIG = JSON.parse(
  readFileSync(
    path.resolve(__dirname, "../fittings/seed/orchestrator/config/routing.seed.json"),
    "utf8",
  ),
);

// resolveRoute is the PURE resolver the gateway injects (loaded via loadRoutingCore
// in production). Import it the same way the loader does — from the model-router
// fitting's routing-core — so the test exercises the real resolution.
const routingCore = await import(
  pathToFileURL(
    path.resolve(__dirname, "../fittings/seed/orchestrator/lib/routing-core.mjs"),
  ).href
);
const { resolveRoute } = routingCore as { resolveRoute: (c: any, p: any, cl: any) => any };

describe("souls-route — honoring the classification hint in souls mode", () => {
  it("(1) a valid in-vocab hint resolves correctly with the souls stack present", () => {
    // code × T2-deep → role expert; balanced profile maps expert → cc-opus-high.
    const out = resolveSoulsHint(
      { classification: { taskType: "code", tier: "T2-deep" } },
      SEED_CONFIG,
      resolveRoute,
    );
    expect(out).not.toBeNull();
    expect(out!.classification).toEqual({ taskType: "code", tier: "T2-deep" });
    expect(out!.role).toBe("expert");
    expect(out!.targetId).toBe("cc-opus-high");
    expect(out!.tier).toBe("T2-deep");
    expect(out!.model).toBe("opus");
    expect(out!.effort).toBe("high");
  });

  it("resolves a second in-vocab hint (review × T0-trivial → fast → cc-haiku-low)", () => {
    const out = resolveSoulsHint(
      { classification: { taskType: "review", tier: "T0-trivial" } },
      SEED_CONFIG,
      resolveRoute,
    );
    expect(out).not.toBeNull();
    expect(out!.role).toBe("fast");
    expect(out!.targetId).toBe("cc-haiku-low");
    expect(out!.model).toBe("haiku");
  });

  it("(2) an out-of-vocab / malformed hint returns null (falls back, never misroutes)", () => {
    // out-of-vocab taskType
    expect(
      resolveSoulsHint(
        { classification: { taskType: "nonsense", tier: "T2-deep" } },
        SEED_CONFIG,
        resolveRoute,
      ),
    ).toBeNull();
    // out-of-vocab tier
    expect(
      resolveSoulsHint(
        { classification: { taskType: "code", tier: "T9-impossible" } },
        SEED_CONFIG,
        resolveRoute,
      ),
    ).toBeNull();
    // no classification at all → null (exact prior behavior)
    expect(resolveSoulsHint({ message: "hi" }, SEED_CONFIG, resolveRoute)).toBeNull();
    expect(resolveSoulsHint({}, SEED_CONFIG, resolveRoute)).toBeNull();
  });

  it("resolveSoulsHint returns null when no resolver is injected (model-router absent)", () => {
    expect(
      resolveSoulsHint(
        { classification: { taskType: "code", tier: "T2-deep" } },
        SEED_CONFIG,
        undefined as any,
      ),
    ).toBeNull();
  });

  it("(3) parseClassificationHint rejects missing / non-string fields", () => {
    // missing tier
    expect(parseClassificationHint({ classification: { taskType: "code" } }, SEED_CONFIG)).toBeNull();
    // non-string fields
    expect(
      parseClassificationHint({ classification: { taskType: 1, tier: 2 } as any }, SEED_CONFIG),
    ).toBeNull();
    // classification not an object
    expect(parseClassificationHint({ classification: "code" as any }, SEED_CONFIG)).toBeNull();
    // absent
    expect(parseClassificationHint({}, SEED_CONFIG)).toBeNull();
    // out-of-vocab (the in-vocab guard, mirroring preRoute :492-502)
    expect(
      parseClassificationHint({ classification: { taskType: "code", tier: "bogus" } }, SEED_CONFIG),
    ).toBeNull();
  });

  it("parseClassificationHint honors ONLY {taskType,tier} and ignores a caller-supplied matchedException", () => {
    expect(
      parseClassificationHint({ classification: { taskType: "code", tier: "T1-standard" } }, SEED_CONFIG),
    ).toEqual({ taskType: "code", tier: "T1-standard" });
    // A caller cannot smuggle an exception in: matchedException is dropped, not trusted.
    expect(
      parseClassificationHint(
        { classification: { taskType: "review", tier: "T2-deep", matchedException: "ex-secrets" } },
        SEED_CONFIG,
      ),
    ).toEqual({ taskType: "review", tier: "T2-deep" });
  });

  it("a caller-supplied matchedException cannot bypass the matrix (resolves identically with or without it)", () => {
    const withException = resolveSoulsHint(
      { classification: { taskType: "code", tier: "T2-deep", matchedException: "ex-image" } },
      SEED_CONFIG,
      resolveRoute,
    );
    const without = resolveSoulsHint(
      { classification: { taskType: "code", tier: "T2-deep" } },
      SEED_CONFIG,
      resolveRoute,
    );
    expect(withException).toEqual(without);
    // Still the matrix result (expert/cc-opus-high), NOT a caller-forced exception role.
    expect(withException!.role).toBe("expert");
  });

  it("resolveSoulsHint returns null (no 500) when resolveRoute throws on a bad config", () => {
    const throwingResolver = () => {
      throw new Error("internally-inconsistent routing config");
    };
    expect(
      resolveSoulsHint(
        { classification: { taskType: "code", tier: "T2-deep" } },
        SEED_CONFIG,
        throwingResolver as any,
      ),
    ).toBeNull();
  });
});
