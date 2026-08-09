import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AttributionRail,
  menuForField,
  railDisplayBadges,
  type PinField,
  type RailOptions,
} from "../packages/claude-chat/src/AttributionRail";
import {
  ClaudeChat,
  applyRouteFrame,
  buildSendMeta,
  compactRouting,
  type RouteFrameTurn,
} from "../packages/claude-chat/src/ClaudeChat";
import type { ChatTransport, RouteAttribution, TurnRouting } from "../packages/claude-chat/src/transport";

// The Turn Rail UI (2026-07-25 run-context decision §13).
//
// This repo has NO React test setup: vitest runs `environment: "node"` and only
// collects `tests/**/*.test.ts`, and neither @testing-library/react nor jsdom is a
// dependency. So the rail is proven two ways that need neither:
//   • the badge/menu/frame decisions are PURE functions, driven directly;
//   • the markup is asserted through react-dom/server, which needs no DOM.
// What that cannot cover is stated plainly at the bottom of this file.

const h = React.createElement;

/** Render a component to static markup (no effects, no DOM, no hydration). */
function render(el: React.ReactElement): string {
  return renderToStaticMarkup(el);
}

const OPTIONS: RailOptions = {
  targets: [
    { id: "cc-sonnet-med", runtime: "agent-sdk", provider: "anthropic", model: "claude-sonnet-4-6", effort: "medium" },
    { id: "cc-haiku-low", runtime: "agent-sdk", provider: "anthropic", model: "claude-haiku-4-5", effort: "low" },
    { id: "codex-main", runtime: "codex", provider: "openai", model: "gpt-5-codex" },
  ],
  duties: [
    { id: "plan", title: "Planning", levels: [{ n: 1, description: "sketch" }, { n: 2, description: "full plan" }] },
    { id: "review", title: "Review" },
  ],
  efforts: ["low", "medium", "high", "xhigh", "max"],
  accounts: [{ name: "work", platform: "anthropic" }],
  projects: ["garrison", "ekoa"],
  tiers: ["T0-trivial", "T1-standard", "T2-deep"],
  flows: [
    { id: "full-feature", description: "the full gated pipeline", phases: ["plan", "implement", "review", "adversarial-review", "walkthrough"] },
    { id: "docs-change", description: "prose only", phases: ["implement"] },
  ],
  defaultFlow: "full-feature",
};

// ── railDisplayBadges: the pure model plus the interaction facts ──────────────

