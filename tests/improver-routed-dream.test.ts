import { describe, it, expect, vi, afterEach } from "vitest";
// @ts-ignore — pure .mjs
import { makeRoutedRunTurn, chooseDreamRunTurn, defaultRunTurn } from "../fittings/seed/improver/lib/memory-dream.mjs";

describe("improver dream routing (s6b — route the Improver through preRoute)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("chooseDreamRunTurn routes only when enabled + a gateway URL is set; else the default one-shot", () => {
    expect(chooseDreamRunTurn()).toBe(defaultRunTurn);
    expect(chooseDreamRunTurn({ routeViaGateway: false, gatewayUrl: "http://x" })).toBe(defaultRunTurn);
    expect(chooseDreamRunTurn({ routeViaGateway: true, gatewayUrl: null })).toBe(defaultRunTurn);
    const routed = chooseDreamRunTurn({ routeViaGateway: true, gatewayUrl: "http://127.0.0.1:24777" });
    expect(routed).not.toBe(defaultRunTurn);
    expect(typeof routed).toBe("function");
  });

  it("makeRoutedRunTurn posts the dream turn to the gateway /chat (pre-routed) and returns {reply}", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ reply: "consolidated", session_id: "s1" }) }));
    vi.stubGlobal("fetch", fetchMock);
    const rt = makeRoutedRunTurn("http://127.0.0.1:24777");
    const out = await rt({ systemPrompt: "SYS", message: "MSG", timeoutMs: 1000 });
    expect(out).toEqual({ reply: "consolidated" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe("http://127.0.0.1:24777/chat");
    const body = JSON.parse(opts.body);
    expect(body.channel).toBe("improver");
    expect(body.message).toContain("SYS");
    expect(body.message).toContain("MSG");
  });

  it("makeRoutedRunTurn throws on a non-ok gateway response (caller logs + the run continues)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    const rt = makeRoutedRunTurn("http://x");
    await expect(rt({ systemPrompt: "S", message: "M" })).rejects.toThrow(/503/);
  });

  it("makeRoutedRunTurn throws on a 200 with an empty/malformed reply (no silent empty dream)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ reply: "   " }) })));
    const rt = makeRoutedRunTurn("http://x");
    await expect(rt({ systemPrompt: "S", message: "M" })).rejects.toThrow(/empty\/invalid reply/);
  });

  it("the routed path DEGRADES to the fallback one-shot instead of crashing when the gateway fails (s6b r1)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED"); // gateway unreachable / timeout
    }));
    const fallback = vi.fn(async () => ({ reply: "one-shot result" }));
    const routed = chooseDreamRunTurn({ routeViaGateway: true, gatewayUrl: "http://x", fallback });
    const out = await routed({ systemPrompt: "S", message: "M" });
    expect(out).toEqual({ reply: "one-shot result" });
    expect(fallback).toHaveBeenCalledTimes(1); // fell back, did not throw
  });
});
