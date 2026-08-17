import { describe, it, expect } from "vitest";
import { railBadges, effortState } from "../packages/claude-chat/src/run-context";
import { routeChipFromAttribution } from "../packages/claude-chat/src/sanitize";
import type { RailBadge } from "../packages/claude-chat/src/run-context";
import type { RouteAttribution } from "../packages/claude-chat/src/transport";

const keys = (bs: RailBadge[]) => bs.map((b) => b.key);
const byKey = (bs: RailBadge[], key: string) => bs.find((b) => b.key === key);

// A fully-attributed Anthropic turn: every dimension the gateway can report.
const FULL: RouteAttribution = {
  route: "cc-sonnet-med",
  runtime: "agent-sdk",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  effort: "high",
  effortApplied: true,
  taskType: "code",
  tier: "T1-standard",
  ruleId: "duty:plan/L2/review",
  profile: "balanced",
  honored: true,
  duty: "plan",
  level: 2,
  phase: "review",
  skill: null,
  via: "duty-cell",
  account: "work",
  accountSource: "target",
  project: "garrison",
  projectPath: "/home/ggomes/dev/garrison",
  sessionId: "sess-1",
};

describe("claude-chat run context: railBadges omission discipline", () => {
  it("emits nothing at all for an empty attribution", () => {
    expect(railBadges({})).toEqual([]);
  });

  it("omits every badge whose field is absent rather than showing a placeholder", () => {
    const badges = railBadges({ runtime: "codex", model: "gpt-5" });
    expect(keys(badges)).toEqual(["runtime", "model"]);
    // No "unknown", no "-", no empty-string label anywhere.
    for (const b of badges) {
      expect(b.label.trim()).not.toBe("");
      expect(b.label).not.toMatch(/unknown|n\/a|undefined|null/i);
      expect(b.title.trim()).not.toBe("");
    }
  });

  it("treats blank strings and nulls as absent (no whitespace badges)", () => {
    expect(
      railBadges({ route: "  ", runtime: null, model: "", duty: "  ", project: null, card: "" })
    ).toEqual([]);
  });

  it("orders the badges meaning-first, provenance-last", () => {
    expect(keys(railBadges(FULL))).toEqual([
      "duty",
      "skill",
      "runtime",
      "model",
      "effort",
      "account",
      "project",
      // `tier` earned its own badge once it became settable (RUN-SPEC-V1): it is
      // half the {taskType, tier} key the matrix resolves on. It sits just before
      // `target` because it is an input to the routing decision, not an outcome.
      "tier",
      "target",
      "transcript",
    ]);
  });

  it("badges the phase plan from either half, and never invents one", () => {
    // A plain conversational turn walks no pipeline: no plan, no badge.
    expect(keys(railBadges({ runtime: "codex" }))).toEqual(["runtime"]);
    // A named flow with nothing turned off.
    const named = railBadges({ flow: "full-feature" }).find((b) => b.key === "flow");
    expect(named?.label).toBe("full-feature");
    expect(named?.title).toContain("every phase in the plan runs");
    // The OFF count rides the label, because it is the part that changes what runs.
    const trimmed = railBadges({ flow: "full-feature", phasesOff: "review,walkthrough" }).find(
      (b) => b.key === "flow"
    );
    expect(trimmed?.label).toBe("full-feature -2");
    expect(trimmed?.title).toContain("phases off: review, walkthrough");
    expect(trimmed?.tone).toBe("warn");
    // An orchestrator-inferred plan has NO flow - it is not one of the named
    // kinds. Requiring one would blank the badge on exactly the auto turns it
    // exists to explain, so the OFF count stands alone.
    const inferred = railBadges({ phasesOff: "walkthrough" }).find((b) => b.key === "flow");
    expect(inferred?.label).toBe("plan -1");
    expect(inferred?.title).toContain("flow derived by the router");
  });

  it("says so on the tier badge when no classifier ran", () => {
    const skipped = railBadges({ tier: "T2-deep", taskType: "implement", classifierSkipped: true }).find(
      (b) => b.key === "tier"
    );
    expect(skipped?.title).toContain("no classifier ran");
    const classified = railBadges({ tier: "T2-deep", taskType: "implement" }).find((b) => b.key === "tier");
    expect(classified?.title).not.toContain("no classifier ran");
  });
});

