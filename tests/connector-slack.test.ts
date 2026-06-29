import { describe, expect, it } from "vitest";
import { CATALOG, runAction } from "../fittings/seed/slack-channel/scripts/connector.mjs";

// C4 — Slack dual connector (also a Channel). The connector half does outbound
// Slack Web API actions with a scoped bot token.

const ENV = { SLACK_BOT_TOKEN: "xoxb-1" };

function mockFetch(cap: { url?: string; opts?: any }, body: unknown) {
  return async (url: string, opts?: any) => {
    cap.url = url;
    cap.opts = opts;
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
}

describe("slack connector (C4)", () => {
  it("catalog has send_message + list_channels", () => {
    expect(CATALOG.service).toBe("slack");
    expect(CATALOG.actions.map((a: any) => a.name)).toEqual(expect.arrayContaining(["send_message", "list_channels"]));
  });

  it("send_message posts to chat.postMessage with a Bearer token", async () => {
    const cap: { url?: string; opts?: any } = {};
    await runAction({
      action: "send_message",
      args: { channel: "#revenue", text: "New payment" },
      env: ENV,
      fetchImpl: mockFetch(cap, { ok: true, ts: "1" })
    });
    expect(cap.url).toContain("chat.postMessage");
    expect(cap.opts!.headers.Authorization).toBe("Bearer xoxb-1");
    expect(JSON.parse(cap.opts!.body)).toMatchObject({ channel: "#revenue", text: "New payment" });
  });

  it("surfaces a Slack logical error (HTTP 200 + ok:false)", async () => {
    await expect(
      runAction({ action: "send_message", args: { channel: "x" }, env: ENV, fetchImpl: mockFetch({}, { ok: false, error: "channel_not_found" }) })
    ).rejects.toThrow(/channel_not_found/);
  });

  it("throws awaiting_connector when the token is missing", async () => {
    await expect(runAction({ action: "send_message", args: {}, env: {}, fetchImpl: mockFetch({}, {}) })).rejects.toMatchObject({
      awaiting_connector: true
    });
  });
});
