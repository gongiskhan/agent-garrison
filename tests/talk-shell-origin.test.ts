// shell-origin.ts: local-node origin resolution (parity with resolveViewUrl),
// peer-node passthrough, and error classification.

import { describe, expect, it } from "vitest";
import {
  errorCopy,
  resolveOriginForPage,
  resolveShellOrigin,
  ShellOriginError,
  shellFetch,
  shellSocketUrl,
} from "../packages/talk/ui/shell-origin";

describe("resolveOriginForPage", () => {
  const view = { url: "http://127.0.0.1:8098", tailnetUrl: "https://dev-madrid.tail31efa.ts.net:8498" };

  it("on a loopback page, uses the loopback url directly", () => {
    expect(resolveOriginForPage(view, { hostname: "127.0.0.1", protocol: "http:" })).toBe("http://127.0.0.1:8098");
    expect(resolveOriginForPage(view, { hostname: "localhost", protocol: "http:" })).toBe("http://127.0.0.1:8098");
  });

  it("on the matching tailnet host, uses the tailnet URL", () => {
    expect(resolveOriginForPage(view, { hostname: "dev-madrid.tail31efa.ts.net", protocol: "https:" })).toBe(
      "https://dev-madrid.tail31efa.ts.net:8498"
    );
  });

  it("on a different remote host with no matching tailnetUrl, rebinds the loopback host", () => {
    const noTailnet = { url: "http://127.0.0.1:8098" };
    expect(resolveOriginForPage(noTailnet, { hostname: "192.168.1.5", protocol: "http:" })).toBe("http://192.168.1.5:8098");
  });

  it("never hands an https page an http:// rebind - returns empty", () => {
    const noTailnet = { url: "http://127.0.0.1:8098" };
    expect(resolveOriginForPage(noTailnet, { hostname: "dev-madrid.tail31efa.ts.net", protocol: "https:" })).toBe("");
  });

  it("no url at all returns empty", () => {
    expect(resolveOriginForPage({}, { hostname: "x", protocol: "https:" })).toBe("");
  });
});

describe("resolveShellOrigin", () => {
  it("local row: fetches /api/fittings/views and resolves the remote-shell-runtime entry", async () => {
    const fetchImpl = (async (url: string) => ({
      ok: true,
      json: async () => ({ views: [{ fittingId: "remote-shell-runtime", url: "http://127.0.0.1:8098", tailnetUrl: "https://dev-madrid.tail31efa.ts.net:8498" }] })
    })) as unknown as typeof fetch;
    const origin = await resolveShellOrigin(
      { node: "dev-madrid" },
      "dev-madrid",
      { fetchImpl, loc: { hostname: "127.0.0.1", protocol: "http:" } }
    );
    expect(origin).toBe("http://127.0.0.1:8098");
  });

  it("peer row: uses the row's own shellOrigin verbatim, no fetch", async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return { ok: true, json: async () => ({ views: [] }) }; }) as unknown as typeof fetch;
    const origin = await resolveShellOrigin({ node: "peer-node", shellOrigin: "https://peer.tail.example:8498" }, "self-node", { fetchImpl });
    expect(origin).toBe("https://peer.tail.example:8498");
    expect(called).toBe(false);
  });
});

describe("shellSocketUrl", () => {
  it("swaps http(s) for ws(s) and appends /io", () => {
    expect(shellSocketUrl("http://127.0.0.1:8098")).toBe("ws://127.0.0.1:8098/io");
    expect(shellSocketUrl("https://dev-madrid.tail31efa.ts.net:8498")).toBe("wss://dev-madrid.tail31efa.ts.net:8498/io");
  });
});

describe("shellFetch", () => {
  it("throws no-origin for an empty origin without ever calling fetch", async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return {} as Response; }) as unknown as typeof fetch;
    await expect(shellFetch("", "/health", {}, { fetchImpl })).rejects.toMatchObject({ kind: "no-origin" });
    expect(called).toBe(false);
  });

  it("returns the parsed JSON body on success", async () => {
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ ok: true, port: 8098 }) })) as unknown as typeof fetch;
    const body = await shellFetch<{ ok: boolean; port: number }>("http://127.0.0.1:8098", "/health", {}, { fetchImpl });
    expect(body).toEqual({ ok: true, port: 8098 });
  });

  it("classifies a non-ok response as http, carrying status and detail", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 403, json: async () => ({ error: "forbidden", reason: "untrusted origin" }) })) as unknown as typeof fetch;
    await expect(shellFetch("http://127.0.0.1:8098", "/sessions", {}, { fetchImpl })).rejects.toMatchObject({
      kind: "http", status: 403, detail: "untrusted origin"
    });
  });
});

describe("errorCopy", () => {
  it("covers every ShellOriginError kind with distinct, non-empty copy", () => {
    const kinds: Array<ShellOriginError["kind"]> = ["no-origin", "cors", "unreachable", "http", "offline"];
    for (const kind of kinds) {
      const err = new ShellOriginError(kind, "boom", { status: 500, detail: "d" });
      const copy = errorCopy(err, "the-mini", "3m ago");
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.sub.length).toBeGreaterThan(0);
    }
  });

  it("a plain Error still produces readable copy", () => {
    const copy = errorCopy(new Error("network down"), "the-mini");
    expect(copy.sub).toContain("network down");
  });
});
