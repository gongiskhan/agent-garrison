import { describe, it, expect } from "vitest";
import { rebindLoopback, resolveKanbanCardUrl } from "../fittings/seed/jarvis-os/ui/deep-link";

const BOARD = { available: true, boardUrl: "http://127.0.0.1:7089", tailnetUrl: "https://mac-mini-12.tail429717.ts.net:8489" };

describe("resolveKanbanCardUrl", () => {
  it("uses the loopback board URL when the page is on localhost", () => {
    expect(resolveKanbanCardUrl(BOARD, "CID1", "localhost")).toBe("http://127.0.0.1:7089/?card=CID1");
    expect(resolveKanbanCardUrl(BOARD, "CID1", "127.0.0.1")).toBe("http://127.0.0.1:7089/?card=CID1");
  });

  it("uses the HTTPS tailnet URL when the page host matches it (over Tailscale)", () => {
    expect(resolveKanbanCardUrl(BOARD, "CID2", "mac-mini-12.tail429717.ts.net")).toBe(
      "https://mac-mini-12.tail429717.ts.net:8489/?card=CID2"
    );
  });

  it("rebinds the loopback host for a generic remote/LAN host with no tailnet match", () => {
    expect(resolveKanbanCardUrl({ available: true, boardUrl: "http://127.0.0.1:7089", tailnetUrl: null }, "CID3", "192.168.1.5")).toBe(
      "http://192.168.1.5:7089/?card=CID3"
    );
  });

  it("returns null when the board is unavailable, has no URL, or no card id", () => {
    expect(resolveKanbanCardUrl({ available: false }, "CID", "localhost")).toBeNull();
    expect(resolveKanbanCardUrl({ available: true, boardUrl: "" }, "CID", "localhost")).toBeNull();
    expect(resolveKanbanCardUrl(BOARD, "", "localhost")).toBeNull();
    expect(resolveKanbanCardUrl(null, "CID", "localhost")).toBeNull();
  });

  it("percent-encodes the card id", () => {
    expect(resolveKanbanCardUrl(BOARD, "a b/c", "localhost")).toBe("http://127.0.0.1:7089/?card=a%20b%2Fc");
  });
});

describe("rebindLoopback", () => {
  it("swaps a loopback host for the given host, keeping scheme + port", () => {
    expect(rebindLoopback("http://127.0.0.1:7089", "box.local")).toBe("http://box.local:7089");
    expect(rebindLoopback("http://localhost:7089", "box.local")).toBe("http://box.local:7089");
  });
  it("leaves a non-loopback URL untouched", () => {
    expect(rebindLoopback("https://example.com:8489", "box.local")).toBe("https://example.com:8489");
  });
  it("returns the input unchanged when it isn't a valid URL", () => {
    expect(rebindLoopback("not a url", "box.local")).toBe("not a url");
  });
});
