// The dimension feedback card (§8.2): the correction channel for a router that
// now decides almost everything by default.
//
// Three things are easy to lose here and each one silently turns the loop off:
//
//   1. The verdict must carry the FLOW it is judging. `evidenceFromVerdict` keys
//      a verdict's evidence on `original.flow` first, and until now nothing sent
//      one — so every verdict landed on the duty track and no flow track could
//      ever leave the "ask" band.
//   2. A correction must speak the gateway's vocabulary. A typed value that is
//      not in the compiled policy is a correction the edge would refuse, so the
//      menus are the proxied `/route/options` list and free text survives only
//      as the fallback for a gateway that is not answering.
//   3. The two surfaces (the home card and the Muster panel) must post the SAME
//      payload. Two shapes over one queue is how the Improver ends up trained on
//      two different things.
//
// This repo has NO React test setup (vitest runs `environment: "node"`, and
// neither jsdom nor @testing-library/react is a dependency), so the card is
// proven the way tests/claude-chat-rail.test.ts proves the Turn Rail: the
// decisions are PURE functions driven directly, and the markup goes through
// react-dom/server, which needs no DOM. What that cannot cover is stated at the
// bottom of this file.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  CARD_FIELD_ORDER,
  EMPTY_VOCABULARY,
  LEVEL_IS_CORRECTABLE,
  ROUTE_OPTIONS_ENDPOINT,
  VERDICT_ENDPOINT,
  correctableFields,
  fetchRouteOptions,
  normalizeRouteOptions,
  optionsForField,
  postVerdict,
  resolvedSpec,
  verdictPayload,
  type FeedbackDecision,
  type RouteOptionsResponse
} from "@/lib/decision-feedback";
import { buildVerdictRecord, CORRECTION_FIELDS } from "@/lib/decision-verdicts";
import { evidenceFromVerdict } from "@/lib/routing-tracks";

// The card imports its CSS module. Vitest's default `css: false` already hands
// one back as a harmless proxy; mocking it makes that explicit, so a class name
// can never be the reason this file fails.
vi.mock("@/components/garrison/GarrisonHome.module.css", () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) })
}));

// The gateway the proxy route reaches. Declared before the dynamic import below
// so the mocked resolver closes over the live value.
let gatewayBase: string | null = null;
vi.mock("@/lib/runner", () => ({
  activeGatewayBaseUrl: () => gatewayBase
}));

const { RouterFeedbackCard } = await import("@/components/garrison/RouterFeedbackCard");
const { GET } = await import("@/app/api/orchestrator/route-options/route");

const h = React.createElement;
const render = (el: React.ReactElement): string => renderToStaticMarkup(el);

// One gateway answer, in the shape gateway-pty.mjs `buildRouteOptions` returns.
const GATEWAY_OPTIONS = {
  targets: [
    { id: "cc-opus-high", runtime: "claude-code", provider: "anthropic", model: "claude-opus-5", effort: "high" },
    { id: "cc-haiku-low", runtime: "claude-code", provider: "anthropic", model: "claude-haiku-4-5", effort: "low" },
    // Same model on a second target: the model menu must not offer it twice.
    { id: "cc-haiku-alt", runtime: "agent-sdk", provider: "anthropic", model: "claude-haiku-4-5", effort: "low" },
    { id: "codex-main", runtime: "codex", provider: "openai", model: "gpt-5-codex" }
  ],
  duties: [
    { id: "implement", title: "Implementation", levels: [{ n: 1, description: "one file" }] },
    { id: "dispatch", title: "dispatch" }
  ],
  selectedDuties: ["implement"],
  efforts: ["low", "medium", "high"],
  accounts: [{ name: "work", platform: "anthropic" }],
  account: { name: null, source: null },
  projects: ["garrison", "ekoa"],
  tiers: ["T0-trivial", "T1-standard"],
  flows: [
    { id: "full-feature", description: "the gated pipeline", phases: ["plan", "implement", "review"] },
    { id: "docs-change", description: null, phases: ["implement", "review"] }
  ],
  defaultFlow: "full-feature",
  primaryRuntime: "claude-code",
  activeProfile: "default",
  routing: true
};

const VOCAB = normalizeRouteOptions(GATEWAY_OPTIONS);
const AVAILABLE: RouteOptionsResponse = { ...VOCAB, available: true, reason: null };
const UNAVAILABLE: RouteOptionsResponse = {
  ...EMPTY_VOCABULARY,
  available: false,
  reason: "the gateway is not answering - start the operative to correct a route"
};

