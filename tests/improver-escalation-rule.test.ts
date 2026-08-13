// The escalation-recurrence rule — the §2.3 loop, closed.
//
// The router may escalate one duty on one card, and by design that never writes
// back into the flow definition. So an escalation that keeps happening on the
// same work shape is the runtime telling you the DEFINITION is wrong, and every
// card in that group paid for a decision that should have been made once. Until
// now nothing read those records.
//
// Two things these tests are strict about:
//   • the grouping is a COPY of level-resolution.mjs's `summariseEscalations`
//     (cross-fitting imports are forbidden), so both are run over the same
//     records and asserted equal — a silent drift there would make the improver
//     propose things the router never did;
//   • the apply path really writes through the shell's policy API rather than
//     appending a note about it, which is what `applyVia: "PUT /routing"` has
//     been claiming and not doing.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// @ts-ignore - pure .mjs
import * as rule from "../fittings/seed/improver/lib/escalation-rule.mjs";
// @ts-ignore - pure .mjs
import * as levels from "../fittings/seed/orchestrator/lib/level-resolution.mjs";
// @ts-ignore - pure .mjs
import * as flowApply from "../fittings/seed/improver/lib/flow-apply.mjs";

const AT = "2026-08-13T09:00:00.000Z";

const escalation = (over: Record<string, unknown> = {}) => ({
  kind: "escalation",
  applied: true,
  flow: "fix",
  flowLevel: 1,
  duty: "review",
  to: 3,
  reason: "touched auth",
  cardId: "01J",
  ...over,
});

// A flow library with somewhere higher to go (level 2 exists above level 1).
const FLOWS = {
  fix: {
    defaultLevel: 1,
    levels: {
      "1": { duties: ["implement", "test"] },
      "2": { duties: ["implement", "test", "review"] },
      "3": { duties: ["plan", "implement", "test", "review"], pins: { "adversarial-review": 3 } },
    },
  },
};

describe("grouping parity with the orchestrator's level-resolution", () => {
  it("agrees with summariseEscalations record for record", () => {
    const records = [
      escalation(),
      escalation({ cardId: "02J", reason: "payment path" }),
      escalation({ cardId: "03J" }),
      escalation({ flow: "feature", duty: "test", to: 2, cardId: "04J" }),
      escalation({ applied: false, cardId: "05J" }), // rejected escalation: never counted
      { kind: "duty-route", flow: "fix", duty: "review" }, // not an escalation at all
    ];
    for (const threshold of [1, 2, 3, 5]) {
      expect(rule.summariseEscalations(records, { threshold })).toEqual(
        levels.summariseEscalations(records, { threshold })
      );
    }
  });

  it("an escalation the router REJECTED is not evidence", () => {
    const groups = rule.summariseEscalations([escalation({ applied: false }), escalation({ applied: false })], { threshold: 1 });
    expect(groups).toEqual([]);
  });
});