describe("railDisplayBadges", () => {
  it("marks a badge pinned when the pin matches what ran, and not pending", () => {
    const route: RouteAttribution = { route: "cc-haiku-low", runtime: "agent-sdk", model: "claude-haiku-4-5" };
    const badges = railDisplayBadges({ route, pins: { target: "cc-haiku-low" } });
    const target = badges.find((b) => b.key === "target");
    const runtime = badges.find((b) => b.key === "runtime");
    expect(target?.pinned).toBe(true);
    expect(target?.pending).toBeUndefined();
    // The runtime badge speaks for the SAME pin (a target picks runtime+model), so
    // it shows the pinned state too rather than looking unpinned next to it.
    expect(runtime?.field).toBe("target");
    expect(runtime?.pinned).toBe(true);
  });

  it("marks a badge pending when the pin differs from what ran", () => {
    const route: RouteAttribution = { route: "cc-haiku-low", model: "claude-haiku-4-5" };
    const badges = railDisplayBadges({ route, pins: { target: "cc-sonnet-med" } });
    expect(badges.find((b) => b.key === "target")?.pending).toBe(true);
  });

  it("marks a badge pending when its pin was touched mid-turn", () => {
    const route: RouteAttribution = { effort: "high", effortApplied: true };
    const plain = railDisplayBadges({ route, pins: { effort: "high" } });
    expect(plain.find((b) => b.key === "effort")?.pending).toBeUndefined();
    const touched = railDisplayBadges({ route, pins: { effort: "high" }, pendingFields: ["effort"] });
    expect(touched.find((b) => b.key === "effort")?.pending).toBe(true);
  });

  it("synthesizes a badge for a pin nothing has reported yet, level folded in", () => {
    const badges = railDisplayBadges({ route: {}, pins: { duty: "plan", level: 2 } });
    expect(badges).toHaveLength(1);
    expect(badges[0]).toMatchObject({
      key: "duty",
      field: "duty",
      label: "plan L2",
      pinned: true,
      pending: true,
    });
    expect(badges[0].title).toContain("applies to your next message");
  });

  it("offers a placeholder per unpinned dimension ONLY with offerAll, labelled with the dimension name", () => {
    expect(railDisplayBadges({ route: {}, pins: {} })).toEqual([]);
    const offered = railDisplayBadges({ route: {}, pins: {}, offerAll: true });
    // Every dimension a run can be decided on, in meaning-first order. The three
    // run-plan dimensions (RUN-SPEC-V1) sit alongside the compute ones because the
    // premise is that ALL of them default to auto and ALL of them are reachable.
    expect(offered.map((b) => b.key)).toEqual([
      "duty",
      "tier",
      "target",
      "model",
      "effort",
      "account",
      "project",
      "flow",
      "phasesOff",
    ]);
    // A placeholder never invents a VALUE - its label is the dimension's HUMAN name
    // and its title says it is not pinned.
    const humanName: Record<string, string> = { flow: "work kind", phasesOff: "phases" };
    for (const b of offered) {
      expect(b.placeholder).toBe(true);
      expect(b.label).toBe(humanName[b.key] ?? b.key);
      expect(b.title).toContain("not pinned");
      // A placeholder is not "auto": nothing ran, so there is no automatic choice
      // to report. Auto marks a REPORTED value the user did not pin.
      expect(b.auto).toBeUndefined();
    }
  });

  it("marks a reported-but-unpinned dimension `auto`, and never marks a pinned one", () => {
    const route: RouteAttribution = {
      route: "cc-haiku-low",
      model: "claude-haiku-4-5",
      effort: "low",
      project: "garrison",
    };
    const badges = railDisplayBadges({ route, pins: { effort: "low" } });
    // model was chosen by the orchestrator...
    expect(badges.find((b) => b.key === "model")?.auto).toBe(true);
    expect(badges.find((b) => b.key === "project")?.auto).toBe(true);
    // ...effort was chosen by the user, even though the two agree.
    expect(badges.find((b) => b.key === "effort")?.auto).toBeUndefined();
    expect(badges.find((b) => b.key === "effort")?.pinned).toBe(true);
  });

  it("does not add a placeholder for a dimension the turn already reported", () => {
    const badges = railDisplayBadges({ route: { project: "garrison" }, pins: {}, offerAll: true });
    const project = badges.filter((b) => b.key === "project");
    expect(project).toHaveLength(1);
    expect(project[0].label).toBe("garrison");
    expect(project[0].placeholder).toBeUndefined();
  });

  it("leaves information-only badges without a field, so they open nothing", () => {
    const badges = railDisplayBadges({
      route: { duty: "plan", skill: null, stoppedByUser: true, sessionId: "abc", card: "42", cardUrl: "/board/42" },
    });
    const byKey = Object.fromEntries(badges.map((b) => [b.key, b]));
    expect(byKey.skill.field).toBeUndefined();
    expect(byKey.stopped.field).toBeUndefined();
    expect(byKey.transcript.field).toBeUndefined();
    expect(byKey.card.field).toBeUndefined();
    expect(byKey.duty.field).toBe("duty");
  });
});

// ── menuForField: the dropdown vocabulary ────────────────────────────────────