// A decision row as the feed normalizes it: it DOES carry a flow.
const DECISION: FeedbackDecision = {
  id: "d1",
  sessionId: "thread-7",
  flow: "docs-change",
  duty: "implement",
  level: 2,
  model: "claude-haiku-4-5",
  target: "cc-haiku-low",
  effort: "low",
  tier: "T0-trivial"
};

// ── The vocabulary ───────────────────────────────────────────────────────────

describe("normalizeRouteOptions", () => {
  it("keeps what a correction can name and drops what belongs to the Turn Rail", () => {
    expect(VOCAB.targets.map((t) => t.id)).toEqual([
      "cc-opus-high",
      "cc-haiku-low",
      "cc-haiku-alt",
      "codex-main"
    ]);
    expect(VOCAB.flows.map((f) => f.id)).toEqual(["full-feature", "docs-change"]);
    expect(VOCAB.defaultFlow).toBe("full-feature");
    // Not correction dimensions - carrying them would just be a second, stale
    // copy of the rail's contract.
    expect(VOCAB).not.toHaveProperty("selectedDuties");
    expect(VOCAB).not.toHaveProperty("routing");
    expect(VOCAB).not.toHaveProperty("activeProfile");
  });

  it("is total: junk from upstream becomes empty lists, never a crash", () => {
    for (const junk of [null, undefined, "options", 7, [], { targets: "cc-opus", flows: { a: 1 } }]) {
      const out = normalizeRouteOptions(junk);
      expect(out.targets).toEqual([]);
      expect(out.flows).toEqual([]);
      expect(out.defaultFlow).toBe(null);
    }
    // A malformed entry is skipped, the well-formed ones survive.
    expect(normalizeRouteOptions({ duties: [{ title: "no id" }, { id: "review" }] }).duties).toEqual([
      { id: "review", title: null }
    ]);
  });
});

describe("optionsForField", () => {
  it("offers the composition's real targets, models, duties and flows", () => {
    expect(optionsForField("target", VOCAB).map((o) => o.value)).toEqual([
      "cc-opus-high",
      "cc-haiku-low",
      "cc-haiku-alt",
      "codex-main"
    ]);
    // One row per MODEL, not per target: two targets on one model is one choice.
    expect(optionsForField("model", VOCAB).map((o) => o.value)).toEqual([
      "claude-opus-5",
      "claude-haiku-4-5",
      "gpt-5-codex"
    ]);
    expect(optionsForField("duty", VOCAB).map((o) => o.value)).toEqual(["implement", "dispatch"]);
    expect(optionsForField("effort", VOCAB).map((o) => o.value)).toEqual(["low", "medium", "high"]);
    expect(optionsForField("tier", VOCAB).map((o) => o.value)).toEqual(["T0-trivial", "T1-standard"]);
    expect(optionsForField("account", VOCAB).map((o) => o.value)).toEqual(["work"]);
    expect(optionsForField("project", VOCAB).map((o) => o.value)).toEqual(["garrison", "ekoa"]);
    const flows = optionsForField("flow", VOCAB);
    expect(flows.map((o) => o.value)).toEqual(["full-feature", "docs-change"]);
    expect(flows[0].detail).toContain("default plan");
  });

  it("offers the phases of the plan THIS decision ran, not the default plan's", () => {
    // A phase id from another plan disables nothing, so offering one would be a
    // correction that silently does nothing.
    expect(optionsForField("phasesOff", VOCAB, DECISION).map((o) => o.value)).toEqual([
      "implement",
      "review"
    ]);
    expect(optionsForField("phasesOff", VOCAB, { flow: null }).map((o) => o.value)).toEqual([
      "plan",
      "implement",
      "review"
    ]);
  });

  it("returns nothing when there is no vocabulary - the signal for the typed fallback", () => {
    for (const field of CORRECTION_FIELDS) {
      expect(optionsForField(field, null), field).toEqual([]);
      expect(optionsForField(field, EMPTY_VOCABULARY), field).toEqual([]);
    }
  });
});

// ── What travels with a verdict ──────────────────────────────────────────────

