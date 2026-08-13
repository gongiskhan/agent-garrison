// The flow-compat mirrors must move in lockstep.
//
// The 2026-08-09 `workKind` -> `flow` rename needs a read-side shim in three
// places, and they cannot share an import: `src/` is the app, fittings are
// installed packages that cannot reach into `src/`, and the Kanban Loop reads a
// THIRD policy file (the compiled one under $GARRISON_HOME) that neither of the
// others touches. So the shim is deliberately mirrored — and a mirror that drifts
// is worse than no mirror at all, because the two halves would then disagree about
// what a legacy document means.
//
// This test is the thing that stops the drift. It pins all three copies to the same
// retired-key map and the same adoption semantics.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { RETIRED_FLOW_KEYS as TS_KEYS, adoptFlowKeys as tsAdopt, hasRetiredFlowKeys } from "@/lib/flow-compat";
// @ts-expect-error — plain .mjs fitting module, no types
import { RETIRED_FLOW_KEYS as MJS_KEYS, adoptFlowKeys as mjsAdopt } from "../fittings/seed/orchestrator/lib/flow-compat.mjs";
// @ts-expect-error — plain .mjs fitting module, no types
import { RETIRED_FLOW_KEYS as KANBAN_KEYS, adoptFlowKeys as kanbanAdopt } from "../fittings/seed/kanban-loop/lib/policy.mjs";
// @ts-ignore - pure .mjs
import * as boardPolicy from "../fittings/seed/kanban-loop/lib/policy.mjs";
// @ts-ignore - pure .mjs
import * as policyCore from "../fittings/seed/orchestrator/lib/policy-core.mjs";

const MIRRORS = [
  { name: "src/lib/flow-compat.ts", keys: TS_KEYS, adopt: tsAdopt },
  { name: "fittings/seed/orchestrator/lib/flow-compat.mjs", keys: MJS_KEYS, adopt: mjsAdopt },
  { name: "fittings/seed/kanban-loop/lib/policy.mjs", keys: KANBAN_KEYS, adopt: kanbanAdopt }
] as const;

