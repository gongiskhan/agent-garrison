import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
    // No env creds AND no internal token to self-resolve them -> not connected.
    const prev = process.env.GARRISON_INTERNAL_TOKEN_PATH;
    process.env.GARRISON_INTERNAL_TOKEN_PATH = path.join(os.tmpdir(), "garrison-no-such-internal-token");
    try {
      await expect(runAction({ action: "lists", env: {}, fetchImpl: mockFetch({}, []) })).rejects.toMatchObject({
        awaiting_connector: true
      });
    } finally {
      if (prev === undefined) delete process.env.GARRISON_INTERNAL_TOKEN_PATH;
      else process.env.GARRISON_INTERNAL_TOKEN_PATH = prev;
    }
  });

  // A direct call (not via the Automations engine) has no scoped creds in env;
  // the connector self-resolves them from Garrison's auth-env route.
  describe("self-resolves scoped creds when none are injected", () => {
    let dir: string;
    const prevPath = process.env.GARRISON_INTERNAL_TOKEN_PATH;
    const prevBase = process.env.GARRISON_BASE_URL;

    afterEach(() => {
      if (prevPath === undefined) delete process.env.GARRISON_INTERNAL_TOKEN_PATH;
      else process.env.GARRISON_INTERNAL_TOKEN_PATH = prevPath;
      if (prevBase === undefined) delete process.env.GARRISON_BASE_URL;
      else process.env.GARRISON_BASE_URL = prevBase;
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("POSTs auth-env with the internal token and uses the returned creds", async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "ttok-"));
      const tokenFile = path.join(dir, "internal-token");
      writeFileSync(tokenFile, "internal-secret", { mode: 0o600 });
      process.env.GARRISON_INTERNAL_TOKEN_PATH = tokenFile;
      process.env.GARRISON_BASE_URL = "http://127.0.0.1:9999";

      const seen: { authEnvUrl?: string; internalHeader?: string; listsUrl?: string } = {};
      const fetchImpl = async (url: string, opts?: any) => {
        if (url.includes("/auth-env")) {
          seen.authEnvUrl = url;
          seen.internalHeader = opts.headers["x-garrison-internal"];
          return { ok: true, status: 200, json: async () => ({ env: { TRELLO_KEY: "k2", TRELLO_TOKEN: "t2", TRELLO_BOARD_ID: "b2" } }), text: async () => "" };
        }
        seen.listsUrl = url;
        return { ok: true, status: 200, json: async () => [], text: async () => "[]" };
      };

      await runAction({ action: "lists", env: {}, fetchImpl });
      expect(seen.authEnvUrl).toBe("http://127.0.0.1:9999/api/connectors/trello/auth-env");
      expect(seen.internalHeader).toBe("internal-secret");
      expect(seen.listsUrl).toContain("/boards/b2/lists");
      expect(seen.listsUrl).toContain("key=k2");
      expect(seen.listsUrl).toContain("token=t2");
    });
  });

  it("rejects an unknown action", async () => {
    await expect(
      runAction({ action: "nope", env: CREDS, fetchImpl: mockFetch({}, {}) })
    ).rejects.toThrow(/unknown action/);
  });
});
