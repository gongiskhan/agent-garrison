import { describe, expect, it } from "vitest";
import { nodeAppOrigin, nodePageUrl, sameNodeOrigin } from "../src/lib/node-switch";

describe("node switch URLs", () => {
  it("puts the current page on the peer's tailnet root", () => {
    expect(nodePageUrl("dev-madrid.tail31efa.ts.net", "/talk/abc", "?x=1")).toBe(
      "https://dev-madrid.tail31efa.ts.net/talk/abc?x=1"
    );
    expect(nodePageUrl("Dev-Madrid.tail31efa.ts.net.", "/", "")).toBe("https://dev-madrid.tail31efa.ts.net/");
    expect(nodePageUrl("dev-madrid.tail31efa.ts.net", "/mesh", "q=1")).toBe("https://dev-madrid.tail31efa.ts.net/mesh?q=1");
  });

  it("refuses anything that is not a bare host and never builds a protocol-relative path", () => {
    expect(nodeAppOrigin(null)).toBeNull();
    expect(nodeAppOrigin("")).toBeNull();
    expect(nodeAppOrigin("https://x.example")).toBeNull();
    expect(nodeAppOrigin("x.example:8777")).toBeNull();
    expect(nodeAppOrigin("x.example/path")).toBeNull();
    expect(nodePageUrl("x.example", "//evil.example/steal")).toBe("https://x.example/");
    expect(nodePageUrl("x.example", "no-slash")).toBe("https://x.example/");
  });

  it("matches an app node record's origin against a roster host", () => {
    expect(sameNodeOrigin("https://dev-madrid.tail31efa.ts.net", "dev-madrid.tail31efa.ts.net")).toBe(true);
    expect(sameNodeOrigin("https://DEV-MADRID.tail31efa.ts.net/", "dev-madrid.tail31efa.ts.net.")).toBe(true);
    expect(sameNodeOrigin("http://dev-madrid.tail31efa.ts.net", "dev-madrid.tail31efa.ts.net")).toBe(false);
    expect(sameNodeOrigin("https://other.tail31efa.ts.net", "dev-madrid.tail31efa.ts.net")).toBe(false);
    expect(sameNodeOrigin(null, "dev-madrid.tail31efa.ts.net")).toBe(false);
  });
});