describe("resolvedSpec", () => {
  it("carries the FLOW, which is what the autonomy reader keys evidence on", () => {
    expect(resolvedSpec(DECISION)).toEqual({
      target: "cc-haiku-low",
      model: "claude-haiku-4-5",
      effort: "low",
      duty: "implement",
      tier: "T0-trivial",
      flow: "docs-change"
    });
  });

  it("carries the level only if the correction vocabulary accepts one", () => {
    // `level` is not in CORRECTION_FIELDS today, so sanitizeCorrection would drop
    // it and a card that offered it would be lying. This assertion moves with the
    // vocabulary rather than pinning today's answer.
    expect(Object.keys(resolvedSpec(DECISION)).includes("level")).toBe(LEVEL_IS_CORRECTABLE);
    expect(LEVEL_IS_CORRECTABLE).toBe((CORRECTION_FIELDS as readonly string[]).includes("level"));
  });

  it("a recorded verdict now lands on the FLOW track", () => {
    // The end of the chain this whole card exists for: tap → payload → queue
    // record → evidence. Before the flow travelled, this evidence carried the
    // duty as its shape and every flow track stayed unjudged.
    const record = buildVerdictRecord({
      ...verdictPayload(DECISION, "right"),
      at: "2026-08-13T10:00:00.000Z"
    })!;
    expect((record.original as Record<string, string>).flow).toBe("docs-change");
    const evidence = evidenceFromVerdict(record);
    expect(evidence.some((e) => e.category === "flow" && e.shape === "docs-change")).toBe(true);
  });
});

describe("correctableFields", () => {
  it("leads with the dimensions §8.2 names, then the rest of the run spec", () => {
    expect(correctableFields(DECISION)).toEqual(["flow", "duty", "model", "target", "effort", "tier"]);
    expect(CARD_FIELD_ORDER.slice(0, 3)).toEqual(["flow", "duty", "model"]);
  });

  it("only offers dimensions the decision actually resolved", () => {
    // Correcting an account a decision never named asks the user about something
    // they were never shown.
    expect(correctableFields({ duty: "review" })).toEqual(["duty"]);
    expect(correctableFields(null)).toEqual([]);
  });
});

describe("verdictPayload - the one contract both surfaces post", () => {
  it("a whole-decision tap records 'right' with what actually ran", () => {
    expect(verdictPayload(DECISION, "right")).toEqual({
      decisionId: "d1",
      verdict: "right",
      resolved: resolvedSpec(DECISION),
      sessionId: "thread-7"
    });
  });

  it("a dimension tap records 'wrong' naming ONLY that dimension", () => {
    const payload = verdictPayload(DECISION, "wrong", { flow: "full-feature" });
    expect(payload.verdict).toBe("wrong");
    expect(payload.correction).toEqual({ flow: "full-feature" });
    expect(payload.resolved?.flow).toBe("docs-change");
  });

  it("drops blank dimensions rather than recording an empty answer as an answer", () => {
    const payload = verdictPayload(DECISION, "wrong", { model: "   ", duty: "" });
    expect(payload).not.toHaveProperty("correction");
    // A bare "wrong" is still a verdict - weaker signal, not a non-signal.
    expect(payload.verdict).toBe("wrong");
  });
});

describe("postVerdict", () => {
  it("posts the payload verbatim to the decisions endpoint", async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const stub = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;

    await postVerdict(verdictPayload(DECISION, "wrong", { duty: "review" }), stub);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(VERDICT_ENDPOINT);
    expect(seen[0].init?.method).toBe("POST");
    expect(JSON.parse(String(seen[0].init?.body))).toEqual({
      decisionId: "d1",
      verdict: "wrong",
      resolved: resolvedSpec(DECISION),
      correction: { duty: "review" },
      sessionId: "thread-7"
    });
  });

  it("throws on a refusal so a surface never says 'recorded' over a lost verdict", async () => {
    const stub = (async () => ({ ok: false, status: 400 }) as Response) as unknown as typeof fetch;
    await expect(postVerdict(verdictPayload(DECISION, "right"), stub)).rejects.toThrow("400");
  });
});

describe("fetchRouteOptions", () => {
  it("normalizes a live answer", async () => {
    const stub = (async (url: unknown) => {
      expect(String(url)).toBe(ROUTE_OPTIONS_ENDPOINT);
      return { ok: true, status: 200, json: async () => ({ ...GATEWAY_OPTIONS, available: true }) } as Response;
    }) as unknown as typeof fetch;
    const out = await fetchRouteOptions(stub);
    expect(out.available).toBe(true);
    expect(out.flows.map((f) => f.id)).toEqual(["full-feature", "docs-change"]);
  });

  it("degrades to unavailable + a reason instead of throwing", async () => {
    const down = (async () =>
      ({
        ok: false,
        status: 503,
        json: async () => ({ available: false, reason: "the gateway is not answering" })
      }) as Response) as unknown as typeof fetch;
    const out = await fetchRouteOptions(down);
    expect(out.available).toBe(false);
    expect(out.reason).toBe("the gateway is not answering");
    expect(out.targets).toEqual([]);

    const broken = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect((await fetchRouteOptions(broken)).reason).toContain("network down");
  });
});

