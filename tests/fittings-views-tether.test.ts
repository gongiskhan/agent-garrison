import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ identity: vi.fn(), serve: vi.fn() }));
vi.mock("@/lib/node-identity", () => ({ readNodeIdentity: mocks.identity }));
vi.mock("@/lib/tailnet-serve", () => ({ getTailnetServeMap: mocks.serve }));
vi.mock("@/lib/claude-home", () => ({ garrisonDir: () => "/unused-garrison" }));
vi.mock("node:fs/promises", () => ({
  readdir: async () => ["shell.json", "other.json"],
  readFile: async (p: string) => JSON.stringify({ fittingId: p.endsWith("shell.json") ? "remote-shell-runtime" : "other", port: 8098, url: "http://127.0.0.1:8098" })
}));
import { GET } from "../src/app/api/fittings/views/route";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
  mocks.serve.mockResolvedValue(new Map([[8098, "https://stale-host.ts.net:8499"]]));
});

describe("tethered fitting addresses", () => {
  it("uses csg's enrolled Shells origin and ignores stale local Tailscale configuration", async () => {
    mocks.identity.mockReturnValue({ tetherHost: "dev-madrid", shellOrigin: "https://dev-madrid.tail31efa.ts.net:8998" });
    const { views } = await (await GET()).json();
    expect(views[0].tailnetUrl).toBe("https://dev-madrid.tail31efa.ts.net:8998");
    expect(mocks.serve).not.toHaveBeenCalled();
  });

  it("routes every other own-port view through the same-origin proxy route", async () => {
    mocks.identity.mockReturnValue({ tetherHost: "dev-madrid", shellOrigin: "https://dev-madrid.tail31efa.ts.net:8998" });
    const { views } = await (await GET()).json();
    expect(views[1].fittingId).toBe("other");
    expect(views[1].tailnetUrl).toBe("/api/fittings/proxy/other");
  });

  it("keeps native tailnet nodes on their actual serve map", async () => {
    mocks.identity.mockReturnValue({ tetherHost: null, shellOrigin: null });
    const { views } = await (await GET()).json();
    expect(views[0].tailnetUrl).toBe("https://stale-host.ts.net:8499");
    expect(mocks.serve).toHaveBeenCalledOnce();
  });
});