describe("proposals", () => {
  const groupsFor = (records: unknown[], threshold = 3) => rule.summariseEscalations(records, { threshold });

  it("below the threshold it proposes nothing", () => {
    const records = [escalation(), escalation({ cardId: "02J" })];
    const props = rule.analyzeEscalationProposals({ groups: groupsFor(records), flows: FLOWS, at: AT, threshold: 3 });
    expect(props).toEqual([]);
  });

  it("at the threshold it proposes the pin, with the exact edit attached", () => {
    const records = [escalation(), escalation({ cardId: "02J" }), escalation({ cardId: "03J" })];
    const props = rule.analyzeEscalationProposals({ groups: groupsFor(records), flows: FLOWS, at: AT, threshold: 3 });
    const pin = props.find((p: any) => p.id.startsWith("escalation-pin-"));
    expect(pin).toBeTruthy();
    expect(pin.rule).toBe("escalation");
    expect(pin.targetClass).toBe("orchestrator/flow");
    expect(pin.appliable).toBe(true);
    expect(pin.claim).toContain("3 separate fix cards");
    expect(pin.claim).toContain("touched auth");
    // The apply path reads THIS, never the prose.
    expect(pin.pinEdit).toEqual({ flow: "fix", flowLevel: "1", duty: "review", level: 3 });
    expect(pin.evidence.count).toBe(3);
    expect(pin.evidence.cardIds).toContain("01J");
  });

  it("also proposes the split reading, and refuses to apply it", () => {
    const records = [escalation(), escalation({ cardId: "02J" }), escalation({ cardId: "03J" })];
    const props = rule.analyzeEscalationProposals({ groups: groupsFor(records), flows: FLOWS, at: AT, threshold: 3 });
    const split = props.find((p: any) => p.id.startsWith("escalation-split-"));
    expect(split).toBeTruthy();
    // There is no mechanical edit for "this is a different kind of work", so it
    // must not offer to make one.
    expect(split.appliable).toBe(false);
    expect(split.pinEdit).toBeUndefined();
    expect(split.evidence.alternativeFlowLevel).toBe(2);
    expect(split.applyVia).toContain("manual");
  });

  it("no split variant when the escalation is already at the flow's top level", () => {
    // "Route it higher instead" has to name a level that exists.
    const topOnly = { fix: { levels: { "3": { duties: ["review"] } } } };
    const records = [escalation({ flowLevel: 3 }), escalation({ flowLevel: 3, cardId: "02J" }), escalation({ flowLevel: 3, cardId: "03J" })];
    const props = rule.analyzeEscalationProposals({ groups: groupsFor(records), flows: topOnly, at: AT, threshold: 3 });
    expect(props.filter((p: any) => p.id.startsWith("escalation-split-"))).toHaveLength(0);
    expect(props.filter((p: any) => p.id.startsWith("escalation-pin-"))).toHaveLength(1);
  });

  it("says nothing when the definition ALREADY pins the duty that high", () => {
    // Config has converged. Re-proposing it would put a permanent no-op in the
    // queue and make the improver look like it is arguing with itself.
    const pinned = { fix: { levels: { "1": { duties: ["implement"], pins: { review: 3 } }, "2": { duties: [] } } } };
    const records = [escalation(), escalation({ cardId: "02J" }), escalation({ cardId: "03J" })];
    expect(rule.analyzeEscalationProposals({ groups: groupsFor(records), flows: pinned, at: AT, threshold: 3 })).toEqual([]);
  });

  it("still proposes when the existing pin is LOWER than the escalation", () => {
    const pinned = { fix: { levels: { "1": { duties: ["implement"], pins: { review: 2 } }, "2": { duties: [] } } } };
    const records = [escalation(), escalation({ cardId: "02J" }), escalation({ cardId: "03J" })];
    const props = rule.analyzeEscalationProposals({ groups: groupsFor(records), flows: pinned, at: AT, threshold: 3 });
    const pin = props.find((p: any) => p.id.startsWith("escalation-pin-"));
    expect(pin.evidence.existingPin).toBe(2);
    expect(pin.diff).toContain("- 2");
    expect(pin.diff).toContain("+ 3");
  });

  it("an escalation missing its flow or target level proposes nothing", () => {
    const records = [escalation({ flow: null }), escalation({ flow: null, cardId: "02J" }), escalation({ flow: null, cardId: "03J" })];
    expect(rule.analyzeEscalationProposals({ groups: groupsFor(records), flows: FLOWS, at: AT, threshold: 3 })).toEqual([]);
  });

  it("proposal ids are stable for a given group", () => {
    const records = [escalation(), escalation({ cardId: "02J" }), escalation({ cardId: "03J" })];
    const a = rule.analyzeEscalationProposals({ groups: groupsFor(records), flows: FLOWS, at: AT, threshold: 3 });
    const b = rule.analyzeEscalationProposals({ groups: groupsFor([...records, escalation({ cardId: "04J" })]), flows: FLOWS, at: AT, threshold: 3 });
    expect(a.map((p: any) => p.id)).toEqual(b.map((p: any) => p.id));
  });
});

