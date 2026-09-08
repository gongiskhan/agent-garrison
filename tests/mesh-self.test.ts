// Mesh area: the node heartbeat round trip, and the staleness vocabulary the
// roster's state pill is computed from.
//
// The round trip is proven against the REAL state service (ephemeral port,
// temp DB) rather than a mock, because the thing under test is precisely
// whether the health snapshot this node posts survives the wire and comes back
// out of listNodes() intact.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { StateClient } from "@garrison/state-client";
import { startStateService } from "./state-service-harness";
import { NODE_STALE_MS, nodeStale, nodeState, lastSeenAge } from "@/lib/mesh/staleness";
import { parseGitStatus } from "@/lib/mesh/git-status";
import { mergeMeshRoster, type RegistryNode } from "@/lib/mesh/node-row";
import { accentForNodeId, resolveAccent } from "@/lib/node-identity";
import { CLIENT_SCHEMA } from "@/lib/mesh/schema-window";
import { createNodeBeat, resolveAppUrl, startNodeBeat } from "../fittings/seed/scheduler/scripts/lib/node-beat.mjs";

// A representative /api/mesh/self body. Shaped by hand rather than gathered so
// the assertion is about the transport, not about this machine.
const selfSnapshot = {
  node: {
    id: "alpha",
    name: "Alpha",
    accent: "copper",
    accentHex: "#a26949",
    accentInk: "#ffffff",
    tailnetHost: "alpha.tail31efa.ts.net",
    createdAt: "2026-08-25T09:00:00.000Z",
    tetherHost: null,
    appOrigin: null,
    shellOrigin: null,
    source: "file" as const
  },
  schemaVersion: { min: CLIENT_SCHEMA.min, max: CLIENT_SCHEMA.max },
  clientVersion: "garrison-node/1",
  platform: "linux",
  at: "2026-08-25T09:30:00.000Z",
  uptimeMs: 120_000,
  composition: { id: "default", status: "running", running: true, startedAt: "2026-08-25T09:10:00.000Z", external: false },
  sessions: { webThreads: 7 },
  git: { branch: "node/alpha", head: "abc123def456", dirty: 0, ahead: 2, behind: 0, upstream: "origin/node/alpha" },
  views: { total: 4, healthy: 4, unhealthy: [] },
  degraded: false,
  activity: "idle" as const
};

describe("node heartbeat", () => {
  let h: Awaited<ReturnType<typeof startStateService>>;
  let client: StateClient;

  beforeAll(async () => {
    h = await startStateService({ nodes: ["alpha", "beta"] });
    client = h.client;
  }, 30_000);

  afterAll(async () => {
    await h?.stop();
  });

  it("a hello carrying a health snapshot lands on the node's registry row", async () => {
    const before = new Date().toISOString();
    const ack = await client.hello({
      clientVersion: selfSnapshot.clientVersion,
      minSchema: selfSnapshot.schemaVersion.min,
      maxSchema: selfSnapshot.schemaVersion.max,
      capabilities: ["garrison-app", "views", "composition-up"],
      localTime: new Date().toISOString(),
      health: selfSnapshot,
      activeComposition: selfSnapshot.composition.id,
      tailnetHost: selfSnapshot.node.tailnetHost,
      platform: selfSnapshot.platform
    });
    expect(ack.behind).toBe(false);

    const nodes = await client.listNodes();
    const alpha = nodes.find((n) => n.name === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha!.activeComposition).toBe("default");
    expect(alpha!.tailnetHost).toBe("alpha.tail31efa.ts.net");
    expect(alpha!.platform).toBe("linux");
    expect(alpha!.clientVersion).toBe("garrison-node/1");
    expect(alpha!.capabilities).toContain("views");
    expect(alpha!.status).toBe("active");
    // The whole snapshot round-trips, not a summary of it: /mesh renders the
    // peer's git branch and view health straight out of this column.
    expect(alpha!.health).toMatchObject({
      git: { branch: "node/alpha", ahead: 2 },
      views: { healthy: 4, total: 4 },
      composition: { id: "default", running: true }
    });
    expect(alpha!.lastSeenAt).not.toBeNull();
    expect(Date.parse(alpha!.lastSeenAt!)).toBeGreaterThanOrEqual(Date.parse(before) - 1000);
  });

  it("a node that never said hello has no lastSeenAt, so the roster reads it as offline", async () => {
    const nodes = await client.listNodes();
    const beta = nodes.find((n) => n.name === "beta");
    expect(beta).toBeDefined();
    expect(beta!.lastSeenAt).toBeNull();
    expect(nodeState({ status: beta!.status, lastSeenAt: beta!.lastSeenAt, health: beta!.health })).toBe("offline");
  });

  it("a fresh beat from the registry row maps to ready", async () => {
    await client.hello({ localTime: new Date().toISOString(), health: selfSnapshot });
    const alpha = (await client.listNodes()).find((n) => n.name === "alpha")!;
    expect(nodeState({ status: alpha.status, lastSeenAt: alpha.lastSeenAt, health: alpha.health })).toBe("ready");
  });

  it("a client outside the service's schema window is marked behind", async () => {
    const ack = await client.hello({
      localTime: new Date().toISOString(),
      minSchema: 9000,
      maxSchema: 9001
    });
    expect(ack.behind).toBe(true);
    const alpha = (await client.listNodes()).find((n) => n.name === "alpha")!;
    expect(alpha.status).toBe("behind");
    expect(nodeState({ status: alpha.status, lastSeenAt: alpha.lastSeenAt, health: alpha.health })).toBe("degraded");

    // Recover, so the row is left as the other tests found it.
    const ok = await client.hello({
      localTime: new Date().toISOString(),
      minSchema: CLIENT_SCHEMA.min,
      maxSchema: CLIENT_SCHEMA.max
    });
    expect(ok.behind).toBe(false);
  });
});

