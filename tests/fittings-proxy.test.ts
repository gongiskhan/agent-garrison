import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("@/lib/claude-home", () => ({ garrisonDir: () => "/unused-garrison" }));

import { GET } from "../src/app/api/fittings/proxy/[fittingId]/[[...path]]/route";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("tethered-node own-port view proxy", () => {
  it("rejects an invalid fittingId without touching the filesystem", async () => {
    const res = await GET(new Request("http://x/api/fittings/proxy/../secrets"), {
      params: { fittingId: "../secrets" }
    });
    expect(res.status).toBe(400);
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it("returns 502 when the fitting has no running status file", async () => {
    mocks.readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const res = await GET(new Request("http://x/api/fittings/proxy/kanban-loop"), {
      params: { fittingId: "kanban-loop" }
    });
    expect(res.status).toBe(502);
  });

  it("forwards to the fitting's local loopback port and strips hop-by-hop headers", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ port: 8089 }));
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("http://127.0.0.1:8089/board?x=1");
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/html", connection: "keep-alive" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(new Request("http://x/api/fittings/proxy/kanban-loop/board?x=1"), {
      params: { fittingId: "kanban-loop", path: ["board"] }
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("connection")).toBeNull();
    expect(await res.text()).toBe("ok");
    vi.unstubAllGlobals();
  });

  it("rewrites root-absolute asset references in proxied HTML to carry the proxy prefix", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ port: 8089 }));
    const html =
      '<html><head><link href="/kanban.css" rel="stylesheet"></head>' +
      '<body><script src="/kanban.bundle.js"></script>' +
      '<a href="//other-host/x">external</a>' +
      '<a href="/api/fittings/proxy/kanban-loop/already">already</a>' +
      "</body></html>";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }))
    );
    const res = await GET(new Request("http://x/api/fittings/proxy/kanban-loop"), {
      params: { fittingId: "kanban-loop" }
    });
    const body = await res.text();
    expect(body).toContain('href="/api/fittings/proxy/kanban-loop/kanban.css"');
    expect(body).toContain('src="/api/fittings/proxy/kanban-loop/kanban.bundle.js"');
    expect(body).toContain('href="//other-host/x"');
    expect(body).toContain('href="/api/fittings/proxy/kanban-loop/already"');
    vi.unstubAllGlobals();
  });

  it("rewrites root-absolute url() references in proxied CSS", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ port: 8089 }));
    const css = 'body { background: url("/icon.svg"); }';
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(css, { status: 200, headers: { "content-type": "text/css" } }))
    );
    const res = await GET(new Request("http://x/api/fittings/proxy/kanban-loop/kanban.css"), {
      params: { fittingId: "kanban-loop", path: ["kanban.css"] }
    });
    const body = await res.text();
    expect(body).toContain('url("/api/fittings/proxy/kanban-loop/icon.svg")');
    vi.unstubAllGlobals();
  });
});
