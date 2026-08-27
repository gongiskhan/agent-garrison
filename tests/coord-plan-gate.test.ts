import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs fitting modules (single-line so @ts-ignore covers the specifier)
import { beginPlanning, endPlanning, planHeartbeat, planStatus, declareIntentTool, coordDigestTool } from "../fittings/seed/coord-mcp/scripts/server.mjs";
// @ts-ignore
import { lookbackDays } from "../fittings/seed/coord-mcp/scripts/lib/lookback.mjs";
// @ts-ignore
import { forceReleasePlanLease, planLeaseStatus } from "../fittings/seed/coord-mcp/scripts/lib/plan-lease.mjs";
// @ts-ignore
import { clearWaiters } from "../fittings/seed/coord-mcp/scripts/lib/plan-store.mjs";
// @ts-ignore
import { repoRef } from "../fittings/seed/coord-mcp/scripts/lib/repo.mjs";
// @ts-ignore
import { resetStateClient } from "../fittings/seed/coord-mcp/scripts/lib/state.mjs";
import { startStateService, type StateHarness } from "./state-service-harness";

// The library-level gate: repo IDENTITY, the admin force-release, and the
// intent -> conflict -> digest chain that drives the canary. The end-to-end
// planning gate (two processes over MCP stdio, WAIT/GRANT/inherit, the
// unreachable-service error) lives in tests/coord-mcp-state.test.ts.
//
// Everything here is mesh state on the state service, so a synthetic `now` no
// longer moves a lease's expiry — the service's wall clock owns TTLs. Only the
// lookback window is time-travelled.

const A = "sessionA";
const B = "sessionB";
// Synthetic mesh keys: the identity a repo with an origin resolves to, without
// needing a checkout on disk.
const REPO1 = "github.com/example/repo-one";
const REPO2 = "github.com/example/repo-two";

let harness: StateHarness & { tokens: Record<string, string> };
const tempDirs: string[] = [];

beforeAll(async () => {
  harness = await startStateService({ nodes: ["test-node"] });
  process.env.GARRISON_STATE_URL = harness.url;
  process.env.GARRISON_STATE_TOKEN = harness.token;
  process.env.GARRISON_NODE_NAME = "test-node";
  resetStateClient();
}, 30_000);

afterAll(async () => {
  await harness.stop();
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  delete process.env.GARRISON_STATE_URL;
  delete process.env.GARRISON_STATE_TOKEN;
  delete process.env.GARRISON_NODE_NAME;
  resetStateClient();
});

function gitRepo(origin: string | null): string {
  const dir = mkdtempSync(path.join(tmpdir(), "coord-gate-repo-"));
  tempDirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (origin) execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir });
  return dir;
}

describe("lookback window", () => {
  it("is 3 on weekdays, 5 on Monday, 7 on the weekend", () => {
    expect(lookbackDays(new Date("2026-06-22T12:00:00Z"))).toBe(5); // Monday
    expect(lookbackDays(new Date("2026-06-23T12:00:00Z"))).toBe(3); // Tuesday
    expect(lookbackDays(new Date("2026-06-26T12:00:00Z"))).toBe(3); // Friday
    expect(lookbackDays(new Date("2026-06-20T12:00:00Z"))).toBe(7); // Saturday
    expect(lookbackDays(new Date("2026-06-21T12:00:00Z"))).toBe(7); // Sunday
  });
});

