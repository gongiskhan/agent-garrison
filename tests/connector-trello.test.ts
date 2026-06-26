import { describe, expect, it } from "vitest";
import { CATALOG, runAction } from "../fittings/seed/trello/scripts/connector.mjs";

// C1 — the Trello connector implements the uniform connector executor contract:
// a catalog + a `call` path that hits the Trello REST API with Vault-scoped
// creds (here injected via env + a mock fetch), and an awaiting_connector signal
// when not connected.

const CREDS = { TRELLO_KEY: "k", TRELLO_TOKEN: "t", TRELLO_BOARD_ID: "b" };

function mockFetch(captured: { url?: string; opts?: any }, body: unknown) {
  return async (url: string, opts?: any) => {
    captured.url = url;
    captured.opts = opts;
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
}

describe("trello connector (C1)", () => {
  it("exposes a connector catalog with mutating + read actions", () => {
    expect(CATALOG.service).toBe("trello");
    expect(CATALOG.auth).toBe("api_key");
    const names = CATALOG.actions.map((a: any) => a.name);
    expect(names).toEqual(expect.arrayContaining(["lists", "create_card", "move_card", "archive_card"]));
    expect(CATALOG.actions.find((a: any) => a.name === "create_card")?.mutates).toBe(true);
    expect(CATALOG.actions.find((a: any) => a.name === "lists")?.mutates).toBe(false);
  });

  it("lists hits the board lists endpoint with auth", async () => {
    const cap: { url?: string } = {};
    const result = await runAction({
      action: "lists",
      env: CREDS,
      fetchImpl: mockFetch(cap, [{ id: "1", name: "To Do" }])
    });
    expect(cap.url).toContain("/boards/b/lists");
    expect(cap.url).toContain("key=k");
    expect(cap.url).toContain("token=t");
    expect(result).toEqual([{ id: "1", name: "To Do" }]);
  });

  it("create_card POSTs the card body", async () => {
    const cap: { url?: string; opts?: any } = {};
    await runAction({
      action: "create_card",
      args: { list_id: "L", name: "ship it", desc: "d" },
      env: CREDS,
      fetchImpl: mockFetch(cap, { id: "card1" })
    });
    expect(cap.url).toContain("/cards?");
    expect(cap.opts!.method).toBe("POST");
    expect(JSON.parse(cap.opts!.body)).toMatchObject({ idList: "L", name: "ship it", desc: "d" });
  });

  it("throws awaiting_connector when creds are missing", async () => {
    await expect(runAction({ action: "lists", env: {}, fetchImpl: mockFetch({}, []) })).rejects.toMatchObject({
      awaiting_connector: true
    });
  });

  it("rejects an unknown action", async () => {
    await expect(
      runAction({ action: "nope", env: CREDS, fetchImpl: mockFetch({}, {}) })
    ).rejects.toThrow(/unknown action/);
  });
});
