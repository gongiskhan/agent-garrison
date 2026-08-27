import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs fitting modules
import { buildCoordState, deriveHeroVerdict } from "../fittings/seed/coord-mcp/scripts/lib/coord-state.mjs";
// @ts-ignore
import { leaseOverlaps } from "../fittings/seed/coord-mcp/scripts/lib/digest.mjs";
// @ts-ignore
import { resetStateClient } from "../fittings/seed/coord-mcp/scripts/lib/state.mjs";
import { startStateService, type StateHarness } from "./state-service-harness";

// C2-1/C2-2 — the unified coordination-state source + lease folding, now that
// planning leases, plans and intents are MESH state. Sessions and the hook
// heartbeat stay node-local, so those are still seeded on disk.

const REPO = "github.com/example/projX"; // the mesh key a checkout resolves to
let harness: StateHarness & { tokens: Record<string, string> };
let gh: string;
let ch: string;

beforeAll(async () => {
  harness = await startStateService({ nodes: ["test-node"] });
  process.env.GARRISON_STATE_URL = harness.url;
  process.env.GARRISON_STATE_TOKEN = harness.token;
  process.env.GARRISON_NODE_NAME = "test-node";
  resetStateClient();
}, 30_000);

afterAll(async () => {
  await harness.stop();
  delete process.env.GARRISON_STATE_URL;
  delete process.env.GARRISON_STATE_TOKEN;
  delete process.env.GARRISON_NODE_NAME;
  resetStateClient();
});

beforeEach(() => {
  gh = mkdtempSync(path.join(tmpdir(), "coord-state-gh-"));
  ch = mkdtempSync(path.join(tmpdir(), "coord-state-ch-"));
  process.env.GARRISON_HOME = gh;
  process.env.GARRISON_CLAUDE_HOME = ch;
  mkdirSync(path.join(ch, "projects"), { recursive: true });
});
afterEach(() => {
  rmSync(gh, { recursive: true, force: true });
  rmSync(ch, { recursive: true, force: true });
  delete process.env.GARRISON_HOME;
  delete process.env.GARRISON_CLAUDE_HOME;
});

describe("deriveHeroVerdict — honest, degraded/down dominate green", () => {
  const base = { sessions: [], locks: [], recentHeartbeat: true };
  it("down when agent_mail (the coordination server) is down", () => {
    const v = deriveHeroVerdict({ ...base, liveness: { agentMail: { up: false } } });
    expect(v.overall).toBe("down");
    expect(v.reasons.join(" ")).toMatch(/agent_mail/i);
  });
  it("degraded when a session is RED (zero-write while active)", () => {
    const v = deriveHeroVerdict({
      liveness: { agentMail: { up: true } },
      sessions: [{ recent: true, flag: "red" }],
      locks: [],
      recentHeartbeat: true
    });
    expect(v.overall).toBe("degraded");
    expect(v.reasons.join(" ")).toMatch(/ZERO coordination writes/i);
  });
  it("degraded when a planning lock is stale", () => {
    const v = deriveHeroVerdict({
      liveness: { agentMail: { up: true } },
      sessions: [{ recent: true, flag: "active" }],
      locks: [{ expired: true }],
      recentHeartbeat: true
    });
    expect(v.overall).toBe("degraded");
    expect(v.reasons.join(" ")).toMatch(/stale planning lock/i);
  });
  it("idle when servers up but no active sessions", () => {
    const v = deriveHeroVerdict({ liveness: { agentMail: { up: true } }, sessions: [], locks: [], recentHeartbeat: true });
    expect(v.overall).toBe("idle");
  });
  it("live-and-used when healthy + active + heartbeating", () => {
    const v = deriveHeroVerdict({
      liveness: { agentMail: { up: true } },
      sessions: [{ recent: true, flag: "active" }],
      locks: [{ expired: false }],
      recentHeartbeat: true
    });
    expect(v.overall).toBe("live-and-used");
  });
});

