import { afterEach, describe, expect, it } from "vitest";
import { makeBrowserClient } from "../fittings/seed/automations/lib/browser-client.mjs";

const originalBrowserUrl = process.env.GARRISON_BROWSER_URL;

afterEach(() => {
  if (originalBrowserUrl === undefined) delete process.env.GARRISON_BROWSER_URL;
  else process.env.GARRISON_BROWSER_URL = originalBrowserUrl;
});

function response(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("automations browser client failure classification", () => {
  it("resolves a fixer-authored relative navigation against the current page", async () => {
    process.env.GARRISON_BROWSER_URL = "http://browser.test";
    const navigations: string[] = [];
    const deletedTabs: string[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/tabs") {
        return response(200, { id: "tab-1", url: "http://app.test/missing" });
      }
      if (pathname === "/tabs/tab-1/nav") {
        const body = JSON.parse(String(init?.body));
        navigations.push(body.url);
        return response(200, { ok: true, url: body.url });
      }
      if (pathname === "/tabs/tab-1" && init?.method === "DELETE") {
        deletedTabs.push("tab-1");
        return response(200, { ok: true });
      }
      throw new Error(`unexpected request: ${pathname}`);
    };

    const client = makeBrowserClient({ fetchImpl });
    await client.navigate("http://app.test/missing");
    await client.navigate("/chat");
    await client.close();

    expect(navigations).toEqual(["http://app.test/chat"]);
    expect(deletedTabs).toEqual(["tab-1"]);
    expect(client.tabId).toBeNull();
  });

  it("treats an invalid execute request as a recoverable page interaction", async () => {
    process.env.GARRISON_BROWSER_URL = "http://browser.test";
    const fetchImpl = async (url: string | URL | Request) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/tabs") return response(200, { id: "tab-1" });
      if (pathname === "/tabs/tab-1/execute") {
        return response(400, { ok: false, error: "action has no locator hint" });
      }
      throw new Error(`unexpected request: ${pathname}`);
    };

    const client = makeBrowserClient({ fetchImpl });

    await expect(client.execute({ action: "click" })).rejects.toMatchObject({
      recoverable: true
    });
    await expect(client.execute({ action: "click" })).rejects.not.toHaveProperty(
      "failure.class",
      "infrastructure"
    );
  });

  it("keeps an unavailable Browser service classified as infrastructure", async () => {
    process.env.GARRISON_BROWSER_URL = "http://browser.test";
    const fetchImpl = async (url: string | URL | Request) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/tabs") return response(503, { error: "service unavailable" });
      throw new Error(`unexpected request: ${pathname}`);
    };

    const client = makeBrowserClient({ fetchImpl });

    await expect(client.execute({ action: "click" })).rejects.toMatchObject({
      recoverable: false,
      failure: {
        class: "infrastructure",
        component: "browser",
        code: "browser-http-503",
        retryable: true
      }
    });
  });
});
