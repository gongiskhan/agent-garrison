import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../src/middleware";

function req(url: string, referer?: string): NextRequest {
  const headers = new Headers();
  if (referer) headers.set("referer", referer);
  return new NextRequest(new Request(url, { headers }));
}

describe("proxied-fitting runtime-fetch middleware", () => {
  it("rewrites a root-absolute runtime fetch when the Referer is a proxied fitting page", () => {
    const res = middleware(req("http://x/board?x=1", "http://x/api/fittings/proxy/kanban-loop"));
    expect(res.headers.get("x-middleware-rewrite")).toBe("http://x/api/fittings/proxy/kanban-loop/board?x=1");
  });

  it("rewrites a nested api path the same way", () => {
    const res = middleware(req("http://x/api/ports", "http://x/api/fittings/proxy/ports/"));
    expect(res.headers.get("x-middleware-rewrite")).toBe("http://x/api/fittings/proxy/ports/api/ports");
  });

  it("leaves a request alone when there is no Referer", () => {
    const res = middleware(req("http://x/api/conversation"));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("leaves a genuine shell route alone even with an unrelated Referer", () => {
    const res = middleware(req("http://x/api/conversation", "http://x/host-map"));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("does not rewrite a request that is already proxy-prefixed", () => {
    const res = middleware(req("http://x/api/fittings/proxy/kanban-loop/board", "http://x/api/fittings/proxy/kanban-loop"));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("ignores a malformed Referer header", () => {
    const res = middleware(req("http://x/board", "not-a-url"));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("forces http: on the rewrite target even when the request looks https (tailscale serve terminates TLS in front)", () => {
    const httpsReq = new NextRequest(
      new Request("https://dev-madrid.tail31efa.ts.net:8977/board", {
        headers: { referer: "https://dev-madrid.tail31efa.ts.net:8977/api/fittings/proxy/kanban-loop" }
      })
    );
    const res = middleware(httpsReq);
    const rewrite = res.headers.get("x-middleware-rewrite");
    expect(rewrite).not.toBeNull();
    expect(new URL(rewrite as string).protocol).toBe("http:");
  });
});
