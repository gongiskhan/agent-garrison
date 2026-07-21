import { describe, it, expect, afterEach, vi } from "vitest";
import { browserViewUrl, resolveViewUrl } from "@/components/fitting-views/browser-view-url";

// browserViewUrl rebinds an own-port view's loopback host to whatever host the
// browser is actually on, so view links work over Tailscale/LAN — not just
// localhost. Node test env has no `window`, so we stub it per case.
function setHost(hostname: string | undefined) {
  if (hostname === undefined) {
    vi.stubGlobal("window", undefined);
  } else {
    vi.stubGlobal("window", { location: { hostname } });
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("browserViewUrl", () => {
  it("rebinds loopback hosts to the browser host (Tailscale/LAN)", () => {
    setHost("goncalos-macbook-pro.tail31efa.ts.net");
    expect(browserViewUrl("http://127.0.0.1:27086")).toBe(
      "http://goncalos-macbook-pro.tail31efa.ts.net:27086"
    );
    expect(browserViewUrl("http://localhost:27083")).toBe(
      "http://goncalos-macbook-pro.tail31efa.ts.net:27083"
    );
    expect(browserViewUrl("http://0.0.0.0:27077")).toBe(
      "http://goncalos-macbook-pro.tail31efa.ts.net:27077"
    );
  });

  it("works against a bare Tailscale IP host", () => {
    setHost("100.108.210.116");
    expect(browserViewUrl("http://127.0.0.1:27086/dev")).toBe(
      "http://100.108.210.116:27086/dev"
    );
  });

  it("preserves scheme, port, path, query, and hash", () => {
    setHost("box.local");
    expect(browserViewUrl("http://127.0.0.1:27086/a/b?x=1&y=2#h")).toBe(
      "http://box.local:27086/a/b?x=1&y=2#h"
    );
    expect(browserViewUrl("https://localhost:8443/s")).toBe("https://box.local:8443/s");
  });

  it("leaves non-loopback hosts untouched", () => {
    setHost("box.local");
    expect(browserViewUrl("http://example.com:27086/a")).toBe("http://example.com:27086/a");
    expect(browserViewUrl("http://192.168.1.50:27086")).toBe("http://192.168.1.50:27086");
  });

  it("is a no-op when the browser is itself on localhost", () => {
    setHost("localhost");
    expect(browserViewUrl("http://127.0.0.1:27086")).toBe("http://127.0.0.1:27086");
    setHost("127.0.0.1");
    expect(browserViewUrl("http://127.0.0.1:27086")).toBe("http://127.0.0.1:27086");
  });

  it("returns the URL unchanged during SSR (no window)", () => {
    setHost(undefined);
    expect(browserViewUrl("http://127.0.0.1:27086")).toBe("http://127.0.0.1:27086");
  });

  it("does not rewrite a host that merely starts with a loopback substring", () => {
    setHost("box.local");
    // "localhostage.dev" must NOT be treated as the loopback host.
    expect(browserViewUrl("http://localhostage.dev:27086")).toBe(
      "http://localhostage.dev:27086"
    );
  });

  it("handles empty / nullish input", () => {
    setHost("box.local");
    expect(browserViewUrl("")).toBe("");
    expect(browserViewUrl(null)).toBe("");
    expect(browserViewUrl(undefined)).toBe("");
  });
});

describe("resolveViewUrl", () => {
  const TS = "goncalos-macbook-pro.tail31efa.ts.net";

  it("uses the loopback url when the browser is on localhost", () => {
    setHost("localhost");
    expect(
      resolveViewUrl({ url: "http://127.0.0.1:27086", tailnetUrl: `https://${TS}:8486` })
    ).toBe("http://127.0.0.1:27086");
  });

  it("uses the HTTPS tailnet url when reached over the matching tailnet host", () => {
    setHost(TS);
    expect(
      resolveViewUrl({ url: "http://127.0.0.1:27086", tailnetUrl: `https://${TS}:8486` })
    ).toBe(`https://${TS}:8486`);
  });

  it("falls back to a host rebind over the tailnet when the view is NOT serve-mapped", () => {
    setHost(TS);
    expect(resolveViewUrl({ url: "http://127.0.0.1:27086", tailnetUrl: null })).toBe(
      `http://${TS}:27086`
    );
    expect(resolveViewUrl({ url: "http://127.0.0.1:27086" })).toBe(`http://${TS}:27086`);
  });

  it("ignores a tailnetUrl whose host does not match the page host (stale mapping)", () => {
    setHost(TS);
    // tailnetUrl for a different machine -> don't trust it; rebind instead.
    expect(
      resolveViewUrl({ url: "http://127.0.0.1:27086", tailnetUrl: "https://other-box.ts.net:8486" })
    ).toBe(`http://${TS}:27086`);
  });

  it("returns the loopback url during SSR and for empty input", () => {
    setHost(undefined);
    expect(resolveViewUrl({ url: "http://127.0.0.1:27086", tailnetUrl: `https://${TS}:8486` })).toBe(
      "http://127.0.0.1:27086"
    );
    setHost(TS);
    expect(resolveViewUrl({ url: "" })).toBe("");
  });
});