// The pump the scheduler daemon runs. Proven against the real service with a
// stubbed app, because the failure this catches is silent: a beat that gathers
// fine and posts a body the registry drops on the floor.
describe("node-beat pump", () => {
  let h: Awaited<ReturnType<typeof startStateService>>;
  let env: Record<string, string | undefined>;
  const logs: string[] = [];

  // Serves the stub app; everything else (the state service) goes to real fetch.
  const routedFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/api/mesh/self")) {
      return new Response(JSON.stringify(selfSnapshot), { status: 200, headers: { "content-type": "application/json" } });
    }
    return globalThis.fetch(input, init);
  };

  beforeAll(async () => {
    h = await startStateService({ nodes: ["pump"] });
    env = {
      GARRISON_APP_URL: "http://app.test",
      GARRISON_STATE_URL: h.url,
      GARRISON_STATE_TOKEN: h.tokens.pump,
      GARRISON_NODE_NAME: "pump"
    };
    logs.length = 0;
  }, 30_000);

  afterAll(async () => {
    await h?.stop();
  });

  it("gathers /api/mesh/self and reports it as this node's health", async () => {
    const beat = createNodeBeat({ env, fetchImpl: routedFetch, log: (m: string) => logs.push(m) });
    expect(await beat.beatOnce()).toMatchObject({ beat: true, behind: false });

    const client = new StateClient({ url: h.url, token: h.tokens.pump, node: "pump" });
    const row = (await client.listNodes()).find((n) => n.name === "pump")!;
    expect(row.activeComposition).toBe("default");
    expect(row.platform).toBe("linux");
    expect(row.tailnetHost).toBe("alpha.tail31efa.ts.net");
    expect(row.capabilities).toEqual(expect.arrayContaining(["garrison-app", "views", "composition-up"]));
    expect(row.health).toMatchObject({ git: { branch: "node/alpha" } });
    expect(row.lastSeenAt).not.toBeNull();
  });

  it("does not crash a scheduler on a node that is not enrolled", async () => {
    const beat = createNodeBeat({
      env: { GARRISON_APP_URL: "http://app.test" },
      fetchImpl: routedFetch,
      log: (m: string) => logs.push(m)
    });
    await expect(beat.beatOnce()).resolves.toMatchObject({ beat: false, reason: "not-enrolled" });
  });

  it("skips the beat, rather than guessing a port, when no app URL is projected", async () => {
    const beat = createNodeBeat({ env: {}, fetchImpl: routedFetch, log: (m: string) => logs.push(m) });
    await expect(beat.beatOnce()).resolves.toMatchObject({ beat: false, reason: "no-health" });
  });

  it("complains once per condition, not once per beat", async () => {
    const said: string[] = [];
    const beat = createNodeBeat({ env: {}, fetchImpl: routedFetch, log: (m: string) => said.push(m) });
    await beat.beatOnce();
    await beat.beatOnce();
    await beat.beatOnce();
    expect(said).toHaveLength(1);
  });

  it("resolves the app URL from the launcher's env, never a literal", () => {
    expect(resolveAppUrl({ GARRISON_APP_URL: "http://example.test/" })).toBe("http://example.test");
    expect(resolveAppUrl({ GARRISON_APP_PORT: "8777" })).toBe("http://127.0.0.1:8777");
    expect(resolveAppUrl({ PORT: "18777" })).toBe("http://127.0.0.1:18777");
    expect(resolveAppUrl({ GARRISON_APP_PORT: "not-a-port" })).toBeNull();
    expect(resolveAppUrl({})).toBeNull();
  });

  it("has an escape hatch that starts nothing at all", () => {
    expect(startNodeBeat({ env: { ...env, GARRISON_DISABLE_NODE_BEAT: "1" }, fetchImpl: routedFetch })).toBeNull();
  });
});