describe("menuForField - the run-plan dimensions (RUN-SPEC-V1)", () => {
  it("offers every tier under an Automatic row, and says whether pinning one skips the classifier", () => {
    const alone = menuForField("tier", OPTIONS, {});
    expect(alone?.rows.map((r) => r.label)).toEqual([
      "Automatic - the classifier decides",
      "T0-trivial",
      "T1-standard",
      "T2-deep",
    ]);
    // Tier alone is only HALF the {taskType, tier} key, so the menu must not imply
    // it bought a skipped classification.
    expect(alone?.rows[1].detail).toContain("classifier still picks the task type");
    // With a duty pinned, the pair is complete and no classifier runs.
    const withDuty = menuForField("tier", OPTIONS, { duty: "plan" });
    expect(withDuty?.rows[1].detail).toContain("no classifier runs");
  });

  it("labels the default work kind and clears a stale phase selection when the plan changes", () => {
    const menu = menuForField("flow", OPTIONS, { flow: "docs-change", phasesOff: "walkthrough" });
    // Source order is preserved: the gateway already sorts the catalogue, and a
    // second sort here would be a second opinion about ordering.
    expect(menu?.rows.map((r) => r.label)).toEqual([
      "Automatic - the plan inferred from the tier",
      "full-feature (default)",
      "docs-change",
    ]);
    const fullFeature = menu?.rows.find((r) => r.key === "full-feature");
    // Those OFF ids belong to the OLD plan; carrying them over would silently
    // disable phases in the new one that the user never looked at.
    expect(fullFeature?.patch).toEqual({ flow: "full-feature", phasesOff: null });
    expect(menu?.rows.find((r) => r.key === "docs-change")?.selected).toBe(true);
  });

  it("turns the phases menu into per-phase toggles over the selected plan, in plan order", () => {
    const menu = menuForField("phasesOff", OPTIONS, { flow: "full-feature", phasesOff: "review" });
    expect(menu?.label).toBe("Phases this run walks");
    expect(menu?.rows.map((r) => r.key)).toEqual([
      "auto",
      "plan",
      "implement",
      "review",
      "adversarial-review",
      "walkthrough",
    ]);
    // An OFF phase stays IN the list, rendered off - never hidden.
    const review = menu?.rows.find((r) => r.key === "review");
    expect(review?.label).toBe("review - off");
    expect(review?.selected).toBe(false);
    expect(review?.patch).toEqual({ phasesOff: null }); // tapping it turns it back on
    // Tapping an ON phase adds it to the OFF set, serialized in PLAN order (not tap
    // order) so the same selection always produces the same pin.
    expect(menu?.rows.find((r) => r.key === "plan")?.patch).toEqual({ phasesOff: "plan,review" });
    // "Automatic" is selected only when nothing is off.
    expect(menu?.rows[0].selected).toBe(false);
    expect(menuForField("phasesOff", OPTIONS, { flow: "full-feature" })?.rows[0].selected).toBe(true);
  });

  it("falls back to the DEFAULT work kind's phases when no kind is pinned", () => {
    const menu = menuForField("phasesOff", OPTIONS, {});
    expect(menu?.rows.map((r) => r.key)).toContain("adversarial-review");
  });
});

describe("menuForField", () => {
  it("flattens duty x level into one list and marks the pinned pair", () => {
    const menu = menuForField("duty", OPTIONS, { duty: "plan", level: 2 });
    // ONE question, "what is this work?": the phased FLOWS come first, then the
    // single-turn duties flattened across their levels. This expectation went
    // stale when the two sibling badges merged (e34b1246) and the flow rows
    // started appearing here - it was asserting the pre-merge menu.
    expect(menu?.rows.map((r) => r.label)).toEqual([
      "Automatic - the classifier decides",
      "full-feature (default plan)",
      "docs-change (plan)",
      "plan L1",
      "plan L2",
      "review",
    ]);
    expect(menu?.rows.find((r) => r.label === "plan L2")?.selected).toBe(true);
    // Picking a duty is the other direction of the same merge: it pins duty+level
    // and RELEASES the flow pin, so the two can never read as a contradiction.
    expect(menu?.rows.find((r) => r.label === "plan L2")?.patch).toEqual({
      duty: "plan",
      level: 2,
      flow: null,
      phasesOff: null
    });
    // The clear row must clear EVERY half - a level without a duty is meaningless,
    // and since the merge it must release the flow pin (and its phase toggles) too.
    expect(menu?.rows[0].patch).toEqual({ duty: null, level: null, flow: null, phasesOff: null });
    expect(menu?.rows[0].selected).toBe(false);
  });

  it("pinning a target drops a stale free-text model overlay", () => {
    const menu = menuForField("target", OPTIONS, { model: "claude-opus-4-8" });
    expect(menu?.rows.find((r) => r.key === "codex-main")).toMatchObject({
      label: "codex-main",
      detail: "codex / gpt-5-codex",
      patch: { target: "codex-main", model: null },
    });
  });

  it("offers each target model once plus a typed escape hatch", () => {
    const menu = menuForField("model", OPTIONS, {});
    expect(menu?.rows.filter((r) => r.patch?.model).map((r) => r.label)).toEqual([
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "gpt-5-codex",
    ]);
    expect(menu?.freeText).toMatchObject({ field: "model" });
    // Every other dimension has a real catalog, so none of them gets free text.
    expect(menuForField("effort", OPTIONS, {})?.freeText).toBeUndefined();
  });

  it("says which source is empty instead of rendering a menu that looks broken", () => {
    const menu = menuForField("project", { projects: [] }, {});
    expect(menu?.rows).toHaveLength(2);
    expect(menu?.rows[1]).toMatchObject({ label: "no project options available", disabled: true });
  });

  it("renders a blocked dimension as its reason with every row inert", () => {
    const menu = menuForField("effort", { ...OPTIONS, unavailable: { effort: "gemini has no effort control" } }, {});
    expect(menu?.rows[0]).toMatchObject({ label: "gemini has no effort control", disabled: true });
    expect(menu?.rows.every((r) => r.disabled)).toBe(true);
  });

  it("appends the Muster link only when the host supplies a URL", () => {
    expect(menuForField("effort", OPTIONS, {})?.rows.some((r) => r.href)).toBe(false);
    const menu = menuForField("effort", OPTIONS, {}, "/muster");
    const link = menu?.rows.find((r) => r.href);
    expect(link).toMatchObject({ href: "/muster" });
    expect(link?.patch).toBeUndefined(); // a link row is never a radio
  });

  it("has no standalone menu for level (it rides the duty badge)", () => {
    expect(menuForField("level" as PinField, OPTIONS, {})).toBeNull();
  });
});

