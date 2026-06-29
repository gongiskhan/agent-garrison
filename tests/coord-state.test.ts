import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs fitting modules
import { buildCoordState, deriveHeroVerdict } from "../fittings/seed/coord-mcp/scripts/lib/coord-state.mjs";
// @ts-ignore
import { leaseOverlaps } from "../fittings/seed/coord-mcp/scripts/lib/digest.mjs";

// C2-1/C2-2 — the unified coordination-state source + lease folding.

const REPO = "/work/projX";
let gh: string;
let ch: string;

function slug(repo: string): string {
  return crypto.createHash("sha1").update(path.resolve(repo)).digest("hex").slice(0, 16);
}

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

describe("buildCoordState — one source, repo-scoped, JSON-serializable", () => {
  it("assembles locks + intents (cheap path: no liveness, no global session scan)", async () => {
    // seed a lock
    const lockDir = path.join(gh, "coord", "plan-locks");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      path.join(lockDir, `${slug(REPO)}.json`),
      JSON.stringify({ repo: REPO, session: "HOLDER", summary: "big plan", startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(), ttlMs: 600000 })
    );
    // seed an intent
    const intentDir = path.join(gh, "coord", "intents");
    mkdirSync(intentDir, { recursive: true });
    writeFileSync(path.join(intentDir, `${slug(REPO)}.jsonl`), JSON.stringify({ repo: REPO, session: "S1", area: "src/x", reason: "edit x", ts: new Date().toISOString() }) + "\n");

    const st = await buildCoordState(REPO, new Date(), { liveness: false, globalSessions: false });
    expect(st.repo).toBe(REPO);
    expect(st.liveness).toBeNull();
    expect(st.sessions).toEqual([]); // global scan skipped
    expect(st.locks).toHaveLength(1);
    expect(st.locks[0].session).toBe("HOLDER");
    expect(st.locks[0].expired).toBe(false);
    expect(st.recentIntents.some((i: { reason: string }) => i.reason === "edit x")).toBe(true);
    expect(st.leases).toEqual([]); // no agent_mail in sandbox -> graceful empty
    // JSON-serializable (the UI consumes it verbatim)
    expect(() => JSON.stringify(st)).not.toThrow();
  });

  it("flags a recently-active session with zero hook fires as RED (silent-failure detector)", async () => {
    // seed a session jsonl touched 'now' with no heartbeat entries -> red
    const projDir = path.join(ch, "projects", "-work-projX");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(path.join(projDir, "sess-red.jsonl"), JSON.stringify({ cwd: REPO, gitBranch: "main" }) + "\n");
    const st = await buildCoordState(REPO, new Date(), { liveness: false, globalSessions: true });
    const s = st.sessions.find((x: { sessionId: string }) => x.sessionId === "sess-red");
    expect(s).toBeTruthy();
    expect(s.flag).toBe("red"); // recent + zero fires
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