describe("roster merge", () => {
  const now = Date.parse("2026-08-25T12:00:00.000Z");
  const registryNode = (over: Partial<RegistryNode> & { name: string }): RegistryNode => ({
    accentColor: "#527c91",
    tailnetHost: `${over.name}.tail31efa.ts.net`,
    platform: "darwin",
    capabilities: ["garrison-app"],
    schemaVersion: 2,
    clientVersion: "garrison-node/1",
    activeComposition: "default",
    status: "active",
    health: {},
    lastSeenAt: new Date(now - 5_000).toISOString(),
    ...over
  });
  const self = { ...selfSnapshot, at: new Date(now - 1_000).toISOString() };
  // The same resolver the route injects, so this suite cannot pass on a
  // colour production would never render.
  const accentHex = (value: unknown, id: string) => resolveAccent(value, id).hex;

  it("replaces this node's registry row with its live local snapshot", () => {
    const rows = mergeMeshRoster(
      [
        // A beat the registry received four minutes ago, claiming a stale
        // composition. The local snapshot is the truth about this machine.
        registryNode({ name: "alpha", lastSeenAt: new Date(now - 240_000).toISOString(), activeComposition: "stale" }),
        registryNode({ name: "zulu" })
      ],
      self,
      accentHex,
      now
    );
    const alpha = rows.find((r) => r.id === "alpha")!;
    expect(alpha.isSelf).toBe(true);
    expect(alpha.registered).toBe(true);
    expect(alpha.activeComposition).toBe("default");
    // The registry's four-minute-old beat would have read OFFLINE.
    expect(alpha.state).toBe("ready");
    expect(alpha.accentColor).toBe("#a26949");
    expect(rows).toHaveLength(2);
  });

  it("shows an unenrolled node rather than hiding it", () => {
    const rows = mergeMeshRoster([registryNode({ name: "zulu" })], self, accentHex, now);
    const alpha = rows.find((r) => r.id === "alpha")!;
    expect(alpha.registered).toBe(false);
    expect(alpha.status).toBe("unregistered");
    expect(rows).toHaveLength(2);
  });

  it("puts this node first, then orders by name", () => {
    const rows = mergeMeshRoster(
      [registryNode({ name: "zulu" }), registryNode({ name: "alpha" }), registryNode({ name: "bravo" })],
      self,
      accentHex,
      now
    );
    expect(rows.map((r) => r.id)).toEqual(["alpha", "bravo", "zulu"]);
  });

  it("renders a roster with no local identity at all", () => {
    const rows = mergeMeshRoster([registryNode({ name: "zulu" })], null, accentHex, now);
    expect(rows).toHaveLength(1);
    expect(rows[0].isSelf).toBe(false);
    expect(rows[0].state).toBe("ready");
  });

  it("resolves a palette id, and falls back to a distinct accent for anything off-palette", () => {
    const byId = mergeMeshRoster([registryNode({ name: "zulu", accentColor: "steel" })], null, accentHex, now);
    expect(byId[0].accentColor).toBe("#527c91");

    // The registry column's seeded default is NOT a palette entry. A neutral
    // grey dot on every unconfigured node would defeat the point of colouring
    // them, so it resolves to the id-derived accent instead.
    const offPalette = mergeMeshRoster([registryNode({ name: "zulu", accentColor: "#6b7f6e" })], null, accentHex, now);
    expect(offPalette[0].accentColor).toBe(accentForNodeId("zulu").hex);
    expect(offPalette[0].accentColor).not.toBe("#6b7f6e");
  });
});

