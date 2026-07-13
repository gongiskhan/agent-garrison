// S3d (GARRISON-MARATHON-V3) — the gateway's OPT-IN Dispatcher hook (D6).
// The dispatcher path is additive and default-off: a RoutedGateway constructed
// without a dispatcher bundle has an inert dispatchRoute() and an unchanged
// classify(), so the 122-case classifier corpus and the gateway suite are
// untouched. When a dispatcher IS wired, dispatchRoute() runs the real
// dispatch-core over an injected garrison-call and logs routing evidence.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs routing layer
import { RoutedGateway } from "../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs";
// @ts-ignore — pure .mjs dispatch core (the real module, wired as the gateway would wire it)
import * as dispatchCore from "../fittings/seed/dispatcher/lib/dispatch-core.mjs";

function model() {
  return {
    duties: {
      code: {
        id: "code",
        title: "Code",
        description: "write or change software",
        levels: [
          { description: "trivial", cell: { target: "sdk-haiku", effort: "low" } },
          { description: "standard", cell: { target: "cc-sonnet", effort: "medium" } },
          { description: "deep", cell: { target: "cc-opus", effort: "high" } }
        ]
      },
      other: {
        id: "other",
        title: "Other",
        description: "anything else",
        levels: [
          { description: "trivial", cell: { target: "sdk-haiku", effort: "low" } },
          { description: "standard", cell: { target: "cc-sonnet", effort: "low" } },
          { description: "deep", cell: { target: "cc-sonnet", effort: "low" } }
        ]
      }
    },
    selectedDuties: ["code", "other"]
  };
}

describe("RoutedGateway dispatch hook (opt-in, default off)", () => {
  it("a gateway with no dispatcher wired has an inert dispatchRoute (classifier stays the default)", async () => {
    const gw = new RoutedGateway({ config: { taskTypes: [], tiers: [] } });
    expect(gw._dispatcher).toBeNull();
    await expect(gw.dispatchRoute("anything")).rejects.toThrow(/no Dispatcher wired/);
  });

  it("routes a message through the real dispatch-core when a dispatcher is wired, and logs digest-only evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-dispatch-"));
    const decisionsFile = join(dir, "decisions.jsonl");
    const call = async () => ({ ok: true, structured: { duty: "code", level: 3, confidence: "high", reason: "wide blast radius" } });
    const gw = new RoutedGateway({
      decisionsFile,
      nowFn: () => "2026-03-03T00:00:00Z",
      dispatcher: { core: dispatchCore, model: model(), call }
    });

    const out = await gw.dispatchRoute("re-architect the auth layer");
    expect(out.duty).toBe("code");
    expect(out.level).toBe(3);
    expect(out.confidence).toBe("high");
    expect(out.dispatchOk).toBe(true);

    expect(existsSync(decisionsFile)).toBe(true);
    const rec = JSON.parse(readFileSync(decisionsFile, "utf8").trim());
    expect(rec.kind).toBe("dispatch");
    expect(rec.duty).toBe("code");
    expect(rec.messageDigest).toBe(dispatchCore.messageDigest("re-architect the auth layer"));
    // the raw message must never reach the decisions log
    expect(readFileSync(decisionsFile, "utf8")).not.toContain("re-architect the auth layer");
  });

  it("a human 'run at level N' override wins over the model's pick", async () => {
    const call = async () => ({ ok: true, structured: { duty: "code", level: 3, confidence: "high", reason: "x" } });
    const gw = new RoutedGateway({
      decisionsFile: join(mkdtempSync(join(tmpdir(), "gw-dispatch-ov-")), "d.jsonl"),
      dispatcher: { core: dispatchCore, model: model(), call }
    });
    const out = await gw.dispatchRoute("re-architect but run at level 1");
    expect(out.duty).toBe("code");
    expect(out.level).toBe(1);
    expect(out.overridden).toBe(true);
    expect(out.overrideSource).toBe("message");
  });

  it("a card-level override is honored through the gateway", async () => {
    const call = async () => ({ ok: true, structured: { duty: "code", level: 3, confidence: "high", reason: "x" } });
    const gw = new RoutedGateway({
      decisionsFile: join(mkdtempSync(join(tmpdir(), "gw-dispatch-card-")), "d.jsonl"),
      dispatcher: { core: dispatchCore, model: model(), call }
    });
    const out = await gw.dispatchRoute("do the thing", { cardLevel: 2 });
    expect(out.level).toBe(2);
    expect(out.overrideSource).toBe("card");
  });
});
