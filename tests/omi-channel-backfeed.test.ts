// Omi channel M6 — backfeed acceptance (build spec): mocked import is
// idempotent (fingerprint ledger - the real API has no dedupe and returns no
// ids); templates contain no secrets and no internal ids beyond the deep
// link; flag-gated off by default.

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../fittings/seed/omi-channel/lib/config.mjs";
import { OmiStore, Counters } from "../fittings/seed/omi-channel/lib/store.mjs";
import { Ingress } from "../fittings/seed/omi-channel/lib/ingress.mjs";
import { Backfeed, fingerprint } from "../fittings/seed/omi-channel/lib/backfeed.mjs";
import { OmiApi } from "../fittings/seed/omi-channel/lib/omi-api.mjs";

const FIXTURES = path.resolve(__dirname, "..", "fittings", "seed", "omi-channel", "fixtures");
const UID = "omi_test_user_1";
const CARD_ID = "01BOARDCARDULIDAAAAAAAAAAA";

function makeApiRecorder(script: Array<number | Error> = []) {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body ?? "{}")) });
    const next = script.shift() ?? 200;
    if (next instanceof Error) throw next;
    return new Response("{}", { status: next as number });
  }) as unknown as typeof fetch;
  const api = new OmiApi({
    appId: "app_123",
    appSecret: "s",
    importApiKey: "sk_import_key",
    fetchImpl: impl,
    sleep: async () => {},
    log: { error: () => {} }
  });
  return { api, sent };
}

function makeBoard(cards: Array<Record<string, unknown>>) {
  return {
    listCards: async () => cards.map(({ lastReply: _lr, ...summary }) => summary),
    getCard: async (id: string) => cards.find((c) => c.id === id) ?? null
  };
}

function makeDeps(home: string, opts: { cards?: Array<Record<string, unknown>>; apiScript?: Array<number | Error>; cfg?: Record<string, unknown>; seedDecisions?: boolean } = {}) {
  const store = new OmiStore(path.join(home, "omi"));
  store.pinUid(UID);
  const counters = new Counters(store.root, "backfeed");
  if (opts.seedDecisions) {
    const cfgIngress = loadConfig({ GARRISON_HOME: home });
    const ingress = new Ingress({
      cfg: { ...cfgIngress, enabled: true, secrets: { ...cfgIngress.secrets, webhookSecret: "s" } },
      store,
      counters: new Counters(store.root, "server")
    });
    ingress.processEntry({
      kind: "day_summary",
      uid: UID,
      bodyText: readFileSync(path.join(FIXTURES, "day-summary.json"), "utf8"),
      receivedAt: "2026-07-30T08:00:00.000Z"
    });
    // Decisions only backfeed from TRIAGED events.
    for (const ev of store.listEvents("pending")) {
      store.updateEvent(ev.id, (e) => ({ ...e, status: "triaged" }));
    }
  }
  const { api, sent } = makeApiRecorder(opts.apiScript);
  const cfg = {
    ...loadConfig({ GARRISON_HOME: home }),
    backfeedEnabled: true,
    ...(opts.cfg ?? {})
  };
  const backfeed = new Backfeed({
    cfg,
    store,
    counters,
    omiApi: api,
    board: makeBoard(opts.cards ?? []),
    cardUrlFn: async (id: string) => `https://box.ts.net:8489/#/cards/${id}`,
    log: { log: () => {}, error: () => {} }
  });
  return { backfeed, store, counters, sent };
}

const DONE_CARD = {
  id: CARD_ID,
  title: "Ship the beta email",
  list: "done",
  updated: new Date().toISOString(),
  lastReply: "Sent the beta email to 142 subscribers. Auth used key sk-abc123def456ghi789 internally."
};