// ── applyRouteFrame: turn identity (contract §5) ─────────────────────────────

describe("applyRouteFrame", () => {
  const turn = (seq: number, streaming = true, route?: RouteAttribution): RouteFrameTurn => ({ seq, streaming, route });

  it("merges the pre-turn frame with the done frame instead of clobbering it", () => {
    const turns = [turn(1)];
    const pre = applyRouteFrame(turns, { turnSeq: 1, pending: true, route: "cc-sonnet-med", duty: "plan", level: 2 });
    expect(pre[0].route).toMatchObject({ pending: true, duty: "plan", level: 2 });
    const done = applyRouteFrame(pre, { turnSeq: 1, model: "claude-sonnet-4-6", sessionId: "s-1" });
    // Everything the pre-turn frame knew survives, the done frame adds to it...
    expect(done[0].route).toMatchObject({
      route: "cc-sonnet-med",
      duty: "plan",
      level: 2,
      model: "claude-sonnet-4-6",
      sessionId: "s-1",
    });
    // ...and `pending` is NOT sticky: the settled turn is not still pending.
    expect(done[0].route).not.toHaveProperty("pending");
  });

  it("DROPS a frame from an already-superseded turn (the misattribution bug)", () => {
    const turns = [turn(1, false), turn(2)];
    const out = applyRouteFrame(turns, { turnSeq: 1, model: "wrong-model" });
    expect(out).toBe(turns); // same array identity: nothing was written anywhere
    expect(turns[1].route).toBeUndefined();
  });

  it("adopts a frame numbered ahead of the local counter only while streaming", () => {
    // A re-mount (thread switch) restarts the local counter while the transport
    // keeps counting, so a live turn can legitimately see a higher seq.
    const live = applyRouteFrame([turn(0, true)], { turnSeq: 7, model: "claude-haiku-4-5" });
    expect(live[0].route?.model).toBe("claude-haiku-4-5");
    expect(live[0].seq).toBe(7);
    // A settled turn is not a home for someone else's frame.
    const settled = [turn(0, false)];
    expect(applyRouteFrame(settled, { turnSeq: 7, model: "claude-haiku-4-5" })).toBe(settled);
  });

  it("still attaches an UNSTAMPED frame to the latest turn (dev-env's transport)", () => {
    const turns = [turn(1, false), turn(2)];
    const out = applyRouteFrame(turns, { runtime: "claude-code" });
    expect(out[1].route?.runtime).toBe("claude-code");
    expect(out[1].seq).toBe(2); // seq is not invented from an unstamped frame
    expect(out[0].route).toBeUndefined();
  });

  it("is a no-op on an empty transcript", () => {
    const turns: RouteFrameTurn[] = [];
    expect(applyRouteFrame(turns, { turnSeq: 1 })).toBe(turns);
  });
});

// ── send meta: the pinned intent on the wire (contract §3) ───────────────────

