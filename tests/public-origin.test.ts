import { describe, expect, it } from "vitest";
import { publicOrigin } from "@/lib/public-origin";

// Garrison is used from other machines over `tailscale serve`, which terminates
// TLS and proxies to loopback. Server-side, `new URL(request.url).origin` is the
// PROXY TARGET, so anything built from it and handed back to the client is
// unreachable. That is what broke the Google connector: consent succeeded, then
// Google redirected the browser to http://localhost:8777/... and it died on
// ERR_CONNECTION_REFUSED holding a valid code it could never spend.
function req(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { headers });
}

describe("publicOrigin", () => {
  it("prefers what the proxy says the browser used over the loopback target", () => {
    expect(publicOrigin(req("http://localhost:8777/api/x", {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "dev-madrid.tail31efa.ts.net",
      host: "localhost:8777"
    }))).toBe("https://dev-madrid.tail31efa.ts.net");
  });

  it("uses the forwarded Host with the forwarded scheme when only Host is rewritten", () => {
    // tailscale serve forwards the ORIGINAL tailnet Host, so the Host header
    // alone is already right; only the scheme needs the forwarded hint.
    expect(publicOrigin(req("http://localhost:8777/api/x", {
      "x-forwarded-proto": "https",
      host: "dev-madrid.tail31efa.ts.net"
    }))).toBe("https://dev-madrid.tail31efa.ts.net");
  });

  it("takes the FIRST entry when a proxy chain appends", () => {
    expect(publicOrigin(req("http://localhost:8777/api/x", {
      "x-forwarded-proto": "https, http",
      "x-forwarded-host": "dev-madrid.tail31efa.ts.net, inner.local"
    }))).toBe("https://dev-madrid.tail31efa.ts.net");
  });

  it("keeps a plain local session on http rather than assuming https", () => {
    // Direct hit on the box: no forwarded headers, and upgrading the scheme here
    // would break the ordinary localhost flow to fix the remote one.
    expect(publicOrigin(req("http://127.0.0.1:8777/api/x", { host: "127.0.0.1:8777" })))
      .toBe("http://127.0.0.1:8777");
  });

  it("falls back to the request URL when there is no Host at all", () => {
    expect(publicOrigin(req("http://127.0.0.1:8777/api/x"))).toBe("http://127.0.0.1:8777");
  });
});