describe("repo identity — the ORIGIN is the key, never the path", () => {
  it("keys a checkout by its normalized origin, so two paths on two machines are ONE lock", () => {
    const one = gitRepo("https://github.com/Example/Thing.git");
    const two = gitRepo("git@github.com:Example/Thing.git");
    // Two different directories, one identity — the whole point of the rekey.
    expect(repoRef(one).key).toBe("github.com/Example/Thing");
    expect(repoRef(two).key).toBe(repoRef(one).key);
    // The local path survives beside the key: agent_mail still keys by project path.
    expect(repoRef(one).path).toBe(one);
  });

  it("scopes an origin-less checkout to THIS node, so the same path elsewhere is a different repo", () => {
    const bare = gitRepo(null);
    const mine = repoRef(bare, process.cwd(), { GARRISON_NODE_NAME: "test-node" });
    const theirs = repoRef(bare, process.cwd(), { GARRISON_NODE_NAME: "air" });
    expect(mine.key).toMatch(/^local:test-node:[0-9a-f]{16}$/);
    expect(theirs.key).toMatch(/^local:air:[0-9a-f]{16}$/);
    expect(mine.key).not.toBe(theirs.key);
  });

  it("passes an already-normalized key through untouched (the view round-trips it into release-lock)", () => {
    expect(repoRef("github.com/gongiskhan/agent-garrison").key).toBe("github.com/gongiskhan/agent-garrison");
    expect(repoRef("local:air:0123456789abcdef").key).toBe("local:air:0123456789abcdef");
    // A friendly name is neither a path nor a key: it gets a node-scoped one.
    expect(repoRef("ekoa-dev").key).toMatch(/^local:test-node:[0-9a-f]{16}$/);
  });
});

describe("PLAN-GATE — serialize planning per repo", () => {
  it("A grants, B waits, A releases, B inherits A's plan in the read-bundle", async () => {
    const a = await beginPlanning({ repo: REPO1, summary: "refactor the capability resolver" }, A);
    expect(a.status).toBe("GRANTED");
    expect(a.readBundle.releasedPlan).toBeNull(); // nothing released yet

    const b1 = await beginPlanning({ repo: REPO1, summary: "rework the runner" }, B);
    expect(b1.status).toBe("WAIT");
    expect(b1.holder.session).toBe(A);
    expect(b1.holder.summary).toBe("refactor the capability resolver");
    expect(b1.holder.expiresAt).toBeTruthy();

    expect((await endPlanning({ repo: REPO1 }, A)).status).toBe("RELEASED");

    const b2 = await beginPlanning({ repo: REPO1, summary: "rework the runner" }, B);
    expect(b2.status).toBe("GRANTED");
    expect(b2.readBundle.releasedPlan.summary).toBe("refactor the capability resolver");
    expect(b2.readBundle.releasedPlan.session).toBe(A);
    await endPlanning({ repo: REPO1 }, B);
  });

  it("different repos do not block each other", async () => {
    expect((await beginPlanning({ repo: "github.com/example/x", summary: "x" }, A)).status).toBe("GRANTED");
    expect((await beginPlanning({ repo: "github.com/example/y", summary: "y" }, B)).status).toBe("GRANTED");
  });

  it("heartbeat extends the lease so a live planner keeps it; a non-holder is told so", async () => {
    const repo = "github.com/example/heartbeat";
    await beginPlanning({ repo, summary: "long plan" }, A);
    expect((await planHeartbeat({ repo }, A)).ok).toBe(true);
    const stranger = await planHeartbeat({ repo }, B);
    expect(stranger.ok).toBe(false);
    expect(stranger.reason).toBe("not-holder");
    expect((await beginPlanning({ repo, summary: "nope" }, B)).status).toBe("WAIT");
  });

  it("plan_status reports the holder and the waiters", async () => {
    const repo = "github.com/example/status";
    await beginPlanning({ repo, summary: "holding" }, A);
    await beginPlanning({ repo, summary: "waiting" }, B); // B -> WAIT, recorded
    const st = await planStatus({ repo }, A);
    expect(st.lock.held).toBe(true);
    expect(st.lock.lock.session).toBe(A);
    expect(st.waiters.map((w: { session: string }) => w.session)).toContain(B);
    // The holder is never listed as a waiter, even after an earlier WAIT of its own.
    expect(st.waiters.map((w: { session: string }) => w.session)).not.toContain(A);
  });

  it("end_planning records the plan even when the lease already lapsed (the plan still helps the next planner)", async () => {
    const repo = "github.com/example/lapsed";
    process.env.COORD_PLAN_LOCK_TTL_MS = "700";
    try {
      await beginPlanning({ repo, summary: "ran long" }, A);
      await new Promise((r) => setTimeout(r, 900));
      const end = await endPlanning({ repo }, A);
      // Behaviour change from the file mutex, which refused to unlink an expired
      // lock: the holder token makes that refusal unnecessary. A lapsed holder
      // whose lease was TAKEN OVER matches no row, so it still cannot delete the
      // new holder's lease.
      expect(end.status).toBe("RELEASED");
      const inherited = await beginPlanning({ repo, summary: "next" }, B);
      expect(inherited.readBundle.releasedPlan.summary).toBe("ran long");
      await endPlanning({ repo }, B);
    } finally {
      delete process.env.COORD_PLAN_LOCK_TTL_MS;
    }
  });

  it("a lapsed holder cannot release the lease that took over from it", async () => {
    const repo = "github.com/example/takeover";
    process.env.COORD_PLAN_LOCK_TTL_MS = "700";
    try {
      await beginPlanning({ repo, summary: "abandoned" }, A);
      await new Promise((r) => setTimeout(r, 900));
      const taker = await beginPlanning({ repo, summary: "takeover" }, B);
      expect(taker.status).toBe("GRANTED");
      expect(taker.recoveredStaleLock).toBe(true);
      const late = await endPlanning({ repo }, A); // A wakes up past its expiry
      expect(late.detail.released).toBe(false);
      expect(late.detail.reason).toBe("held-by-other");
      expect((await planLeaseStatus(repo)).lock.session).toBe(B);
    } finally {
      delete process.env.COORD_PLAN_LOCK_TTL_MS;
    }
  });
});