describe("buildSendMeta with routing", () => {
  it("stays undefined for a plain send, so the gateway body is unchanged", () => {
    expect(buildSendMeta(undefined, undefined)).toBeUndefined();
    expect(buildSendMeta(undefined, undefined, false, {})).toBeUndefined();
    // Cleared pins are not pins: an all-null routing must not manufacture a meta.
    expect(buildSendMeta(undefined, undefined, false, { target: null, effort: null })).toBeUndefined();
  });

  it("carries only the pinned dimensions, alongside the existing keys", () => {
    const meta = buildSendMeta({ card: "42" }, "coding", true, { target: "cc-haiku-low", effort: null, level: 2 });
    expect(meta).toEqual({
      context: { card: "42" },
      mode: "coding",
      autonomous: true,
      routing: { target: "cc-haiku-low", level: 2 },
    });
  });

  it("compactRouting trims strings, truncates levels and drops blanks", () => {
    expect(compactRouting({ project: "  garrison  ", model: "   ", level: 2.7 })).toEqual({
      project: "garrison",
      level: 2,
    });
    expect(compactRouting(null)).toBeUndefined();
  });
});

// ── Rendered markup (react-dom/server: no DOM needed) ───────────────────────

describe("AttributionRail markup", () => {
  const route: RouteAttribution = {
    route: "cc-sonnet-med",
    runtime: "agent-sdk",
    model: "claude-sonnet-4-6",
    duty: "plan",
    level: 2,
    effort: "high",
    effortApplied: false,
    account: null,
    project: "garrison",
    projectPath: "/home/ggomes/dev/garrison",
    sessionId: "sess-1",
    card: "42",
    cardUrl: "/board/#/cards/42",
  };

  it("renders one toolbar line of .cc-rbadge items and never touches .cc-badge", () => {
    const html = render(h(AttributionRail, { route, label: "Run context for this reply" }));
    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-label="Run context for this reply"');
    expect(html).toContain('class="cc-railscroll"');
    expect(html).toContain("cc-rbadge");
    // The slash-command chips own .cc-badge; reusing it would inherit their styles.
    expect(html).not.toMatch(/class="[^"]*\bcc-badge\b/);
  });

  it("renders exactly one Tab stop (roving tabindex)", () => {
    const html = render(h(AttributionRail, { route }));
    expect(html.match(/tabindex="0"/g) ?? []).toHaveLength(1);
    expect((html.match(/tabindex="-1"/g) ?? []).length).toBeGreaterThan(3);
  });

  it("renders the card badge as a real link and keeps projectPath in the tooltip only", () => {
    const html = render(h(AttributionRail, { route }));
    expect(html).toContain('href="/board/#/cards/42"');
    expect(html).toContain('rel="noopener noreferrer"');
    // The absolute cwd is informational: it must never become an href.
    expect(html).toContain("cwd /home/ggomes/dev/garrison");
    expect(html).not.toContain('href="/home/ggomes/dev/garrison"');
  });

  it("renders the transcript badge inert when no viewer is wired up", () => {
    const inert = render(h(AttributionRail, { route }));
    expect(inert).toMatch(/no transcript viewer is wired up here/);
    const wired = render(h(AttributionRail, { route, onOpenTranscript: () => {} }));
    expect(wired).not.toMatch(/no transcript viewer is wired up here/);
  });

  it("opens dropdowns only when the host supplies BOTH options and a pin handler", () => {
    const readOnly = render(h(AttributionRail, { route, options: OPTIONS }));
    expect(readOnly).not.toContain('aria-haspopup="menu"');
    const live = render(
      h(AttributionRail, { route, options: OPTIONS, onPin: () => {}, variant: "flight" as const })
    );
    expect(live).toContain('aria-haspopup="menu"');
    expect(live).toContain('aria-expanded="false"');
  });

  it("shows a refused effort and a machine login honestly, and flags a pending pin", () => {
    const html = render(
      h(AttributionRail, {
        route,
        pins: { target: "codex-main" },
        pendingFields: ["target"],
        options: OPTIONS,
        onPin: () => {},
        variant: "flight" as const,
      })
    );
    expect(html).toContain("high (not applied)");
    expect(html).toContain("machine login");
    expect(html).toContain("cc-rbadge-pending");
    expect(html).toContain("applies next turn");
    expect(html).toContain(">next<"); // the marker is a text label, not a glyph
  });

  it("renders nothing at all when the turn reported nothing", () => {
    expect(render(h(AttributionRail, { route: {} }))).toBe("");
    expect(render(h(AttributionRail, { route: null }))).toBe("");
  });

  it("carries no emoji (house rule)", () => {
    const html = render(
      h(AttributionRail, { route, options: OPTIONS, onPin: () => {}, variant: "flight" as const }, "elapsed 0:12")
    );
    expect(html).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u);
  });
});

