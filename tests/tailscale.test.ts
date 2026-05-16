import { describe, expect, it, beforeEach } from "vitest";
import { computeUrls, resolveTailscaleHostname, _resetTailscaleCacheForTests } from "@/lib/tailscale";

describe("tailscale", () => {
  beforeEach(() => {
    _resetTailscaleCacheForTests();
  });

  describe("computeUrls", () => {
    it("returns empty map when ports is undefined", () => {
      expect(computeUrls(undefined)).toEqual({});
    });

    it("returns empty map when ports is empty", () => {
      expect(computeUrls({})).toEqual({});
    });

    it("builds http URLs with explicit hostname", () => {
      const out = computeUrls({ frontend: 50000, backend: 50001 }, "100.90.155.85");
      expect(out).toEqual({
        frontend: "http://100.90.155.85:50000",
        backend: "http://100.90.155.85:50001"
      });
    });

    it("uses resolveTailscaleHostname when hostname omitted", () => {
      const host = resolveTailscaleHostname();
      const out = computeUrls({ app: 51234 });
      expect(out.app).toBe(`http://${host}:51234`);
    });
  });

  describe("resolveTailscaleHostname", () => {
    it("returns a non-empty string", () => {
      const host = resolveTailscaleHostname();
      expect(typeof host).toBe("string");
      expect(host.length).toBeGreaterThan(0);
    });

    it("caches the result across calls", () => {
      const a = resolveTailscaleHostname();
      const b = resolveTailscaleHostname();
      expect(a).toBe(b);
    });
  });
});