describe("release-lock (force) — the Coordination view's release action", () => {
  it("releases the lease and drops its waiters", async () => {
    const repo = "github.com/example/force";
    await beginPlanning({ repo, summary: "holding" }, A);
    await beginPlanning({ repo, summary: "waiting" }, B); // records a waiter
    const r = await forceReleasePlanLease(repo);
    expect(r.released).toBe(true);
    await clearWaiters(repo);
    const st = await planStatus({ repo }, A);
    expect(st.lock.held).toBe(false);
    expect(st.lock.stale).toBe(false); // the lease is gone, not merely expired
    expect(st.waiters).toEqual([]);
  });

  it("reports honestly when there is nothing to release, and leaves other repos alone", async () => {
    await beginPlanning({ repo: REPO2, summary: "two" }, B);
    expect((await forceReleasePlanLease("github.com/example/never-locked")).released).toBe(false);
    expect((await planLeaseStatus(REPO2)).held).toBe(true);
  });
});

describe("intent -> conflict -> digest chain (drives the canary)", () => {
  it("surfaces an overlapping intent from another session in the digest, repo-scoped", async () => {
    const repo = "github.com/example/conflict";
    const elsewhere = "github.com/example/quiet";
    await declareIntentTool({ repo, area: "src/lib/runner.ts", reason: "rewiring up()" }, A);
    const dB = await coordDigestTool({ repo, area: "src/lib/runner.ts" }, B);
    expect(dB.hasConflicts).toBe(true);
    expect(dB.text).toContain(A);
    expect(dB.text).toContain("rewiring up()");
    expect(dB.bytes).toBeLessThan(1400); // a few hundred tokens

    // Repo-scoping: the SAME area in another repo sees NO conflict.
    expect((await coordDigestTool({ repo: elsewhere, area: "src/lib/runner.ts" }, B)).hasConflicts).toBe(false);
  });

  it("the digest always carries the begin_planning nudge", async () => {
    const d = await coordDigestTool({ repo: "github.com/example/nudge" }, A);
    expect(d.text).toContain("begin_planning");
  });

  it("a session does not conflict with its OWN intent", async () => {
    const repo = "github.com/example/self";
    await declareIntentTool({ repo, area: "x", reason: "mine" }, A);
    expect((await coordDigestTool({ repo, area: "x" }, A)).hasConflicts).toBe(false);
  });

  it("a planning-lease holder is announced in the digest of every other session", async () => {
    const repo = "github.com/example/announced";
    await beginPlanning({ repo, summary: "big architectural change" }, A);
    const d = await coordDigestTool({ repo }, B);
    expect(d.text).toContain("PLANNING LOCK held by sessionA");
    expect(d.text).toContain("big architectural change");
  });
});
