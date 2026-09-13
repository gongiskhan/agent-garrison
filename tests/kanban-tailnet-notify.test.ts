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

// System notices persist first. Reachable URLs are materialized only for mirrors.
import { deliverMessageMirrors } from "../packages/messages/system.mjs";
const PUBLIC_APP = "https://dev-madrid.tail31efa.ts.net";
async function storedNotice(key: string) {
  const receipt = await fanOutNotification({ title: "Card due", text: `Card: ${LOOPBACK_CARD}`, link: LOOPBACK_CARD, idempotencyKey: key });
  return (await __kanbanState.client.request("GET", `/v1/messages/${receipt[0].messageId}`)).message;
}
function capture() {
  const sent: any[] = [];
  const fetchImpl = async (url: any, init: any) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return new Response("{}"); };
  return { sent, fetchImpl };
}
describe("Messages mirror tailnet delivery", () => {
  it("rehosts body links and opens the stored message on the public app", async () => {
    const message = await storedNotice("tailnet-mapped"), { sent, fetchImpl } = capture();
    await deliverMessageMirrors(message, { targets: [{ id: "slack", url: "http://slack.fixture/notify" }], fetchImpl, serveMap: MAP, publicAppUrl: PUBLIC_APP });
    expect(sent[0].body.text).toContain(TAILNET_CARD);
    expect(sent[0].body.text).not.toContain("127.0.0.1");
    expect(sent[0].body.link).toBe(`${PUBLIC_APP}/messages/${message.id}`);
    expect(sent[0].body.actions[0].url).toBe(sent[0].body.link);
    expect(sent[0].body.path).toBe(`/messages/${message.id}`);
  });
  it("keeps local fixture links when no public mapping is configured", async () => {
    const message = await storedNotice("tailnet-local"), { sent, fetchImpl } = capture();
    await deliverMessageMirrors(message, { targets: [{ id: "web", url: "http://web.fixture/notify" }], fetchImpl });
    expect(sent[0].body.text).toContain(LOOPBACK_CARD);
    expect(sent[0].body.link).toBe(`/messages/${message.id}`);
  });
  it("discovers the shell notification route once and ignores the legacy web host", async () => {
    mkdirSync(join(GARRISON_HOME, "ui-fittings"), { recursive: true });
    writeFileSync(join(GARRISON_HOME, "ui-fittings", "slack-channel.json"), JSON.stringify({ url: "http://slack.fixture" }));
    writeFileSync(join(GARRISON_HOME, "ui-fittings", "web-channel-default.json"), JSON.stringify({ url: "http://legacy.fixture" }));
    const message = await storedNotice("tailnet-shell"), { sent, fetchImpl } = capture();
    await deliverMessageMirrors(message, { env: { GARRISON_HOME, GARRISON_APP_URL: "http://app.fixture", NODE_ENV: "test" }, fetchImpl, publicAppUrl: PUBLIC_APP });
    expect(sent.map(row => row.url).sort()).toEqual(["http://app.fixture/api/notify", "http://slack.fixture/notify"]);
  });
  it("honors the stored mirror target selection", async () => {
    const message = await storedNotice("tailnet-selected"), { sent, fetchImpl } = capture();
    await deliverMessageMirrors({ ...message, mirrorTargets: ["slack"] }, { targets: [{ id: "web", url: "http://web.fixture/notify" }, { id: "slack", url: "http://slack.fixture/notify" }], fetchImpl });
    expect(sent.map(row => row.url)).toEqual(["http://slack.fixture/notify"]);
  });
  it("uses the legacy web host only when the shell route is absent", async () => {
    const message = await storedNotice("tailnet-legacy"), { sent, fetchImpl } = capture();
    await deliverMessageMirrors(message, { env: { GARRISON_HOME, NODE_ENV: "test" }, fetchImpl });
    expect(sent.map(row => row.url).sort()).toEqual(["http://legacy.fixture/notify", "http://slack.fixture/notify"]);
  });
});