describe("omi-channel backfeed", () => {
  it("sends completed cards + decisions once; a second run is a no-op (idempotent)", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-backfeed-"));
    try {
      const { backfeed, sent } = makeDeps(home, { cards: [DONE_CARD], seedDecisions: true });
      const first = await backfeed.runOnce();
      expect(first.sent).toBe(2); // 1 done card + 1 decision (fixture day summary)
      expect(first.failed).toBe(0);

      const second = await backfeed.runOnce();
      expect(second.sent).toBe(0);
      expect(second.deduped).toBeGreaterThanOrEqual(1);
      expect(sent).toHaveLength(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses the Import API shape: sk_ key, /user/memories path, uid query, structured memories", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-backfeed-shape-"));
    try {
      const { backfeed, sent } = makeDeps(home, { cards: [DONE_CARD] });
      await backfeed.runOnce();
      expect(sent).toHaveLength(1);
      const url = new URL(sent[0].url);
      expect(url.pathname).toBe("/v2/integrations/app_123/user/memories");
      expect(url.searchParams.get("uid")).toBe(UID);
      const body = sent[0].body as { memories: Array<{ content: string; tags: string[] }>; text_source: string };
      expect(body.text_source).toBe("other");
      expect(body.memories).toHaveLength(1);
      expect(body.memories[0].tags).toContain("garrison");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("templates carry no secrets and no internal ids beyond the deep link", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-backfeed-hygiene-"));
    try {
      const { backfeed, sent } = makeDeps(home, { cards: [DONE_CARD], seedDecisions: true });
      await backfeed.runOnce();
      for (const call of sent) {
        const body = call.body as { memories: Array<{ content: string }> };
        for (const memory of body.memories) {
          expect(memory.content).not.toContain("sk-abc123"); // redacted
          expect(memory.content).not.toMatch(/capture event/i);
          // The card ULID may appear ONLY inside the deep link.
          const withoutLink = memory.content.replace(/https:\/\/\S+/g, "");
          expect(withoutLink).not.toContain(CARD_ID);
        }
      }
      const cardMemory = (sent[0].body as { memories: Array<{ content: string }> }).memories[0].content;
      expect(cardMemory).toContain("Garrison completed: Ship the beta email.");
      expect(cardMemory).toContain(`Card: https://box.ts.net:8489/#/cards/${CARD_ID}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is off by default and skips cleanly when unconfigured", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-backfeed-off-"));
    try {
      const off = makeDeps(home, { cards: [DONE_CARD], cfg: { backfeedEnabled: false } });
      expect((await off.backfeed.runOnce()).skipped).toBe("backfeed disabled");
      expect(off.sent).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("stops the run on a non-retriable failure instead of hammering the API", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-backfeed-403-"));
    try {
      const { backfeed, sent } = makeDeps(home, {
        cards: [DONE_CARD],
        seedDecisions: true,
        apiScript: [403]
      });
      const summary = await backfeed.runOnce();
      expect(summary.failed).toBe(1);
      expect(String(summary.skipped)).toContain("stopped");
      expect(sent).toHaveLength(1); // did not try the second candidate
      // Nothing was ledgered - a later run with fixed creds sends everything.
      const retry = makeDeps(home, { cards: [DONE_CARD], seedDecisions: false });
      const retrySummary = await retry.backfeed.runOnce();
      expect(retrySummary.sent).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("emits the daily digest at most once per day", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-backfeed-digest-"));
    try {
      const { backfeed, sent } = makeDeps(home, {
        cards: [DONE_CARD],
        cfg: { backfeedKinds: ["daily_digest"] }
      });
      const first = await backfeed.runOnce();
      expect(first.sent).toBe(1);
      const digest = (sent[0].body as { memories: Array<{ content: string }> }).memories[0].content;
      expect(digest).toContain("Garrison digest");
      expect(digest).toContain("Ship the beta email");
      const second = await backfeed.runOnce();
      expect(second.sent).toBe(0);
      expect(second.deduped).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("retries retriable Import API failures with backoff", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-backfeed-retry-"));
    try {
      const { backfeed, sent } = makeDeps(home, { cards: [DONE_CARD], apiScript: [429, 200] });
      const summary = await backfeed.runOnce();
      expect(summary.sent).toBe(1);
      expect(sent).toHaveLength(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("fingerprint is stable and kind-scoped", () => {
    expect(fingerprint("decisions", "x")).toBe(fingerprint("decisions", "x"));
    expect(fingerprint("decisions", "x")).not.toBe(fingerprint("completed_cards", "x"));
  });
});