describe("staleness mapping", () => {
  const now = Date.parse("2026-08-25T12:00:00.000Z");
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();

  it("flips ready to offline once the beat is past 45 seconds", () => {
    const fresh = { status: "active", lastSeenAt: at(15_000), health: null };
    expect(nodeState(fresh, now)).toBe("ready");

    // Exactly at the limit is still alive; one millisecond past it is not.
    expect(nodeState({ ...fresh, lastSeenAt: at(NODE_STALE_MS) }, now)).toBe("ready");
    expect(nodeState({ ...fresh, lastSeenAt: at(NODE_STALE_MS + 1) }, now)).toBe("offline");
    expect(nodeState({ ...fresh, lastSeenAt: at(10 * 60_000) }, now)).toBe("offline");
  });

  it("is 45 seconds — three missed 15 second beats", () => {
    expect(NODE_STALE_MS).toBe(45_000);
  });

  it("staleness outranks every health claim the node made", () => {
    // A node that reported itself busy four minutes ago is offline, not busy.
    const stale = { status: "active", lastSeenAt: at(240_000), health: { activity: "busy" } };
    expect(nodeState(stale, now)).toBe("offline");
  });

  it("maps status and health onto the worker vocabulary", () => {
    expect(nodeState({ status: "behind", lastSeenAt: at(1_000), health: null }, now)).toBe("degraded");
    expect(nodeState({ status: "retired", lastSeenAt: at(1_000), health: null }, now)).toBe("offline");
    expect(nodeState({ status: "active", lastSeenAt: at(1_000), health: { degraded: true } }, now)).toBe("degraded");
    expect(nodeState({ status: "active", lastSeenAt: at(1_000), health: { activity: "busy" } }, now)).toBe("busy");
    expect(nodeState({ status: "active", lastSeenAt: at(1_000), health: {} }, now)).toBe("ready");
  });

  it("treats a missing or unparseable lastSeenAt as stale, never as fresh", () => {
    expect(nodeStale(null, now)).toBe(true);
    expect(nodeStale(undefined, now)).toBe(true);
    expect(nodeStale("not a date", now)).toBe(true);
    expect(lastSeenAge(null, now)).toBe("never");
    expect(lastSeenAge(at(3_000), now)).toBe("3s ago");
    expect(lastSeenAge(at(180_000), now)).toBe("3m ago");
  });
});

describe("git snapshot parsing", () => {
  it("reads branch, head, ahead/behind and dirty count from porcelain v2", () => {
    const out = [
      "# branch.oid 4c1f0a9b2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f70",
      "# branch.head node/dev-madrid",
      "# branch.upstream origin/node/dev-madrid",
      "# branch.ab +3 -1",
      "1 .M N... 100644 100644 100644 aaa bbb src/lib/mesh/staleness.ts",
      "? untracked.txt",
      ""
    ].join("\n");
    expect(parseGitStatus(out)).toEqual({
      branch: "node/dev-madrid",
      head: "4c1f0a9b2d3e",
      upstream: "origin/node/dev-madrid",
      ahead: 3,
      behind: 1,
      dirty: 2
    });
  });

  it("reports a clean detached checkout without inventing a branch", () => {
    const out = ["# branch.oid 4c1f0a9b2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f70", "# branch.head (detached)", ""].join("\n");
    expect(parseGitStatus(out)).toEqual({
      branch: null,
      head: "4c1f0a9b2d3e",
      upstream: null,
      ahead: 0,
      behind: 0,
      dirty: 0
    });
  });

  it("leaves ahead/behind at zero when there is no upstream — never guesses", () => {
    const out = ["# branch.oid (initial)", "# branch.head main", ""].join("\n");
    const parsed = parseGitStatus(out);
    expect(parsed.head).toBeNull();
    expect(parsed.upstream).toBeNull();
    expect(parsed.ahead).toBe(0);
    expect(parsed.behind).toBe(0);
  });
});