describe("collectors + threshold config", () => {
  let dir: string;
  const savedThreshold = process.env.IMPROVER_ESCALATION_THRESHOLD;
  const savedData = process.env.IMPROVER_DATA;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "gar-esc-"));
    mkdirSync(path.join(dir, ".garrison"), { recursive: true });
    delete process.env.IMPROVER_ESCALATION_THRESHOLD;
  });
  afterEach(() => {
    if (savedThreshold === undefined) delete process.env.IMPROVER_ESCALATION_THRESHOLD;
    else process.env.IMPROVER_ESCALATION_THRESHOLD = savedThreshold;
    if (savedData === undefined) delete process.env.IMPROVER_DATA;
    else process.env.IMPROVER_DATA = savedData;
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the composition's decisions.jsonl and its flow library", () => {
    const records = [escalation(), escalation({ cardId: "02J" }), escalation({ cardId: "03J" })];
    writeFileSync(
      path.join(dir, ".garrison", "decisions.jsonl"),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n{ malformed\n"
    );
    writeFileSync(path.join(dir, ".garrison", "routing.json"), JSON.stringify({ flows: FLOWS }));
    const res = rule.runEscalationRule({ now: AT, compositionDir: dir });
    expect(res.inputs.decisions).toBe(3); // the malformed line is skipped, never fatal
    expect(res.inputs.recurring).toBe(1);
    expect(res.proposals.map((p: any) => p.id.split("-")[1]).sort()).toEqual(["pin", "split"]);
  });

  it("an absent decisions log is silence, not an error", () => {
    const res = rule.runEscalationRule({ now: AT, compositionDir: dir });
    expect(res.proposals).toEqual([]);
    expect(res.inputs.decisions).toBe(0);
  });

  it("the threshold comes from the improver's own config: env, then the snapshot, then 3", () => {
    expect(rule.loadEscalationThreshold()).toBe(rule.DEFAULT_ESCALATION_THRESHOLD);
    process.env.IMPROVER_DATA = dir;
    writeFileSync(path.join(dir, "rule-config.json"), JSON.stringify({ escalationThreshold: 5 }));
    expect(rule.loadEscalationThreshold()).toBe(5);
    process.env.IMPROVER_ESCALATION_THRESHOLD = "2";
    expect(rule.loadEscalationThreshold()).toBe(2);
  });

  it("a lower threshold really does fire earlier", () => {
    writeFileSync(
      path.join(dir, ".garrison", "decisions.jsonl"),
      [escalation(), escalation({ cardId: "02J" })].map((r) => JSON.stringify(r)).join("\n")
    );
    writeFileSync(path.join(dir, ".garrison", "routing.json"), JSON.stringify({ flows: FLOWS }));
    expect(rule.runEscalationRule({ now: AT, compositionDir: dir, threshold: 3 }).proposals).toEqual([]);
    expect(rule.runEscalationRule({ now: AT, compositionDir: dir, threshold: 2 }).proposals.length).toBeGreaterThan(0);
  });
});

