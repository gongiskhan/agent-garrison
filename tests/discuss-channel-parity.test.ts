// Channel parity for Discuss interception.
//
// Before 2026-08-09 this module opened with `if (channel !== "web") return null`
// and looked the card up at a hardcoded `web:<sessionId>`. So answering a pending
// question, or saying "go" on a held card, worked on the web channel and NOWHERE
// ELSE — on Omi, voice or Slack the identical sentence was just an ordinary turn.
//
// The brief's rule is that behaviour is identical across channels and only
// rendering differs, and that the decision layer must not know which channel it
// serves. These tests are that rule, executable: every case runs the SAME message
// through EVERY channel and asserts one decision.

import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs fitting module, no types
import { resolveDiscussInterception, originIdFor, isAffirmativeGo } from "../fittings/seed/http-gateway/scripts/lib/discuss-intercept.mjs";

const CHANNELS = ["web", "omi", "slack", "voice"] as const;

const heldCard = { id: "card-1", list: "discuss", discussHeld: true };
const openCard = { id: "card-1", list: "discuss", discussHeld: false };

/** A resolveThreadCard that only answers for the ONE origin id it was built for,
 *  so a test fails loudly if the module looks the card up at the wrong address. */
const resolverFor = (expectedOriginId: string, card: unknown) => {
  const seen: string[] = [];
  const fn = async (originId: string) => {
    seen.push(originId);
    return originId === expectedOriginId ? { attach: card } : null;
  };
  return Object.assign(fn, { seen });
};

describe("originIdFor", () => {
  it("formats <transport>:<address> for every channel", () => {
    expect(originIdFor("web", "t1")).toBe("web:t1");
    expect(originIdFor("slack", "C123")).toBe("slack:C123");
  });

  it("does not double-prefix an id that already carries its transport", () => {
    // The Omi wake bus hands over a full `omi:wake:<id>`; prefixing again would
    // produce `omi:omi:wake:<id>` and miss every card.
    expect(originIdFor("omi", "omi:wake:01ABC")).toBe("omi:wake:01ABC");
  });

  it("is null without both halves — no origin means no lookup", () => {
    expect(originIdFor("web", "")).toBeNull();
    expect(originIdFor("", "t1")).toBeNull();
    expect(originIdFor(null, null)).toBeNull();
  });
});

describe("answering a pending question — identical on every channel", () => {
  for (const channel of CHANNELS) {
    it(`intercepts the answer on ${channel}`, async () => {
      const pending = new Map([["tool-1", { cardId: "card-1" }]]);
      const resolve = resolverFor(`${channel}:t1`, openCard);
      const out = await resolveDiscussInterception({
        text: "let's scope it to the settings page",
        channel,
        sessionId: "t1",
        pendingQuestions: pending,
        resolveThreadCard: resolve
      });
      expect(out, channel).toMatchObject({ action: "answer", toolUseId: "tool-1" });
      expect(resolve.seen, `${channel} looked up the wrong origin`).toEqual([`${channel}:t1`]);
    });
  }
});

describe("an explicit GO on a held card — identical on every channel", () => {
  for (const channel of CHANNELS) {
    it(`resumes the held card on ${channel}`, async () => {
      const out = await resolveDiscussInterception({
        text: "go",
        channel,
        sessionId: "t1",
        pendingQuestions: new Map(),
        resolveThreadCard: resolverFor(`${channel}:t1`, heldCard)
      });
      expect(out, channel).toMatchObject({ action: "go" });
      expect((out as { card: { id: string } }).card.id).toBe("card-1");
    });
  }
});

describe("the cases that must stay ordinary turns, on every channel", () => {
  for (const channel of CHANNELS) {
    it(`does not intercept an ordinary message on ${channel}`, async () => {
      const resolve = resolverFor(`${channel}:t1`, heldCard);
      const out = await resolveDiscussInterception({
        text: "can you also look at the billing page while you are in there",
        channel,
        sessionId: "t1",
        pendingQuestions: new Map(),
        resolveThreadCard: resolve
      });
      expect(out, channel).toBeNull();
      // No pending question and not a bare affirmative, so the board is never
      // consulted — ordinary turns must not pay a round-trip.
      expect(resolve.seen, channel).toEqual([]);
    });

    it(`does not resume a card that is not held on ${channel}`, async () => {
      const out = await resolveDiscussInterception({
        text: "go",
        channel,
        sessionId: "t1",
        pendingQuestions: new Map(),
        resolveThreadCard: resolverFor(`${channel}:t1`, openCard)
      });
      expect(out, channel).toBeNull();
    });

    it(`does not intercept when the live card is not in Discuss on ${channel}`, async () => {
      const out = await resolveDiscussInterception({
        text: "go",
        channel,
        sessionId: "t1",
        pendingQuestions: new Map(),
        resolveThreadCard: resolverFor(`${channel}:t1`, { id: "card-1", list: "implement", discussHeld: true })
      });
      expect(out, channel).toBeNull();
    });
  }
});

describe("the decision does not vary by channel", () => {
  const run = (channel: string, text: string, card: unknown, pending: Map<string, unknown>) =>
    resolveDiscussInterception({
      text,
      channel,
      sessionId: "t1",
      pendingQuestions: pending,
      resolveThreadCard: resolverFor(`${channel}:t1`, card)
    });

  it("produces one answer for one input across all four channels", async () => {
    for (const [text, card, pending] of [
      ["go", heldCard, new Map()],
      ["go", openCard, new Map()],
      ["scope it small", openCard, new Map([["tool-1", { cardId: "card-1" }]])],
      ["an ordinary sentence", heldCard, new Map()]
    ] as const) {
      const results = await Promise.all(CHANNELS.map((c) => run(c, text, card, pending as Map<string, unknown>)));
      const shapes = (results as ({ action: string } | null)[]).map((r) => (r ? r.action : null));
      expect(new Set(shapes).size, `"${text}" decided differently per channel: ${JSON.stringify(shapes)}`).toBe(1);
    }
  });

  it("never throws, whatever the resolver does", async () => {
    for (const channel of CHANNELS) {
      const out = await resolveDiscussInterception({
        text: "go",
        channel,
        sessionId: "t1",
        pendingQuestions: new Map(),
        resolveThreadCard: async () => {
          throw new Error("board unavailable");
        }
      });
      expect(out, channel).toBeNull();
    }
  });
});

describe("isAffirmativeGo stays tight", () => {
  it("matches only a bare affirmative", () => {
    for (const yes of ["go", "GO", "go.", "proceed", "yes, go ahead", "ship it"]) {
      expect(isAffirmativeGo(yes), yes).toBe(true);
    }
    for (const no of ["go ahead and delete the database", "let's go over the plan", "gone", ""]) {
      expect(isAffirmativeGo(no), no).toBe(false);
    }
  });
});
