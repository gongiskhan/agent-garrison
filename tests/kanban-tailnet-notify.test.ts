// Card deep links delivered to a CHANNEL (Slack / Omi / web-on-phone) must be
// reachable off this box. The kanban-loop's message builders emit the canonical
// loopback board URL (right for on-machine consumers: the durable origin event
// log, local pull-delivery), so the loopback → HTTPS tailnet rehost happens at
// the send boundary. A phone reaching Garrison over the tailnet cannot open a
// http://127.0.0.1:<port> link (unreachable + mixed content); these pin that the
// per-channel deliveries carry the tailnet form while the transform stays a pure,
// map-driven function with a loopback fallback for local/dev.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GARRISON_HOME = mkdtempSync(join(tmpdir(), "tailnet-notify-home-"));
process.env.GARRISON_HOME = GARRISON_HOME;

// @ts-ignore — pure .mjs
import { serveMapFromStatus, rehostToTailnet, rehostTextToTailnet } from "../fittings/seed/kanban-loop/lib/tailnet-serve.mjs";
// @ts-ignore
import { fanOutNotification } from "../fittings/seed/kanban-loop/lib/notify-origin.mjs";

// The card store is the STATE SERVICE now, not files under GARRISON_KANBAN_DIR.
// Boot one for this file and project its discovery env before anything reads a
// card; side files still live under the kanban root this file already pins.
import { setupKanbanState } from "./kanban-state-env";
let __kanbanState: Awaited<ReturnType<typeof setupKanbanState>>;
beforeAll(async () => {
  __kanbanState = await setupKanbanState();
}, 30_000);
afterAll(async () => {
  await __kanbanState?.stop();
});


// A serve map with the board port (7089) mapped and one unrelated port.
const STATUS = {
  Web: {
    "dev-madrid.tail31efa.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7089" } } },
    "dev-madrid.tail31efa.ts.net:8444": { Handlers: { "/": { Proxy: "http://localhost:9999" } } }
  }
};
const MAP = serveMapFromStatus(STATUS);
const LOOPBACK_CARD = "http://127.0.0.1:7089/#/cards/01TESTCARD";
const TAILNET_CARD = "https://dev-madrid.tail31efa.ts.net:8443/#/cards/01TESTCARD";

describe("rehostTextToTailnet (pure body transform)", () => {
  it("rehosts the loopback deep link inside an outcome message, prose untouched", () => {
    const body = `Run complete — Add a CSV export button.\n\nDone.\n\nCard: ${LOOPBACK_CARD}`;
    const out = rehostTextToTailnet(body, MAP);
    expect(out).toContain(`Card: ${TAILNET_CARD}`);
    expect(out).toContain("Run complete — Add a CSV export button.");
    expect(out).not.toContain("127.0.0.1");
  });

  it("leaves an unmapped loopback link as-is (fallback keeps local/dev usable)", () => {
    // Port 7000 is not serve-mapped: no reachable tailnet form, keep loopback.
    const body = `Card: http://127.0.0.1:7000/#/cards/X`;
    expect(rehostTextToTailnet(body, MAP)).toBe(body);
  });

  it("is a no-op on text with no loopback URL and on non-strings", () => {
    expect(rehostTextToTailnet("no links here", MAP)).toBe("no links here");
    expect(rehostTextToTailnet(null, MAP)).toBe(null);
    expect(rehostTextToTailnet("", MAP)).toBe("");
  });

  it("rehostToTailnet returns null for unmapped ports and garbage", () => {
    expect(rehostToTailnet("http://127.0.0.1:7000/x", MAP)).toBeNull();
    expect(rehostToTailnet("not a url", MAP)).toBeNull();
    expect(rehostToTailnet(LOOPBACK_CARD, MAP)).toBe(TAILNET_CARD);
  });
});

describe("fanOutNotification (channel send boundary)", () => {
  beforeAll(() => {
    // One running notify-capable channel fitting so the fan-out has a target.
    mkdirSync(join(GARRISON_HOME, "ui-fittings"), { recursive: true });
    writeFileSync(
      join(GARRISON_HOME, "ui-fittings", "slack-channel.json"),
      JSON.stringify({ url: "http://127.0.0.1:9111" })
    );
  });

  it("rehosts text, link and action urls to the tailnet form for delivery", async () => {
    const sent: any[] = [];
    const fetchImpl: any = async (url: string, init: any) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    };
    const results = await fanOutNotification(
      {
        title: "Card due",
        text: `Scheduled: "X" is due.\n\nCard: ${LOOPBACK_CARD}`,
        link: LOOPBACK_CARD,
        actions: [{ label: "Open card", url: LOOPBACK_CARD }],
        tag: "card-01TESTCARD"
      },
      { fetchImpl, serveMap: MAP }
    );
    expect(results.some((r: any) => r.id === "slack-channel" && r.ok)).toBe(true);
    const notify = sent.find((s) => s.url.endsWith("/notify"));
    expect(notify).toBeTruthy();
    expect(notify.body.text).toContain(TAILNET_CARD);
    expect(notify.body.text).not.toContain("127.0.0.1");
    expect(notify.body.link).toBe(TAILNET_CARD);
    expect(notify.body.actions[0].url).toBe(TAILNET_CARD);
  });

  it("falls back to the loopback form when no port is serve-mapped", async () => {
    const sent: any[] = [];
    const fetchImpl: any = async (url: string, init: any) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    };
    await fanOutNotification(
      { title: "Card due", text: `Card: ${LOOPBACK_CARD}`, link: LOOPBACK_CARD, actions: [] },
      { fetchImpl, serveMap: new Map() }
    );
    const notify = sent.find((s) => s.url.endsWith("/notify"));
    expect(notify.body.link).toBe(LOOPBACK_CARD);
    expect(notify.body.text).toContain(LOOPBACK_CARD);
  });
});