describe("the apply path talks to the shell, not to a markdown file", () => {
  const proposal = {
    id: "escalation-pin-abc",
    rule: "escalation",
    targetClass: "orchestrator/flow",
    pinEdit: { flow: "fix", flowLevel: "1", duty: "review", level: 3 },
    appliable: true,
  };
  // A routing config is an open document (the shell validates it, not this
  // test), so it is typed as such rather than pinned to the fixture's shape.
  const config = (): any => ({ flows: structuredClone(FLOWS) });
  const pinsAtLevel1 = (doc: any) => doc.flows.fix.levels["1"].pins;

  it("applyPinToConfig writes the pin and mutates nothing in place", () => {
    const before = config();
    const after = flowApply.applyPinToConfig(before, proposal.pinEdit);
    expect(pinsAtLevel1(after)).toEqual({ review: 3 });
    expect(pinsAtLevel1(before)).toBeUndefined();
  });

  it("refuses when the flow or level the pin names is gone", () => {
    expect(flowApply.applyPinToConfig({ flows: {} }, proposal.pinEdit)).toBeNull();
    expect(flowApply.applyPinToConfig(config(), { ...proposal.pinEdit, flowLevel: "9" })).toBeNull();
  });

  it("GETs the current policy, PUTs the edited one with its baseline", async () => {
    const calls: any[] = [];
    const fetchImpl = async (url: string, init: any = {}) => {
      calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
      if ((init.method ?? "GET") === "GET") {
        return { ok: true, status: 200, json: async () => ({ composition: "default", config: config(), baselineSha: "sha-1" }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, baselineSha: "sha-2" }) };
    };
    const res = await flowApply.applyFlowProposal({ proposal, compositionId: "default", base: "http://127.0.0.1:8777", fetchImpl });
    expect(res.ok).toBe(true);
    expect(calls[0].url).toBe("http://127.0.0.1:8777/api/orchestrator/policy?composition=default");
    expect(calls[1].method).toBe("PUT");
    expect(calls[1].body.baseline).toBe("sha-1");
    expect(calls[1].body.config.flows.fix.levels["1"].pins).toEqual({ review: 3 });
    expect(res.evidence.sha).toBe("sha-2");
    expect(res.evidence.pin).toEqual(proposal.pinEdit);
  });

  it("on a 409 it re-reads and re-applies onto the NEW document, once", async () => {
    // The guard exists to catch a concurrent edit; replaying the stale document
    // over it would defeat the guard we just obeyed.
    let gets = 0;
    let puts = 0;
    const fetchImpl = async (_url: string, init: any = {}) => {
      if ((init.method ?? "GET") === "GET") {
        gets += 1;
        const c = config();
        if (gets > 1) c.flows.fix.levels["2"].duties = ["implement", "test", "review", "validate"]; // someone else's edit
        return { ok: true, status: 200, json: async () => ({ composition: "default", config: c, baselineSha: `sha-${gets}` }) };
      }
      puts += 1;
      if (puts === 1) return { ok: false, status: 409, json: async () => ({ error: "conflict", currentSha: "sha-2" }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, baselineSha: "sha-3" }) };
    };
    const res = await flowApply.applyFlowProposal({ proposal, compositionId: "default", base: "http://x", fetchImpl });
    expect(res.ok).toBe(true);
    expect(res.recoveredFromConflict).toBe(true);
    expect(gets).toBe(2);
    expect(puts).toBe(2);
  });

  it("a second 409 gives up rather than looping", async () => {
    let puts = 0;
    const fetchImpl = async (_url: string, init: any = {}) => {
      if ((init.method ?? "GET") === "GET") {
        return { ok: true, status: 200, json: async () => ({ config: config(), baselineSha: "sha-1" }) };
      }
      puts += 1;
      return { ok: false, status: 409, json: async () => ({ error: "conflict" }) };
    };
    const res = await flowApply.applyFlowProposal({ proposal, base: "http://x", fetchImpl });
    expect(res).toMatchObject({ ok: false, code: "conflict" });
    expect(puts).toBe(2);
  });

  it("a 422 is terminal and carries the validator's reason", async () => {
    const fetchImpl = async (_url: string, init: any = {}) => {
      if ((init.method ?? "GET") === "GET") {
        return { ok: true, status: 200, json: async () => ({ config: config(), baselineSha: "sha-1" }) };
      }
      return { ok: false, status: 422, json: async () => ({ error: "invalid-config", errors: ["flows.fix.levels.1.pins.review: unknown duty"] }) };
    };
    const res = await flowApply.applyFlowProposal({ proposal, base: "http://x", fetchImpl });
    expect(res).toMatchObject({ ok: false, code: "invalid", terminal: true });
    expect(res.reason).toContain("unknown duty");
  });

  it("without a projected app URL it refuses instead of guessing a port", async () => {
    // A baked literal here would edit the WRONG INSTANCE's routing config.
    const res = await flowApply.applyFlowProposal({ proposal, base: "", fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
    expect(res).toMatchObject({ ok: false, code: "no-app-url" });
    expect(res.reason).toContain("re-up the composition");
  });

  it("refuses a manual-only proposal outright", async () => {
    const res = await flowApply.applyFlowProposal({
      proposal: { ...proposal, appliable: false },
      base: "http://x",
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    });
    expect(res).toMatchObject({ ok: false, code: "not-appliable" });
  });

  it("shellBaseUrl reads the runner-projected env and never falls back to a literal", () => {
    expect(flowApply.shellBaseUrl({})).toBe("");
    expect(flowApply.shellBaseUrl({ GARRISON_APP_URL: "http://127.0.0.1:8777/" })).toBe("http://127.0.0.1:8777");
    expect(flowApply.shellBaseUrl({ GARRISON_BASE_URL: "http://127.0.0.1:7777" })).toBe("http://127.0.0.1:7777");
  });
});
