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

  // A tethered node (csg) has no tailnet interface of its own - appOrigin (its
  // owner's published tailnet serve URL) is the only real address, and wins
  // over any tailnetHost when both happen to be present.
  describe("a tethered node's appOrigin", () => {
    it("is preferred over tailnetHost when present and https", () => {
      expect(nodeAppOrigin(null, "https://dev-madrid.tail31efa.ts.net:8977")).toBe("https://dev-madrid.tail31efa.ts.net:8977");
      expect(nodeAppOrigin("csg-has-no-real-tailnet-host", "https://dev-madrid.tail31efa.ts.net:8977")).toBe(
        "https://dev-madrid.tail31efa.ts.net:8977"
      );
      expect(nodePageUrl(null, "/talk", "", "https://dev-madrid.tail31efa.ts.net:8977")).toBe(
        "https://dev-madrid.tail31efa.ts.net:8977/talk"
      );
    });

    it("falls back to tailnetHost when appOrigin is absent, empty, or not https", () => {
      expect(nodeAppOrigin("x.example", undefined)).toBe("https://x.example");
      expect(nodeAppOrigin("x.example", null)).toBe("https://x.example");
      expect(nodeAppOrigin("x.example", "")).toBe("https://x.example");
      expect(nodeAppOrigin("x.example", "http://insecure.example")).toBe("https://x.example");
      expect(nodeAppOrigin("x.example", "not a url")).toBe("https://x.example");
    });

    it("normalizes a trailing slash/path off the appOrigin to a bare origin", () => {
      expect(nodeAppOrigin(null, "https://dev-madrid.tail31efa.ts.net:8977/")).toBe("https://dev-madrid.tail31efa.ts.net:8977");
      expect(nodeAppOrigin(null, "https://dev-madrid.tail31efa.ts.net:8977/some/path")).toBe(
        "https://dev-madrid.tail31efa.ts.net:8977"
      );
    });

    it("sameNodeOrigin matches against appOrigin the same way", () => {
      expect(sameNodeOrigin("https://dev-madrid.tail31efa.ts.net:8998", null, "https://dev-madrid.tail31efa.ts.net:8998")).toBe(
        true
      );
      expect(sameNodeOrigin("https://dev-madrid.tail31efa.ts.net:8998", null, "https://dev-madrid.tail31efa.ts.net:8977")).toBe(
        false
      );
    });
  });
});
