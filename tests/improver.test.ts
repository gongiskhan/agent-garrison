import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs
import { runImprover, proposeMemoryConsolidation, initRuleState, recordOutcome, setAutonomy, applyPromotion, upsertQueue, PROMOTION_THRESHOLD } from "../fittings/seed/improver/lib/improver-core.mjs";

const MEMORY = [
  { title: "PTY screen detection", hook: "reads the xterm screen not JSONL" },
  { title: "Warm pool cost", hook: "352 MB / 0 tokens idle" }
];

describe("Improver core proposals (MR5a — improver-proposal-ok)", () => {
  it("produces a memory-consolidation proposal from learned hints", () => {
    const r = runImprover({ memoryEntries: MEMORY, decisions: [{ targetId: "cc-opus-high" }], at: "2026-06-14T00:00:00Z" });
    expect(r.proposals).toHaveLength(1);
    const p = r.proposals[0];
    expect(p.rule).toBe("memory-consolidation");
    expect(p.targetClass).toBe("memory/vault");
    expect(p.claim).toContain("promote");
    expect(p.diff).toContain("PTY screen detection"); // a real diff
    expect(p.decision).toBeTruthy(); // one decision (Approve/Reject)
  });

  it("no learned hints → no proposal (no noise)", () => {
    expect(proposeMemoryConsolidation({ memoryEntries: [] })).toBeNull();
  });

  it("upsertQueue is idempotent by proposal id", () => {
    const p = proposeMemoryConsolidation({ memoryEntries: MEMORY });
    let q = upsertQueue([], p);
    q = upsertQueue(q, p);
    expect(q).toHaveLength(1);
    expect(q[0].status).toBe("pending");
  });
});

describe("Improver skip behaviour (MR5a — improver-skip-ok)", () => {
  it("vault locked → records skip, no proposals", () => {
    const r = runImprover({ memoryEntries: MEMORY, vaultLocked: true });
    expect(r.skipped).toBe("vault locked");
    expect(r.proposals).toEqual([]);
  });
  it("next server down → records skip", () => {
    expect(runImprover({ memoryEntries: MEMORY, serverUp: false }).skipped).toBe("next server down");
  });
});

describe("Improver autonomy lifecycle (MR5b — autonomy-promotion-ok / autonomy-demotion-ok)", () => {
  it("5 consecutive accepts emits a promotion suggestion; approving sets auto", () => {
    let s = initRuleState();
    let event = "none";
    for (let i = 0; i < PROMOTION_THRESHOLD; i++) {
      ({ state: s, event } = recordOutcome(s, "accept"));
    }
    expect(event).toBe("promotion-suggested");
    s = applyPromotion(s); // human approves the promotion
    expect(s.autonomy).toBe("auto");
  });

  it("a rule can be set auto directly with NO streak (human toggle)", () => {
    const s = setAutonomy(initRuleState(), "auto");
    expect(s.autonomy).toBe("auto");
  });

  it("rejecting an auto-applied change demotes to manual instantly", () => {
    let s = applyPromotion(initRuleState()); // auto
    const { state, event } = recordOutcome(s, "reject");
    expect(event).toBe("demoted");
    expect(state.autonomy).toBe("manual");
  });

  it("any reject resets the accept streak", () => {
    let s = initRuleState();
    ({ state: s } = recordOutcome(s, "accept"));
    ({ state: s } = recordOutcome(s, "accept"));
    ({ state: s } = recordOutcome(s, "reject"));
    expect(s.streak).toBe(0);
  });
});

describe("Improver CLI run-now (MR5a — end-to-end proposal + skip)", () => {
  const CLI = join(__dirname, "..", "fittings", "seed", "improver", "scripts", "improver.mjs");

  it("run-now produces a proposal artifact + a queue entry", () => {
    const data = mkdtempSync(join(tmpdir(), "gar-improver-"));
    const memory = join(data, "MEMORY.md");
    writeFileSync(memory, "- [Alpha](a.md) — hook a\n- [Beta](b.md) — hook b", "utf8");
    const out = execFileSync("node", [CLI, "run-now", "improver-nightly"], {
      env: { ...process.env, IMPROVER_DATA: data, IMPROVER_MEMORY: memory },
      encoding: "utf8"
    });
    expect(JSON.parse(out).proposals).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(data, "review-queue.json"))).toBe(true);
    expect(readdirSync(join(data, "proposals")).length).toBeGreaterThanOrEqual(1);
    const queue = JSON.parse(readFileSync(join(data, "review-queue.json"), "utf8"));
    expect(queue[0].status).toBe("pending");
  });

  it("run-now with a locked vault records skipped (no crash)", () => {
    const data = mkdtempSync(join(tmpdir(), "gar-improver-"));
    const memory = join(data, "MEMORY.md");
    writeFileSync(memory, "- [Alpha](a.md) — hook a", "utf8");
    const out = execFileSync("node", [CLI, "run-now"], {
      env: { ...process.env, IMPROVER_DATA: data, IMPROVER_MEMORY: memory, IMPROVER_VAULT_LOCKED: "1" },
      encoding: "utf8"
    });
    expect(JSON.parse(out).skipped).toBe("vault locked");
  });
});
