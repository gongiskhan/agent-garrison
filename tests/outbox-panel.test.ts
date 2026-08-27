// The §8.4 cancel surface: the shell's outbox aggregation + the dashboard strip.
//
// What this has to prove is mostly about honesty, not merging:
//
//   1. A Fitting WITHOUT a buffer (404) and a Fitting whose port is dead are
//      both "not for you" and must be skipped in silence. If either turned into
//      an error, the dashboard would break the moment a fitting restarted - and
//      the strip that is empty 99% of the time would be the loudest thing on
//      the page.
//   2. The 409 after the window elapses must reach the user UNCHANGED. That is
//      the one moment the buffer stops working, and softening it into "cancelled"
//      would tell someone a message they watched go out never went.
//   3. No fitting URL may reach the browser. Those are `http://127.0.0.1:<port>`
//      on THIS box; the reader is almost never on it (HARD RULE in CLAUDE.md).
//
// The routes are driven directly against two real fake fitting servers. The
// component follows tests/feedback-card.test.ts: vitest runs `environment:
// "node"` with no jsdom, so the decisions are PURE functions driven directly and
// the markup goes through react-dom/server, which needs no DOM.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// Type-only: erased at compile time, so it cannot pull the component in ahead
// of the CSS-module mock below.
import type { PendingSend } from "@/components/garrison/OutboxStrip";

// The component imports its CSS module. Vitest's default `css: false` already
// hands one back as a harmless proxy; mocking it makes that explicit, so a class
// name can never be the reason this file fails.
vi.mock("@/components/garrison/GarrisonHome.module.css", () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) })
}));

const { GET } = await import("@/app/api/outbox/route");
const { POST } = await import("@/app/api/outbox/cancel/route");
const {
  PendingSends,
  cancelOutcome,
  countdownLabel,
  noteFor,
  rowKey,
  secondsRemaining,
  visibleRows,
  OUTBOX_NOTE_TTL_MS,
  OUTBOX_POLL_MS
} = await import("@/components/garrison/OutboxStrip");

const h = React.createElement;
const render = (el: React.ReactElement): string => renderToStaticMarkup(el);

const priorHome = process.env.GARRISON_HOME;
let home: string;
const servers: http.Server[] = [];