// ── The card ─────────────────────────────────────────────────────────────────

type CardProps = React.ComponentProps<typeof RouterFeedbackCard>;

const cardProps = (over: Partial<CardProps> = {}): CardProps => ({
  decision: DECISION,
  options: AVAILABLE,
  openField: null,
  onOpenField: () => {},
  onConfirm: () => {},
  onWrong: () => {},
  onCorrect: () => {},
  ...over
});

describe("RouterFeedbackCard", () => {
  it("renders one tap target per correctable dimension, with the level on its duty", () => {
    const html = render(h(RouterFeedbackCard, cardProps()));
    for (const field of ["flow", "duty", "model", "target", "effort", "tier"]) {
      expect(html, field).toContain(`data-testid="router-dim-${field}"`);
    }
    // Level is not correctable, so it is shown as part of the duty rather than
    // as a tap target that would collect a droppable answer.
    expect(html).not.toContain("router-dim-level");
    expect(html).toContain("L2");
    // The whole-decision answers stay one tap.
    expect(html).toContain('data-testid="router-verdict-right"');
    expect(html).toContain('data-testid="router-verdict-wrong"');
  });

  it("opens the REAL options for the tapped dimension - menu, not free text", () => {
    const html = render(h(RouterFeedbackCard, cardProps({ openField: "flow" })));
    expect(html).toContain('data-testid="router-menu-flow"');
    expect(html).toContain("full-feature");
    expect(html).toContain("default plan");
    expect(html).not.toContain("<input");
  });

  it("falls back to a typed value when the gateway has no vocabulary to offer", () => {
    const html = render(
      h(RouterFeedbackCard, cardProps({ openField: "flow", options: UNAVAILABLE }))
    );
    expect(html).toContain("<input");
    expect(html).toContain('aria-label="corrected flow"');
    // The reason is shown: an empty menu must not read as "you have no options".
    expect(html).toContain("the gateway is not answering");
  });

  it("says it is still reading the vocabulary rather than offering an empty menu", () => {
    const html = render(h(RouterFeedbackCard, cardProps({ openField: "duty", options: null })));
    expect(html).toContain("reading the routing vocabulary");
    expect(html).not.toContain("<input");
  });

  it("collects no free-text note - the queue record carries no user prose", () => {
    const html = render(h(RouterFeedbackCard, cardProps()));
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("<input");
  });
});

// ── The shell proxy for the vocabulary ───────────────────────────────────────

describe("GET /api/orchestrator/route-options", () => {
  let server: http.Server;
  let reply: { status: number; body: unknown } = { status: 200, body: GATEWAY_OPTIONS };
  let asked: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      asked.push(req.url ?? "");
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    gatewayBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("proxies the gateway's own /route/options, server-side", async () => {
    asked = [];
    reply = { status: 200, body: GATEWAY_OPTIONS };
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    // The browser is almost never on this box, so the vocabulary is fetched here
    // and only a relative path ever reaches the client.
    expect(asked).toEqual(["/route/options"]);
    expect(body.available).toBe(true);
    expect(body.flows.map((f: { id: string }) => f.id)).toEqual(["full-feature", "docs-change"]);
    expect(body.targets).toHaveLength(4);
  });

  it("reports an upstream refusal as 503 + a reason, never as a 500", async () => {
    reply = { status: 500, body: { error: "boom" } };
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.available).toBe(false);
    expect(body.reason).toContain("500");
    // The card can still render: every list is present and empty.
    expect(body).toMatchObject(EMPTY_VOCABULARY);
  });

  it("reports an unreachable gateway the same way - the operative is simply not running", async () => {
    const live = gatewayBase;
    gatewayBase = "http://127.0.0.1:1";
    try {
      const res = await GET();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.available).toBe(false);
      expect(body.reason).toContain("not answering");
    } finally {
      gatewayBase = live;
    }
  });
});

// What this file deliberately does NOT cover, for want of a DOM: the click
// handlers themselves. Every one of them is a single call into a function tested
// above (`onConfirm` → verdictPayload(decision, "right") → postVerdict;
// `onCorrect` → verdictPayload(decision, "wrong", {field: value})), and the
// markup assertions pin which control exists in which state. A jsdom setup would
// close that last gap; adding one is a repo-wide decision, not this card's.