describe("flow-compat mirrors", () => {
  it("agree on the retired-key map", () => {
    const expected = { workKinds: "flows", defaultWorkKind: "defaultFlow", workKind: "flow" };
    for (const m of MIRRORS) {
      expect({ ...m.keys }, `${m.name} retired-key map`).toEqual(expected);
    }
  });

  it("adopt a retired key and drop it, in every mirror", () => {
    for (const m of MIRRORS) {
      const out = m.adopt({ workKinds: { a: 1 }, defaultWorkKind: "a", workKind: "a", other: true });
      expect(out, m.name).toEqual({ flows: { a: 1 }, defaultFlow: "a", flow: "a", other: true });
    }
  });

  it("let the CURRENT key win when a document carries both", () => {
    // Nothing writes the retired key any more, so its presence beside the current
    // key means it is stale — taking the retired one would resurrect dead config.
    for (const m of MIRRORS) {
      const out = m.adopt({ flows: { new: 1 }, workKinds: { old: 1 } });
      expect(out, m.name).toEqual({ flows: { new: 1 } });
    }
  });

  it("return the input untouched when there is nothing to adopt", () => {
    for (const m of MIRRORS) {
      const input = { flows: {}, defaultFlow: "x" };
      expect(m.adopt(input), m.name).toBe(input); // same reference — no allocation
    }
  });

  it("never rewrite prose or nested values (shallow, key-exact)", () => {
    // A deep or regex rewrite would corrupt flow descriptions, card titles and
    // decision reasons — the exact silent data damage a rename must not cause.
    for (const m of MIRRORS) {
      const input = {
        flows: { "full-feature": { description: "the old workKind naming, preserved verbatim" } },
        title: "rename workKind to flow"
      };
      const out = m.adopt(input);
      expect((out as typeof input).flows["full-feature"].description, m.name).toBe(
        "the old workKind naming, preserved verbatim"
      );
      expect((out as typeof input).title, m.name).toBe("rename workKind to flow");
    }
  });

  it("pass through non-objects unharmed", () => {
    for (const m of MIRRORS) {
      for (const v of [null, undefined, 3, "workKind", [{ workKind: "a" }]]) {
        expect(m.adopt(v as never), `${m.name} ${JSON.stringify(v)}`).toBe(v);
      }
    }
  });

  it("hasRetiredFlowKeys reports un-migrated documents", () => {
    expect(hasRetiredFlowKeys({ workKinds: {} })).toBe(true);
    expect(hasRetiredFlowKeys({ flows: {} })).toBe(false);
    expect(hasRetiredFlowKeys(null)).toBe(false);
  });

  // The keys above renamed the CONTAINER (workKinds -> flows). The map below
  // renames the FLOWS THEMSELVES: the 2026-08-09 library rewrite retired six of
  // the nine names, and every card, decision record and saved rail on disk still
  // carries whichever name it was written with. Two mirrors here rather than
  // three - `src/` has no flow-name reader - and the failure mode is louder than
  // the key map's: an unaliased retired name reaches `config.flows[name]`,
  // resolves to nothing, and throws `policy: unknown flow` at the moment a card
  // is dispatched.
  it("the flow-NAME alias table is byte-equal in both mirrors", () => {
    expect({ ...boardPolicy.FLOW_ALIASES }).toEqual({ ...policyCore.FLOW_ALIASES });
    expect(Object.keys(policyCore.FLOW_ALIASES).length).toBeGreaterThan(0);
  });

  it("`channel` aliases to the MANUAL successor, in both mirrors", () => {
    // Pinned because the wrong answer is the tempting one. `task` is the closest
    // match by size and subject, and it is agentful; the retired `channel` flow
    // was manual-only. Aliasing onto `task` would quietly make a legacy channel
    // card dispatchable, which is a change to what the card MEANT - the thing an
    // alias exists to preserve. (tests/level-chain.test.ts pins the other half:
    // that the successor really is manual in the shipped library.)
    expect(policyCore.FLOW_ALIASES.channel).toBe("personal");
    expect(boardPolicy.FLOW_ALIASES.channel).toBe("personal");
  });

  it("both mirrors adopt a retired flow name and pass a live one through untouched", () => {
    for (const [retired, live] of Object.entries(policyCore.FLOW_ALIASES as Record<string, string>)) {
      expect(policyCore.adoptFlow(retired), `policy-core ${retired}`).toBe(live);
      expect(boardPolicy.adoptFlowValue(retired), `kanban ${retired}`).toBe(live);
    }
    for (const live of new Set(Object.values(policyCore.FLOW_ALIASES as Record<string, string>))) {
      expect(policyCore.adoptFlow(live), `policy-core ${live}`).toBe(live);
      expect(boardPolicy.adoptFlowValue(live), `kanban ${live}`).toBe(live);
    }
    // An unknown name is NOT an alias target: it comes back as written so the
    // caller can report it, rather than being folded into some default flow.
    expect(policyCore.adoptFlow("not-a-flow")).toBe("not-a-flow");
    expect(boardPolicy.adoptFlowValue("not-a-flow")).toBe("not-a-flow");
    for (const v of [null, undefined, 3, [{ flow: "a" }]]) {
      expect(policyCore.adoptFlow(v as never)).toBe(v);
      expect(boardPolicy.adoptFlowValue(v as never)).toBe(v);
    }
  });

  it("the rename gate declares exactly these three mirrors as the compat layer", () => {
    // If a fourth mirror is ever added it must be registered in BOTH places, or the
    // gate would silently permit retired names in a file this test does not cover.
    const gate = fs.readFileSync(path.join(process.cwd(), "scripts/check-flow-rename.mjs"), "utf8");
    for (const m of MIRRORS) expect(gate, `gate allowlist missing ${m.name}`).toContain(m.name);
  });
});