/** A fake own-port Fitting. Returns its loopback base, as a status file would. */
async function fakeFitting(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The discovery contract: ~/.garrison/ui-fittings/<id>.json carrying {url}. */
function statusFile(fittingId: string, url: string): void {
  const dir = path.join(home, "ui-fittings");
  mkdirSync(dir, { recursive: true });
  const port = Number(new URL(url).port);
  writeFileSync(
    path.join(dir, `${fittingId}.json`),
    JSON.stringify({ fittingId, port, url, pid: 4242, startedAt: "2026-08-13T09:00:00.000Z" })
  );
}

function jsonRes(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const WHATSAPP_ENTRY = {
  id: "ob_1",
  action: "send_text",
  to: "351912345678@s.whatsapp.net",
  preview: "Confirming tomorrow at 10.",
  summary: "WhatsApp to 351912345678@s.whatsapp.net",
  context: "agent",
  status: "pending",
  queuedAt: "2026-08-13T09:00:00.000Z",
  executeAt: "2026-08-13T09:01:00.000Z"
};
const SLACK_ENTRY = {
  id: "ob_2",
  action: "send_message",
  to: "#engineering",
  preview: "Deploy is green.",
  summary: "Slack to #engineering",
  context: "automation",
  status: "pending",
  queuedAt: "2026-08-13T08:59:30.000Z",
  // Earlier than the WhatsApp one: the merge must put this first.
  executeAt: "2026-08-13T09:00:30.000Z"
};

/** whatsapp-web: one parked send, and a cancel that succeeds. */
async function bootWhatsapp(): Promise<{ cancels: string[] }> {
  const cancels: string[] = [];
  const url = await fakeFitting((req, res) => {
    if (req.method === "GET" && req.url === "/outbox") {
      return jsonRes(res, 200, { ok: true, pending: [WHATSAPP_ENTRY] });
    }
    const match = /^\/outbox\/([^/]+)\/cancel$/.exec(req.url ?? "");
    if (req.method === "POST" && match) {
      cancels.push(decodeURIComponent(match[1]));
      if (match[1] === "ob_1") {
        return jsonRes(res, 200, { ok: true, status: "cancelled", entry: { ...WHATSAPP_ENTRY, status: "cancelled" } });
      }
      return jsonRes(res, 404, { ok: false, status: "unknown", error: `no outbox entry ${match[1]}` });
    }
    return jsonRes(res, 404, { ok: false, error: "not found" });
  });
  statusFile("whatsapp-web", url);
  return { cancels };
}

/** slack-channel: one parked send whose window has already elapsed. */
async function bootSlack(): Promise<void> {
  const url = await fakeFitting((req, res) => {
    if (req.method === "GET" && req.url === "/outbox") {
      return jsonRes(res, 200, {
        ok: true,
        // A junk entry rides along: it must be dropped, not rendered as a
        // cancel button that could never work.
        pending: [SLACK_ENTRY, { action: "send_message", to: "#noise" }]
      });
    }
    if (req.method === "POST" && /^\/outbox\/[^/]+\/cancel$/.test(req.url ?? "")) {
      return jsonRes(res, 409, { ok: false, status: "sent", error: "already sent", entry: { ...SLACK_ENTRY, status: "sent" } });
    }
    return jsonRes(res, 404, { ok: false, error: "not found" });
  });
  statusFile("slack-channel", url);
}

/** dev-env: a live own-port Fitting with no buffer at all. 404, not an error. */
async function bootBufferless(): Promise<{ hits: number }> {
  const state = { hits: 0 };
  const url = await fakeFitting((req, res) => {
    state.hits += 1;
    return jsonRes(res, 404, { ok: false, error: "not found" });
  });
  statusFile("dev-env", url);
  return state;
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "outbox-panel-"));
  process.env.GARRISON_HOME = home;
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  rmSync(home, { recursive: true, force: true });
  if (priorHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = priorHome;
});

// ── GET /api/outbox ──────────────────────────────────────────────────────────

describe("GET /api/outbox", () => {
  it("merges every fitting that holds a buffer, soonest window first", async () => {
    await bootWhatsapp();
    await bootSlack();

    const body = await (await GET()).json();
    expect(body.pending.map((p: PendingSend) => [p.fitting, p.id])).toEqual([
      // Slack's window closes 30s before WhatsApp's, so it is the one running out.
      ["slack-channel", "ob_2"],
      ["whatsapp-web", "ob_1"]
    ]);
    expect(body.pending[0]).toEqual({
      fitting: "slack-channel",
      id: "ob_2",
      to: "#engineering",
      preview: "Deploy is green.",
      context: "automation",
      queuedAt: "2026-08-13T08:59:30.000Z",
      executeAt: "2026-08-13T09:00:30.000Z"
    });
    expect(Date.parse(body.checkedAt)).toBeGreaterThan(0);
  });

  it("skips a fitting that answers 404 - no buffer is a not-for-you, not a failure", async () => {
    await bootWhatsapp();
    const bufferless = await bootBufferless();

    const body = await (await GET()).json();
    // It was asked (discovery is an enumeration, not a registry) and it said no.
    expect(bufferless.hits).toBe(1);
    expect(body.pending.map((p: PendingSend) => p.fitting)).toEqual(["whatsapp-web"]);
  });

  it("skips a dead port without failing the read", async () => {
    await bootWhatsapp();
    // A status file left behind by a fitting that is no longer listening.
    const dead = await fakeFitting(() => {});
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    statusFile("outposts", dead);

    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).pending.map((p: PendingSend) => p.fitting)).toEqual(["whatsapp-web"]);
  });

  it("drops an entry with no id rather than rendering an uncancellable row", async () => {
    await bootSlack();
    const body = await (await GET()).json();
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0].id).toBe("ob_2");
  });

  it("never hands the browser a fitting's loopback URL", async () => {
    await bootWhatsapp();
    await bootSlack();
    const raw = JSON.stringify(await (await GET()).json());
    expect(raw).not.toContain("127.0.0.1");
    expect(raw).not.toContain("localhost");
  });

  it("is an empty list, not an error, when no fitting is running at all", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).pending).toEqual([]);
  });
});

