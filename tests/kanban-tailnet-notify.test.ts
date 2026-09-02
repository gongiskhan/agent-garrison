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

// The runner projects GARRISON_APP_URL into a live fitting; a vitest process
// may inherit it from the shell. Each fan-out describe pins its own value so
// the legacy status-file seam and the shell seam are each tested on purpose.
const INHERITED_APP_URL = process.env.GARRISON_APP_URL;
function restoreAppUrl() {
  if (INHERITED_APP_URL === undefined) delete process.env.GARRISON_APP_URL;
  else process.env.GARRISON_APP_URL = INHERITED_APP_URL;
}

describe("fanOutNotification (channel send boundary)", () => {
  beforeAll(() => {
    delete process.env.GARRISON_APP_URL;
    // One running notify-capable channel fitting so the fan-out has a target.
    mkdirSync(join(GARRISON_HOME, "ui-fittings"), { recursive: true });
    writeFileSync(
      join(GARRISON_HOME, "ui-fittings", "slack-channel.json"),
      JSON.stringify({ url: "http://127.0.0.1:9111" })
    );
  });
  afterAll(restoreAppUrl);

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

// The web channel is Conversations, a route of the Garrison shell. The shell's
// talk API is mounted under /api/*, so the app entry posts to /api/notify; the
// other channel fittings only accept /notify, so their path stays. A node that
// still runs the legacy own-port web-channel-default shares the shell's thread
// store, so it is dropped from the fan-out whenever the app is known - posting
// to both would deliver every notification twice.
describe("fanOutNotification (web channel hosted by the shell)", () => {
  const APP = "http://127.0.0.1:9333";
  const LEGACY_WEB = "http://127.0.0.1:9222";

  beforeAll(() => {
    mkdirSync(join(GARRISON_HOME, "ui-fittings"), { recursive: true });
    writeFileSync(
      join(GARRISON_HOME, "ui-fittings", "slack-channel.json"),
      JSON.stringify({ url: "http://127.0.0.1:9111" })
    );
    writeFileSync(
      join(GARRISON_HOME, "ui-fittings", "web-channel-default.json"),
      JSON.stringify({ url: LEGACY_WEB })
    );
  });
  afterAll(restoreAppUrl);

  function capture() {
    const sent: any[] = [];
    const fetchImpl: any = async (url: string, init: any) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    };
    return { sent, fetchImpl };
  }
  const NOTICE = { title: "Card due", text: `Card: ${LOOPBACK_CARD}`, link: LOOPBACK_CARD, actions: [] };

  it("posts the app entry to /api/notify and skips the legacy web-channel status file", async () => {
    process.env.GARRISON_APP_URL = `${APP}/`;
    const { sent, fetchImpl } = capture();
    const results = await fanOutNotification(NOTICE, { fetchImpl, serveMap: MAP });
    const urls = sent.map((s) => s.url);
    expect(urls).toContain(`${APP}/api/notify`);
    expect(urls).toContain("http://127.0.0.1:9111/notify");
    expect(urls.some((u) => u.startsWith(LEGACY_WEB))).toBe(false);
    // The shell surface keeps the legacy fitting's id so receipts and skip
    // lists name one web channel across both hosts.
    expect(results.find((r: any) => r.id === "web-channel-default")?.ok).toBe(true);
    expect(results.filter((r: any) => r.id === "web-channel-default")).toHaveLength(1);
    const app = sent.find((s) => s.url === `${APP}/api/notify`);
    expect(app.body.link).toBe(TAILNET_CARD);
  });

  it("honours skipFittingIds for the app entry under the web channel id", async () => {
    process.env.GARRISON_APP_URL = APP;
    const { sent, fetchImpl } = capture();
    await fanOutNotification(NOTICE, { fetchImpl, serveMap: MAP, skipFittingIds: ["web-channel-default"] });
    const urls = sent.map((s) => s.url);
    expect(urls).toEqual(["http://127.0.0.1:9111/notify"]);
  });

  it("falls back to the legacy status file at /notify when GARRISON_APP_URL is unset", async () => {
    delete process.env.GARRISON_APP_URL;
    const { sent, fetchImpl } = capture();
    await fanOutNotification(NOTICE, { fetchImpl, serveMap: MAP });
    const urls = sent.map((s) => s.url).sort();
    expect(urls).toEqual(["http://127.0.0.1:9111/notify", `${LEGACY_WEB}/notify`]);
    expect(urls.some((u) => u.endsWith("/api/notify"))).toBe(false);
  });
});