describe("buildCoordState — one source, mesh-keyed, JSON-serializable", () => {
  it("assembles the planning lease + intents (cheap path: no liveness, no global session scan)", async () => {
    await harness.client.acquireLease({
      key: `plan:${REPO}`,
      holder: "HOLDER",
      holderToken: "tok-holder",
      ttlMs: 600_000,
      meta: { repoKey: REPO, summary: "big plan", startedAt: new Date().toISOString() }
    });
    await harness.client.declareIntent({ repoKey: REPO, session: "S1", area: "src/x", reason: "edit x" });

    const st = await buildCoordState(REPO, new Date(), { liveness: false, globalSessions: false });
    expect(st.repoKey).toBe(REPO);
    expect(st.liveness).toBeNull();
    expect(st.sessions).toEqual([]); // global scan skipped
    expect(st.locks).toHaveLength(1);
    expect(st.locks[0].session).toBe("HOLDER");
    expect(st.locks[0].repo).toBe(REPO);
    expect(st.locks[0].expired).toBe(false);
    expect(st.locks[0].isFocus).toBe(true);
    expect(st.recentIntents.some((i: { reason: string }) => i.reason === "edit x")).toBe(true);
    expect(st.leases).toEqual([]); // no agent_mail in sandbox -> graceful empty
    // JSON-serializable (the UI consumes it verbatim)
    expect(() => JSON.stringify(st)).not.toThrow();
  });

  it("finds a lease on ANOTHER repo through that repo's open intents (there is no list-leases verb)", async () => {
    const other = "github.com/example/neighbour";
    await harness.client.declareIntent({ repoKey: other, session: "S2", area: "src/y", reason: "edit y" });
    await harness.client.acquireLease({
      key: `plan:${other}`,
      holder: "NEIGHBOUR",
      holderToken: "tok-neighbour",
      ttlMs: 600_000,
      meta: { repoKey: other, summary: "elsewhere", startedAt: new Date().toISOString() }
    });
    const st = await buildCoordState(REPO, new Date(), { liveness: false, globalSessions: false });
    const found = st.locks.find((l: { repo: string }) => l.repo === other);
    expect(found).toBeTruthy();
    expect(found.session).toBe("NEIGHBOUR");
    expect(found.isFocus).toBe(false);
  });

  it("reports an expired lease as a STALE lock rather than as no lock at all", async () => {
    const stale = "github.com/example/stale";
    await harness.client.declareIntent({ repoKey: stale, session: "S3", area: "z", reason: "keeps it discoverable" });
    await harness.client.acquireLease({
      key: `plan:${stale}`,
      holder: "GHOST",
      holderToken: "tok-ghost",
      ttlMs: 1,
      meta: { repoKey: stale, summary: "abandoned", startedAt: new Date().toISOString() }
    });
    await new Promise((r) => setTimeout(r, 30));
    const st = await buildCoordState(stale, new Date(), { liveness: false, globalSessions: false });
    const lock = st.locks.find((l: { repo: string }) => l.repo === stale);
    expect(lock.expired).toBe(true);
    expect(lock.session).toBe("GHOST");
  });

  it("flags a recently-active session with zero hook fires as RED (silent-failure detector)", async () => {
    // seed a session jsonl touched 'now' with no heartbeat entries -> red
    const projDir = path.join(ch, "projects", "-work-projX");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(path.join(projDir, "sess-red.jsonl"), JSON.stringify({ cwd: "/work/projX", gitBranch: "main" }) + "\n");
    const st = await buildCoordState(REPO, new Date(), { liveness: false, globalSessions: true });
    const s = st.sessions.find((x: { sessionId: string }) => x.sessionId === "sess-red");
    expect(s).toBeTruthy();
    expect(s.flag).toBe("red"); // recent + zero fires
    // Each session also carries the mesh key of its checkout, so the view can
    // line a session up with the mesh-keyed intents and leases beside it.
    expect(s.repoKey).toMatch(/^local:test-node:[0-9a-f]{16}$/);
  });
});

describe("leaseOverlaps — lease/working-set overlap for the digest", () => {
  it("matches a glob lease against a file in its prefix", () => {
    expect(leaseOverlaps({ pathPattern: "src/app/coordination/**" }, { files: ["src/app/coordination/page.tsx"] })).toBe(true);
  });
  it("matches an exact-path lease named in the prompt area", () => {
    expect(leaseOverlaps({ pathPattern: "src/lib/runner.ts" }, { area: "please edit src/lib/runner.ts" })).toBe(true);
  });
  it("does not match an unrelated path", () => {
    expect(leaseOverlaps({ pathPattern: "docs/**" }, { files: ["src/lib/runner.ts"] })).toBe(false);
  });
});