describe("claude-chat run context: duty and skill", () => {
  it("renders duty + level, and appends the phase only when it differs from the duty", () => {
    // preRouteV4 defaults phase to the duty, so an equal phase carries no signal.
    expect(byKey(railBadges({ duty: "plan", level: 2, phase: "plan" }), "duty")?.label).toBe("plan L2");
    expect(byKey(railBadges({ duty: "plan", level: 2, phase: "review" }), "duty")?.label).toBe("plan L2 /review");
    expect(byKey(railBadges({ duty: "develop" }), "duty")?.label).toBe("develop");
  });

  it("drops a non-integer or zero level rather than rendering L0", () => {
    expect(byKey(railBadges({ duty: "plan", level: 0 }), "duty")?.label).toBe("plan");
    expect(byKey(railBadges({ duty: "plan", level: null }), "duty")?.label).toBe("plan");
  });

  it("says 'skill: none' when the duty is known but no skill is bound", () => {
    const b = byKey(railBadges({ duty: "plan", skill: null }), "skill");
    expect(b?.label).toBe("skill: none");
    expect(b?.tone).toBe("dim");
    expect(b?.title).toContain("inline definition");
  });

  // Reload parity. The gateway sends `skill: null`, but the thread store drops
  // explicit nulls, so a reloaded turn carries skill as UNDEFINED. Both spellings
  // must render the same badge or the same turn would say "skill: none" live and
  // say nothing after a refresh.
  it("says 'skill: none' for an absent skill too, so a reloaded turn matches a live one", () => {
    expect(byKey(railBadges({ duty: "plan" }), "skill")?.label).toBe("skill: none");
    expect(byKey(railBadges({ duty: "plan", skill: null }), "skill")?.label).toBe(
      byKey(railBadges({ duty: "plan" }), "skill")?.label
    );
  });

  it("has no skill badge when there is no duty to attach it to", () => {
    expect(byKey(railBadges({ skill: null }), "skill")).toBeUndefined();
    expect(byKey(railBadges({}), "skill")).toBeUndefined();
  });

  it("names a real skill when one is stationed", () => {
    expect(byKey(railBadges({ duty: "plan", skill: "garrison-plan" }), "skill")?.label).toBe("skill: garrison-plan");
  });
});

describe("claude-chat run context: the three effort states", () => {
  it("shows a bare effort when the runtime applied it", () => {
    const b = byKey(railBadges({ effort: "high", effortApplied: true }), "effort");
    expect(b?.label).toBe("high");
    expect(b?.tone).toBeUndefined();
    expect(effortState({ effort: "high", effortApplied: true })).toBe("applied");
  });

  it("warns when the provider refused it", () => {
    const b = byKey(railBadges({ effort: "high", effortApplied: false }), "effort");
    expect(b?.label).toBe("high (not applied)");
    expect(b?.tone).toBe("warn");
    expect(effortState({ effort: "high", effortApplied: false })).toBe("refused");
  });

  it("dims it when application truth was never reported", () => {
    const b = byKey(railBadges({ effort: "high", effortApplied: null }), "effort");
    expect(b?.label).toBe("high (unverified)");
    expect(b?.tone).toBe("dim");
    expect(effortState({ effort: "high" })).toBe("unverified");
  });

  it("has no effort badge and no effort state when none was requested", () => {
    expect(byKey(railBadges({ effortApplied: true }), "effort")).toBeUndefined();
    expect(effortState({})).toBeNull();
  });
});

describe("claude-chat run context: account", () => {
  it("names the account and records its source in the tooltip", () => {
    const b = byKey(railBadges({ account: "work", accountSource: "override" }), "account");
    expect(b?.label).toBe("work");
    expect(b?.title).toBe("account work - source override");
  });

  it("reads 'machine login' for an explicit null - the absence IS the fact", () => {
    const b = byKey(railBadges({ account: null }), "account");
    expect(b?.label).toBe("machine login");
    expect(b?.tone).toBe("dim");
  });

  it("omits the badge when the lane never reported an account at all", () => {
    expect(byKey(railBadges({ runtime: "gemini" }), "account")).toBeUndefined();
  });
});

describe("claude-chat run context: link and action badges", () => {
  it("links the card badge at the url the producer already host-rewrote", () => {
    const b = byKey(railBadges({ card: "K-42", cardUrl: "https://box.ts.net:8081/card/K-42" }), "card");
    expect(b?.label).toBe("card K-42");
    expect(b?.tone).toBe("link");
    expect(b?.href).toBe("https://box.ts.net:8081/card/K-42");
    expect(b?.title).toContain("kanban board");
  });

  it("still renders the card badge without an href when no url came through", () => {
    const b = byKey(railBadges({ card: "K-42" }), "card");
    expect(b?.label).toBe("card K-42");
    expect(b?.href).toBeUndefined();
  });

  it("offers the transcript drill-down only when a session id exists (codex/gemini report none)", () => {
    const withId = byKey(railBadges({ sessionId: "sess-9", transcriptPath: "/x/sess-9.jsonl" }), "transcript");
    expect(withId?.action).toBe("transcript");
    expect(withId?.label).toBe("transcript");
    expect(withId?.title).toContain("sess-9");
    expect(byKey(railBadges({ runtime: "codex", sessionId: null }), "transcript")).toBeUndefined();
  });

  it("keeps the absolute cwd in the project tooltip and never in an href", () => {
    const b = byKey(railBadges(FULL), "project");
    expect(b?.label).toBe("garrison");
    expect(b?.title).toBe("project garrison - cwd /home/ggomes/dev/garrison");
    expect(b?.href).toBeUndefined();
  });

  it("puts the unsettable classification fields in the target tooltip", () => {
    const b = byKey(railBadges(FULL), "target");
    expect(b?.label).toBe("cc-sonnet-med");
    expect(b?.tone).toBe("dim");
    expect(b?.title).toBe(
      "target cc-sonnet-med - rule duty:plan/L2/review - profile balanced - via duty-cell - tier T1-standard - task code - honored: yes"
    );
  });

  it("carries the provider in the model tooltip, not a badge of its own", () => {
    expect(byKey(railBadges(FULL), "model")?.title).toBe("model claude-sonnet-4-5 - provider anthropic");
    expect(byKey(railBadges(FULL), "provider")).toBeUndefined();
  });
});