// ── ClaudeChat wiring: the rail's two mount points and the feature gate ──────

describe("ClaudeChat rail wiring", () => {
  function stubTransport(): ChatTransport {
    return {
      base: "",
      connect: () => () => {},
      sendMessage: async () => {},
      sendKey: async () => {},
      setMode: async () => ({ mode: "unknown" as const, reached: false }),
      interrupt: async () => {},
      fetchCommands: async () => [],
    };
  }

  it("has no toolbar and no rail without the feature (dev-env / today's web channel)", () => {
    const html = render(h(ClaudeChat, { transport: stubTransport() }));
    expect(html).not.toContain("cc-toolbar");
    expect(html).not.toContain("cc-rail");
  });

  it("features.routing joins the toolbar gate and adds the Route chip", () => {
    const html = render(h(ClaudeChat, { transport: stubTransport(), features: { routing: true } }));
    expect(html).toContain("cc-toolbar");
    expect(html).toContain(">Route<");
  });

  it("mounts the flight rail in the composer as soon as a pin is set", () => {
    const pins: TurnRouting = { project: "garrison" };
    const html = render(
      h(ClaudeChat, {
        transport: stubTransport(),
        features: { routing: true },
        routing: pins,
        routeOptions: OPTIONS,
        onPinChange: () => {},
      })
    );
    expect(html).toContain("cc-rail cc-rail-flight");
    expect(html).toContain("garrison");
    expect(html).toContain("cc-rbadge-pinned");
  });

  it("renders a settled rail for a restored turn OUTSIDE the text/streaming gate", () => {
    // A tool-only or cancelled turn settles with NO prose. Today's double gate
    // (`clean.text.trim() && !t.streaming`) is exactly why its routing was invisible.
    const html = render(
      h(ClaudeChat, {
        transport: stubTransport(),
        features: { routing: true },
        initialHistory: [
          {
            user: "do the thing",
            assistant: "",
            route: { runtime: "codex", stoppedByUser: true, stoppedReason: "cancelled" },
            overrides: { target: "codex-main" },
          },
        ],
      })
    );
    expect(html).toContain("cc-rail cc-rail-settled");
    expect(html).toContain("stopped: cancelled");
    // The legacy chip is the FALLBACK, not a duplicate of the rail.
    expect(html).not.toContain("cc-routechip");
  });

  it("keeps the legacy routing chip when the host has not opted into the rail", () => {
    const html = render(
      h(ClaudeChat, {
        transport: stubTransport(),
        initialHistory: [{ user: "hi", assistant: "hello", route: { runtime: "agent-sdk", model: "claude-haiku-4-5" } }],
      })
    );
    expect(html).toContain("cc-routechip");
    expect(html).not.toContain("cc-rail");
  });

  it("swaps the classic Stop for the rail's Stop pair only when the rail is mounted", () => {
    // Busy is server-driven state, so drive the two Stop variants through the
    // rail's own markup instead: with the rail mounted the pair lives at its end.
    const bare = render(h(ClaudeChat, { transport: stubTransport() }));
    expect(bare).toContain(">Send<");
    expect(bare).not.toContain("cc-railstop");
    const railed = render(
      h(AttributionRail, { route: {}, options: OPTIONS, onPin: () => {}, variant: "flight" as const }, [
        h("button", { key: "s", type: "button", className: "cc-stop cc-railstop" }, "Stop"),
        h("button", { key: "c", type: "button", className: "cc-stop cc-railstop cc-railstop-change" }, "Stop & change"),
      ])
    );
    expect(railed).toContain("cc-railend");
    expect(railed).toContain("cc-railstop-change");
    expect(railed).toContain("Stop &amp; change");
  });
});

// NOT covered here, and deliberately so - all of it needs a real DOM (jsdom +
// @testing-library, neither of which this repo has): the roving-tabindex focus
// moves, opening a popover and picking a row, Escape restoring focus to its badge
// without cancelling the turn, the outside-press close, `Stop & change` restoring
// the sent text and swapping Send for Resend, and the window-level Escape
// keybinding. Those are the interactions to walk by hand (or in the Drill run)
// before this ships.
