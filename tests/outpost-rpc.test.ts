import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expandHome,
  listOutposts,
  outpostRpc,
  parseTarget,
} from "@/lib/outpost-rpc";
import { homedir } from "node:os";
import path from "node:path";

describe("expandHome", () => {
  it("expands ~ prefix", () => {
    expect(expandHome("~/foo/bar")).toBe(path.join(homedir(), "foo/bar"));
  });

  it("expands bare ~", () => {
    expect(expandHome("~")).toBe(path.join(homedir(), ""));
  });

  it("leaves absolute paths unchanged", () => {
    expect(expandHome("/absolute/path")).toBe("/absolute/path");
  });
});

describe("parseTarget", () => {
  it("returns local for null", () => {
    expect(parseTarget(null)).toEqual({ kind: "local" });
  });

  it("returns local for 'local'", () => {
    expect(parseTarget("local")).toEqual({ kind: "local" });
  });

  it("parses outpost:<name>", () => {
    expect(parseTarget("outpost:development")).toEqual({
      kind: "outpost",
      name: "development",
    });
  });

  it("returns local for unrecognised strings", () => {
    expect(parseTarget("random")).toEqual({ kind: "local" });
  });
});

describe("outpostRpc", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to the correct path and unwraps payload", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        result: { payload: { content: "hello" } },
      }),
    });

    const result = await outpostRpc<{ content: string }>(
      "dev",
      "fs.read",
      { path: "/tmp/test" }
    );
    expect(result).toEqual({ content: "hello" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3702/outposts/dev/rpc",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("throws on HTTP error", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(outpostRpc("dev", "fs.read", {})).rejects.toThrow("HTTP 503");
  });

  it("throws on RPC-level error", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: false, error: "outpost 'dev' not connected" }),
    });
    await expect(outpostRpc("dev", "fs.read", {})).rejects.toThrow(
      "outpost 'dev' not connected"
    );
  });

  it("URL-encodes the outpost name", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: { payload: {} } }),
    });
    await outpostRpc("my outpost", "fs.list", {});
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3702/outposts/my%20outpost/rpc",
      expect.anything()
    );
  });
});

describe("listOutposts", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns outposts from the bridge", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        outposts: [
          { name: "dev", connected: true, lastHeartbeat: 1234 },
          { name: "staging", connected: false },
        ],
      }),
    });

    const result = await listOutposts();
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ name: "dev", connected: true });
  });

  it("returns empty array when outposts key is absent", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });
    expect(await listOutposts()).toEqual([]);
  });

  it("throws on HTTP error", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(listOutposts()).rejects.toThrow("HTTP 503");
  });
});