// ── POST /api/outbox/cancel ──────────────────────────────────────────────────

function cancelRequest(body: unknown): any {
  return new Request("http://localhost/api/outbox/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("POST /api/outbox/cancel", () => {
  it("proxies the cancel to the fitting holding the send", async () => {
    const whatsapp = await bootWhatsapp();

    const res = await POST(cancelRequest({ fitting: "whatsapp-web", id: "ob_1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "cancelled" });
    expect(whatsapp.cancels).toEqual(["ob_1"]);
  });

  it("passes the 409 already-sent through verbatim instead of softening it", async () => {
    await bootSlack();

    const res = await POST(cancelRequest({ fitting: "slack-channel", id: "ob_2" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, status: "sent", error: "already sent" });
  });

  it("passes the fitting's 404 for an id it does not hold", async () => {
    await bootWhatsapp();

    const res = await POST(cancelRequest({ fitting: "whatsapp-web", id: "ob_nope" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, status: "unknown" });
  });

  it("404s a fitting that is not running, without naming a host to reach", async () => {
    await bootWhatsapp();

    const res = await POST(cancelRequest({ fitting: "gmail", id: "ob_1" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, status: "unknown" });
  });

  it("400s a body missing either half of the address", async () => {
    await bootWhatsapp();
    for (const body of [{}, { fitting: "whatsapp-web" }, { id: "ob_1" }, { fitting: "", id: "" }]) {
      const res = await POST(cancelRequest(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("reports unreachable rather than a cancellation that did not happen", async () => {
    const dead = await fakeFitting(() => {});
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    statusFile("whatsapp-web", dead);

    const res = await POST(cancelRequest({ fitting: "whatsapp-web", id: "ob_1" }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    // Not "cancelled": the send may still be parked and may still go out.
    expect(body.status).toBe("unreachable");
  });
});

// ── The strip ────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-08-13T09:00:00.000Z");
const ROW: PendingSend = {
  fitting: "whatsapp-web",
  id: "ob_1",
  to: "351912345678@s.whatsapp.net",
  preview: "Confirming tomorrow at 10.",
  context: "agent",
  queuedAt: "2026-08-13T08:59:30.000Z",
  executeAt: "2026-08-13T09:00:42.000Z"
};

type StripProps = Parameters<typeof PendingSends>[0];

const strip = (props: Partial<StripProps> = {}): string => {
  const merged: StripProps = {
    rows: [ROW],
    notes: {},
    busy: {},
    now: NOW,
    onCancel: () => {},
    ...props
  };
  return render(h(PendingSends, merged));
};

describe("the countdown", () => {
  it("is the real seconds left in the window, rounded up", () => {
    expect(secondsRemaining(ROW.executeAt, NOW)).toBe(42);
    expect(secondsRemaining(ROW.executeAt, NOW + 41_500)).toBe(1);
  });

  it("floors at zero and reads as sending rather than as a negative number", () => {
    expect(secondsRemaining(ROW.executeAt, NOW + 60_000)).toBe(0);
    expect(countdownLabel(0)).toBe("sending now");
    expect(countdownLabel(42)).toBe("42s");
    // An unparseable executeAt is still a row worth showing a cancel for.
    expect(secondsRemaining("not a date", NOW)).toBe(null);
    expect(countdownLabel(null)).toBe("due");
  });

  it("polls well inside the 60s window - a 60s poll would miss a whole send", () => {
    expect(OUTBOX_POLL_MS).toBeLessThanOrEqual(20_000);
  });
});

describe("PendingSends", () => {
  it("renders nothing at all when nothing is parked", () => {
    expect(strip({ rows: [] })).toBe("");
  });

  it("renders the destination, the preview, the countdown, the source and a cancel", () => {
    const markup = strip();
    expect(markup).toContain("351912345678@s.whatsapp.net");
    expect(markup).toContain("Confirming tomorrow at 10.");
    expect(markup).toContain(">42s<");
    expect(markup).toContain("whatsapp-web");
    expect(markup).toContain('data-testid="outbox-cancel-whatsapp-web:ob_1"');
    expect(markup).toContain("Cancel");
  });

  it("does not claim every outbound message is cancellable", () => {
    // gmail has no daemon and never appears here; the header must not imply
    // otherwise.
    expect(strip()).toContain("channels without a buffer send immediately");
  });

  it("marks the last ten seconds", () => {
    expect(strip({ now: NOW + 35_000 })).toContain("outboxCountLow");
    expect(strip()).not.toContain("outboxCountLow");
  });

  it("shows a 409 as already sent on the row, with the cancel spent", () => {
    const notes = { [rowKey(ROW)]: { row: ROW, label: "already sent", at: NOW, spent: true } };
    const markup = strip({ notes });
    expect(markup).toContain("already sent");
    // The countdown is replaced, not shown beside a message that already went.
    expect(markup).not.toContain(">42s<");
    expect(markup).toContain("disabled");
  });

  it("keeps the cancel live when the failure proves nothing about the send", () => {
    // Telling someone to try again and then disabling the control is worse than
    // not offering the retry.
    const notes = {
      [rowKey(ROW)]: { row: ROW, label: "could not cancel - try again", at: NOW, spent: false }
    };
    const markup = strip({ notes });
    expect(markup).toContain("could not cancel - try again");
    expect(markup).not.toContain("disabled");
  });

  it("says cancelling while the round trip is in flight", () => {
    expect(strip({ busy: { [rowKey(ROW)]: true } })).toContain("Cancelling");
  });
});

describe("what the poll does to a settled row", () => {
  const sent = { row: ROW, label: "already sent", at: NOW, spent: true };

  it("keeps an already-sent row visible after the fitting stops listing it", () => {
    const notes = { [rowKey(ROW)]: sent };
    // The next poll no longer carries it - the send is no longer pending.
    expect(visibleRows([], notes, NOW + 1_000).map(rowKey)).toEqual(["whatsapp-web:ob_1"]);
    expect(noteFor(ROW, notes, NOW + 1_000)?.label).toBe("already sent");
  });

  it("lets it go once the note has been readable long enough", () => {
    const notes = { [rowKey(ROW)]: sent };
    expect(visibleRows([], notes, NOW + OUTBOX_NOTE_TTL_MS)).toEqual([]);
    expect(noteFor(ROW, notes, NOW + OUTBOX_NOTE_TTL_MS)).toBe(null);
  });

  it("never double-renders a row the poll still reports", () => {
    const notes = {
      [rowKey(ROW)]: { row: ROW, label: "could not cancel - try again", at: NOW, spent: false }
    };
    expect(visibleRows([ROW], notes, NOW + 1_000)).toHaveLength(1);
  });
});

describe("cancelOutcome", () => {
  it("removes the row on a cancel that landed, and on an id the buffer forgot", () => {
    expect(cancelOutcome(200, { status: "cancelled" })).toEqual({ removed: true, note: null, spent: false });
    expect(cancelOutcome(404, { status: "unknown" })).toEqual({ removed: true, note: null, spent: false });
  });

  it("keeps the row and states the truth when the window already elapsed", () => {
    expect(cancelOutcome(409, { status: "sent" })).toEqual({
      removed: false,
      note: "already sent",
      spent: true
    });
    // Any other terminal state the buffer grows still reads honestly.
    expect(cancelOutcome(409, { status: "failed" })).toEqual({
      removed: false,
      note: "already failed",
      spent: true
    });
  });

  it("never removes a row, and never spends the tap, on an answer that proves nothing", () => {
    for (const status of [500, 502, 503]) {
      const outcome = cancelOutcome(status, null);
      expect(outcome.removed, String(status)).toBe(false);
      expect(outcome.note).toBe("could not cancel - try again");
      // The send may still be parked, so the button has to stay usable.
      expect(outcome.spent, String(status)).toBe(false);
    }
  });
});

// Not covered here, and worth stating: the 15s poll and the 1s tick are wired
// in the container through window.setInterval, which needs a DOM this suite does
// not have. What that leaves unproven is the wiring, not the arithmetic - the
// countdown, the merge, and every cancel outcome are pure and driven directly
// above.