describe("claude-chat run context: stopped and overrides", () => {
  it("says who stopped the turn, with the reason when there is one", () => {
    const plain = byKey(railBadges({ stoppedByUser: true }), "stopped");
    expect(plain?.label).toBe("stopped by you");
    expect(plain?.tone).toBe("warn");
    const reasoned = byKey(railBadges({ stoppedByUser: true, stoppedReason: "timeout" }), "stopped");
    expect(reasoned?.label).toBe("stopped: timeout");
    expect(byKey(railBadges({ stoppedByUser: false }), "stopped")).toBeUndefined();
  });

  it("lists the applied overrides on one badge", () => {
    const b = byKey(railBadges({ overridesApplied: ["target", "effort"] }), "override");
    expect(b?.label).toBe("override: target, effort");
  });

  it("names each rejected override separately instead of pretending it was honored", () => {
    const badges = railBadges({
      overridesApplied: ["target"],
      overridesRejected: [
        { field: "effort", reason: "provider-has-no-effort-control" },
        { field: "project", reason: "project-not-a-git-repo-under-dev-root" },
      ],
    });
    // Rejections lead: the rail is one horizontally-scrolling row, so a warning
    // appended after the informational badges is only findable by scrolling
    // sideways (measured at x≈1492 in a 1280px viewport before this ordering).
    expect(keys(badges)).toEqual([
      "override-rejected:effort",
      "override-rejected:project",
      "override",
    ]);
    expect(badges[0].label).toBe("override rejected: provider-has-no-effort-control");
    expect(badges[0].tone).toBe("warn");
    expect(badges[1].title).toContain("your pinned project was refused");
  });

  it("puts every warning ahead of the informational badges", () => {
    const badges = railBadges({
      duty: "plan",
      level: 2,
      runtime: "agent-sdk",
      model: "claude-opus-5",
      stoppedByUser: true,
      overridesRejected: [{ field: "target", reason: "unknown-target" }],
    });
    const firstInfo = badges.findIndex((badge) => badge.tone !== "warn");
    const lastWarn = badges.map((badge) => badge.tone).lastIndexOf("warn");
    expect(lastWarn).toBeLessThan(firstInfo);
    expect(keys(badges).slice(0, 2)).toEqual(["stopped", "override-rejected:target"]);
  });

  it("ignores empty override arrays", () => {
    expect(railBadges({ overridesApplied: [], overridesRejected: [] })).toEqual([]);
    expect(railBadges({ overridesApplied: ["  "] })).toEqual([]);
  });
});

describe("claude-chat run context: agreement with the legacy routing chip", () => {
  // The chip is superseded but still rendered, so the two must never disagree about
  // the effort VERDICT (the one thing that can mislead). They intentionally differ
  // in wording and in which fields get a slot - see the note on
  // routeChipFromAttribution.
  const cases: RouteAttribution[] = [
    FULL,
    { runtime: "gemini", model: "gemini-2.5-flash", effort: "high", effortApplied: false },
    { runtime: "custom", model: "m", effort: "medium" },
    { runtime: "claude-code", model: "opus" },
  ];

  it("agrees with the chip on runtime, model and the effort verdict", () => {
    for (const route of cases) {
      const badges = railBadges(route);
      const chip = routeChipFromAttribution(route);
      expect(chip).not.toBeNull();
      expect(chip!.label).toContain(`${route.runtime}/${route.model}`);
      expect(byKey(badges, "runtime")?.label).toBe(route.runtime);
      expect(byKey(badges, "model")?.label).toBe(route.model);

      const state = effortState(route);
      const effortBadge = byKey(badges, "effort");
      if (!state) {
        expect(effortBadge).toBeUndefined();
        expect(chip!.label).not.toContain("effort");
        continue;
      }
      // Same verdict on both sides, in each rendering's own wording.
      const refused = state === "refused";
      expect(effortBadge!.label.includes("(not applied)")).toBe(refused);
      expect(chip!.label.includes("effort not applied")).toBe(refused);
      const unverified = state === "unverified";
      expect(effortBadge!.label.includes("(unverified)")).toBe(unverified);
      expect(chip!.label.includes("effort unverified")).toBe(unverified);
    }
  });

  it("both go quiet on an attribution with nothing in it", () => {
    expect(railBadges({})).toEqual([]);
    expect(routeChipFromAttribution({})).toBeNull();
  });
});
