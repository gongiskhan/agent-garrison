import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ nodes: [] as unknown[], threads: [] as unknown[] }));
vi.mock("@garrison/state-client", () => ({ createStateClient: () => ({
  listNodes: async () => mocks.nodes,
  getConfig: async () => ({ body: { threads: mocks.threads } })
}) }));
// @ts-ignore pure mjs
import { meshThreads, _resetCachesForTests } from "../packages/talk/src/mesh-threads.mjs";
const prev = process.env.GARRISON_NODE_NAME;
beforeEach(() => {
  process.env.GARRISON_NODE_NAME = "self";
  mocks.nodes = [{ name: "peer", tailnetHost: "peer.tail.example", status: "active" }];
  mocks.threads = [];
  _resetCachesForTests();
});
afterEach(() => { if (prev === undefined) delete process.env.GARRISON_NODE_NAME; else process.env.GARRISON_NODE_NAME = prev; });

describe("remote conversation activity", () => {
  it("lists more than eight recent threads with the owner's real running state and shell source", async () => {
    const recent = new Date().toISOString();
    const threads = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, updatedAt: recent,
      runningSince: i === 10 ? recent : null, source: i === 10 ? "shell" : "chat" }));
    const fetchImpl = vi.fn(async (_url: string) => ({ ok: true, json: async () => ({ threads }) }));
    const result = await meshThreads({ fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://peer.tail.example/api/threads");
    expect(result.nodes[0].threads).toHaveLength(12);
    expect(result.nodes[0].threads[0]).toMatchObject({ id: "t10", runningSince: recent, source: "shell", openUrl: "/mesh/talk/peer/t10" });
  });
  it("keeps recent cached threads visible during an outage without a stale running claim", async () => {
    mocks.threads = [{ id: "t1", lastMessageAt: new Date().toISOString(), runningSince: new Date().toISOString() }];
    const result = await meshThreads({ fetchImpl: async () => { throw new Error("unreachable"); } });
    expect(result.nodes[0].threads[0]).toMatchObject({ id: "t1", runningSince: null });
  });
  it("uses the published HTTPS app origin for a tethered node and excludes old inactive threads", async () => {
    mocks.nodes = [{ name: "csg", health: { node: { appOrigin: "https://client-tunnel.example:9443" } } }];
    const fetchImpl = vi.fn(async (_url: string) => ({ ok: true, json: async () => ({ threads: [
      { id: "old", updatedAt: new Date(Date.now() - 6 * 86_400_000).toISOString() },
      { id: "recent", updatedAt: new Date().toISOString() }
    ] }) }));
    const result = await meshThreads({ fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://client-tunnel.example:9443/api/threads");
    expect(result.nodes[0].threads.map((t: { id: string }) => t.id)).toEqual(["recent"]);
  });
});
