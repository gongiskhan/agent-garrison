import { describe, expect, it } from "vitest";
import { rewriteHostUrl, isImagePath, filePathHtml, fileHref } from "../src/lib/host-rewrite";
import { pickServePort } from "../src/lib/tailnet-publish";

const TAILNET = { hostname: "dev-madrid.tail31efa.ts.net", protocol: "https:" };
const SERVE_MAP = { "8089": "https://dev-madrid.tail31efa.ts.net:8489" };

describe("rewriteHostUrl", () => {
  it("rewrites a loopback URL to its tailnet serve URL, preserving path/query/hash", () => {
    const out = rewriteHostUrl("http://127.0.0.1:8089/#/cards/01KY3M44", { ...TAILNET, serveMap: SERVE_MAP });
    expect(out).toBe("https://dev-madrid.tail31efa.ts.net:8489/#/cards/01KY3M44");
  });

  it("preserves a query string across the rewrite", () => {
    const out = rewriteHostUrl("http://localhost:8089/x?a=1&b=2#frag", { ...TAILNET, serveMap: SERVE_MAP });
    expect(out).toBe("https://dev-madrid.tail31efa.ts.net:8489/x?a=1&b=2#frag");
  });

  it("returns '' (unreachable) on an HTTPS page when the port has no serve mapping", () => {
    const out = rewriteHostUrl("http://127.0.0.1:9999/z", { ...TAILNET, serveMap: SERVE_MAP });
    expect(out).toBe("");
  });

  it("host-rebinds to the page host on a plain-HTTP page (LAN, not mixed content)", () => {
    const out = rewriteHostUrl("http://127.0.0.1:9999/z", { hostname: "100.64.0.5", protocol: "http:", serveMap: {} });
    expect(out).toBe("http://100.64.0.5:9999/z");
  });

  it("leaves the URL untouched when the client is itself on loopback (local dev)", () => {
    const url = "http://127.0.0.1:8089/#/cards/1";
    expect(rewriteHostUrl(url, { hostname: "127.0.0.1", protocol: "http:", serveMap: SERVE_MAP })).toBe(url);
    expect(rewriteHostUrl(url, { hostname: "localhost", protocol: "http:", serveMap: SERVE_MAP })).toBe(url);
  });

  it("never touches a non-loopback URL", () => {
    const url = "https://example.com/a/b?c=1";
    expect(rewriteHostUrl(url, { ...TAILNET, serveMap: SERVE_MAP })).toBe(url);
  });

  it("is SSR-safe (empty host -> unchanged)", () => {
    const url = "http://127.0.0.1:8089/x";
    expect(rewriteHostUrl(url, { hostname: "", protocol: "", serveMap: SERVE_MAP })).toBe(url);
  });

  it("handles all loopback host forms", () => {
    for (const host of ["127.0.0.1", "localhost", "0.0.0.0", "[::1]"]) {
      const out = rewriteHostUrl(`http://${host}:8089/p`, { ...TAILNET, serveMap: SERVE_MAP });
      expect(out).toBe("https://dev-madrid.tail31efa.ts.net:8489/p");
    }
  });
});

describe("file-path helpers", () => {
  it("classifies image extensions", () => {
    expect(isImagePath("/a/b/shot.png")).toBe(true);
    expect(isImagePath("/a/b/doc.md")).toBe(false);
  });

  it("renders an inline <img> for an image path via the /file endpoint", () => {
    const html = filePathHtml("/home/x/.garrison/uploads/1737-ab-shot.png");
    expect(html).toContain("<img");
    expect(html).toContain(fileHref("/home/x/.garrison/uploads/1737-ab-shot.png"));
    expect(html).toContain("shot.png");
  });

  it("renders a labelled link for a non-image file", () => {
    const html = filePathHtml("/home/x/.garrison/runs/proj/01/FLOW_PLAN.md");
    expect(html).toContain("<a ");
    expect(html).toContain("FLOW_PLAN.md");
  });

  it("encodes the path in the /file href", () => {
    expect(fileHref("/a b/c.png")).toBe("/file?path=%2Fa%20b%2Fc.png");
  });
});

describe("pickServePort", () => {
  it("uses 8400 + (localPort % 1000)", () => {
    expect(pickServePort(27086, new Set())).toBe(8486);
    expect(pickServePort(8089, new Set())).toBe(8489);
  });

  it("bumps past a collision", () => {
    expect(pickServePort(8089, new Set([8489]))).toBe(8490);
  });

  it("skips the reserved 8443/8444/8445/443", () => {
    // localPort 43 -> 8443 (reserved) -> bumps to 8446 (8444/8445 also reserved).
    expect(pickServePort(43, new Set())).toBe(8446);
  });
});
