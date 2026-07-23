import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs fitting modules (single-line so @ts-ignore covers the specifier)
import { beginPlanning, endPlanning, planHeartbeat, planStatus, declareIntentTool, coordDigestTool } from "../fittings/seed/coord-mcp/scripts/server.mjs";
// @ts-ignore
import { lookbackDays } from "../fittings/seed/coord-mcp/scripts/lib/lookback.mjs";
// @ts-ignore
import { forceReleaseLock, lockStatus } from "../fittings/seed/coord-mcp/scripts/lib/plan-lock.mjs";
// @ts-ignore
import { repoSlug } from "../fittings/seed/coord-mcp/scripts/lib/repo.mjs";

// The COMMITTED correctness gate for the planning gate (the highest-stakes
// coordination guarantee). All state goes to a sandbox GARRISON_HOME. Repos are
// passed explicitly so no git is invoked and isolation is total.

let sb: string;
const A = "sessionA";
const B = "sessionB";
const REPO1 = "/tmp/repo-one";
const REPO2 = "/tmp/repo-two";

beforeEach(() => {
  sb = mkdtempSync(path.join(tmpdir(), "coord-plan-"));
  process.env.GARRISON_HOME = sb;
  delete process.env.COORD_PLAN_LOCK_TTL_MS;
});
afterEach(() => {
  rmSync(sb, { recursive: true, force: true });
  delete process.env.GARRISON_HOME;
  delete process.env.COORD_PLAN_LOCK_TTL_MS;
});

describe("lookback window", () => {
  it("is 3 on weekdays, 5 on Monday, 7 on the weekend", () => {
    expect(lookbackDays(new Date("2026-06-22T12:00:00Z"))).toBe(5); // Monday
    expect(lookbackDays(new Date("2026-06-23T12:00:00Z"))).toBe(3); // Tuesday
    expect(lookbackDays(new Date("2026-06-26T12:00:00Z"))).toBe(3); // Friday
    expect(lookbackDays(new Date("2026-06-20T12:00:00Z"))).toBe(7); // Saturday
    expect(lookbackDays(new Date("2026-06-21T12:00:00Z"))).toBe(7); // Sunday
  });
});

describe("PLAN-GATE — serialize planning per repo", () => {
  it("A grants, B waits, A releases, B inherits A's plan in the read-bundle", () => {
    const t0 = new Date("2026-06-22T10:00:00Z");
    // A acquires.
    const a = beginPlanning({ repo: REPO1, summary: "refactor the capability resolver" }, A, t0);
    expect(a.status).toBe("GRANTED");
    expect(a.readBundle.releasedPlan).toBeNull(); // nothing released yet

    // B tries the SAME repo -> WAIT, with A as holder + A's summary.
    const b1 = beginPlanning({ repo: REPO1, summary: "rework the runner" }, B, new Date("2026-06-22T10:01:00Z"));
    expect(b1.status).toBe("WAIT");
    expect(b1.holder.session).toBe(A);
    expect(b1.holder.summary).toBe("refactor the capability resolver");
    expect(b1.holder.expiresAt).toBeTruthy();

    // A releases.
    const end = endPlanning({ repo: REPO1 }, A, new Date("2026-06-22T10:05:00Z"));
    expect(end.status).toBe("RELEASED");

    // B now acquires AND its read-bundle CONTAINS A's released plan.
    const b2 = beginPlanning({ repo: REPO1, summary: "rework the runner" }, B, new Date("2026-06-22T10:06:00Z"));
    expect(b2.status).toBe("GRANTED");
    expect(b2.readBundle.releasedPlan).toBeTruthy();
    expect(b2.readBundle.releasedPlan.summary).toBe("refactor the capability resolver");
    expect(b2.readBundle.releasedPlan.session).toBe(A);
  });

  it("treats a partial/unreadable existing lock as contended, never as free (no double-grant)", async () => {
    const fs = await import("node:fs");
    const crypto = await import("node:crypto");
    // Reproduce the wx-create-then-write window: a lock file that exists but is
    // not yet valid JSON. A second acquirer must NOT receive a grant.
    const slug = crypto.createHash("sha1").update(REPO1).digest("hex").slice(0, 16);
    const dir = path.join(sb, "coord", "plan-locks");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${slug}.json`), "{ partial"); // mid-write
    const b = beginPlanning({ repo: REPO1, summary: "racer" }, B, new Date());
    expect(b.status).toBe("WAIT");
    expect(b.reason).toBe("contended");
  });

  it("different repos do not block each other", () => {
    const t0 = new Date("2026-06-22T10:00:00Z");
    expect(beginPlanning({ repo: REPO1, summary: "x" }, A, t0).status).toBe("GRANTED");
    expect(beginPlanning({ repo: REPO2, summary: "y" }, B, t0).status).toBe("GRANTED"); // other repo, free
  });

  it("auto-releases a stale lock past its TTL (crashed planner can't block forever)", () => {
    process.env.COORD_PLAN_LOCK_TTL_MS = "1000"; // 1s TTL
    const t0 = new Date("2026-06-22T10:00:00Z");
    expect(beginPlanning({ repo: REPO1, summary: "stale" }, A, t0).status).toBe("GRANTED");
    // B at t0+2s — A's lock has expired.
    const b = beginPlanning({ repo: REPO1, summary: "take over" }, B, new Date("2026-06-22T10:00:02Z"));
    expect(b.status).toBe("GRANTED");
    expect(b.recoveredStaleLock).toBe(true);
  });

  it("heartbeat extends the lock so a live planner keeps it", () => {
    process.env.COORD_PLAN_LOCK_TTL_MS = "10000";
    const t0 = new Date("2026-06-22T10:00:00Z");
    beginPlanning({ repo: REPO1, summary: "long plan" }, A, t0);
    const hb = planHeartbeat({ repo: REPO1 }, A, new Date("2026-06-22T10:00:08Z"));
    expect(hb.ok).toBe(true);
    // B at t0+9s — still within the heartbeat-extended window -> WAIT.
    const b = beginPlanning({ repo: REPO1, summary: "nope" }, B, new Date("2026-06-22T10:00:09Z"));
    expect(b.status).toBe("WAIT");
  });

  it("an EXPIRED lock cannot be resurrected by the old holder's heartbeat", () => {
    process.env.COORD_PLAN_LOCK_TTL_MS = "1000";
    const t0 = new Date("2026-06-22T10:00:00Z");
    beginPlanning({ repo: REPO1, summary: "held" }, A, t0);
    // A heartbeats AFTER its lock expired -> must FAIL (no resurrection).
    const hb = planHeartbeat({ repo: REPO1 }, A, new Date("2026-06-22T10:00:02Z"));
    expect(hb.ok).toBe(false);
    expect(hb.reason).toBe("expired");
    // A different session can then take over the (still-expired) lock.
    const b = beginPlanning({ repo: REPO1, summary: "takeover" }, B, new Date("2026-06-22T10:00:03Z"));
    expect(b.status).toBe("GRANTED");
    expect(b.recoveredStaleLock).toBe(true);
  });

  it("end_planning refuses to unlink an EXPIRED lock (takeover handled by acquireLock)", () => {
    process.env.COORD_PLAN_LOCK_TTL_MS = "1000";
    const t0 = new Date("2026-06-22T10:00:00Z");
    beginPlanning({ repo: REPO1, summary: "x" }, A, t0);
    const end = endPlanning({ repo: REPO1 }, A, new Date("2026-06-22T10:00:05Z"));
    expect(end.detail.released).toBe(false);
    expect(end.detail.reason).toBe("expired");
  });

  it("plan_status reports the holder and the waiters", () => {
    const t0 = new Date("2026-06-22T10:00:00Z");
    beginPlanning({ repo: REPO1, summary: "holding" }, A, t0);
    beginPlanning({ repo: REPO1, summary: "waiting" }, B, new Date("2026-06-22T10:00:30Z")); // B -> WAIT, recorded
    const st = planStatus({ repo: REPO1 }, A, new Date("2026-06-22T10:00:31Z"));
    expect(st.lock.held).toBe(true);
    expect(st.lock.lock.session).toBe(A);
    expect(st.waiters.map((w: { session: string }) => w.session)).toContain(B);
  });
});

describe("release-lock (force) — the Coordination view's release action", () => {
  it("removes the slug-derived lock file and its waiters", () => {
    const t0 = new Date("2026-06-22T10:00:00Z");
    beginPlanning({ repo: REPO1, summary: "holding" }, A, t0);
    beginPlanning({ repo: REPO1, summary: "waiting" }, B, new Date("2026-06-22T10:00:30Z")); // records a waiter
    const r = forceReleaseLock(REPO1);
    expect(r.released).toBe(true);
    const st = planStatus({ repo: REPO1 }, A, new Date("2026-06-22T10:01:00Z"));
    expect(st.lock.held).toBe(false);
    expect(st.lock.stale).toBe(false); // file truly gone, not just expired
    expect(st.waiters).toEqual([]);
  });

  it("removes a lock written under a DIFFERENT slug when its stored repo field matches (pre-fix cwd-resolved name keys stay releasable)", async () => {
    const fs = await import("node:fs");
    const dir = path.join(sb, "coord", "plan-locks");
    fs.mkdirSync(dir, { recursive: true });
    // A lock file whose filename does NOT equal repoSlug("ekoa-dev") — the shape
    // produced by the old cwd-dependent slug for name keys.
    const orphan = path.join(dir, "deadbeefdeadbeef.json");
    fs.writeFileSync(
      orphan,
      JSON.stringify({ repo: "ekoa-dev", session: "old", summary: "s", startedAt: "2026-06-01T00:00:00Z", expiresAt: "2026-06-01T00:15:00Z", ttlMs: 900000 })
    );
    const r = forceReleaseLock("ekoa-dev");
    expect(r.released).toBe(true);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("leaves other repos' locks alone", () => {
    const t0 = new Date("2026-06-22T10:00:00Z");
    beginPlanning({ repo: REPO1, summary: "one" }, A, t0);
    beginPlanning({ repo: REPO2, summary: "two" }, B, t0);
    forceReleaseLock(REPO1);
    expect(lockStatus(REPO2, new Date("2026-06-22T10:01:00Z")).held).toBe(true);
  });
});

describe("repoSlug — deterministic keys", () => {
  it("hashes a non-absolute name AS-IS (cwd never leaks into the key)", () => {
    const before = repoSlug("some-name");
    const cwd = process.cwd();
    try {
      process.chdir(tmpdir());
      expect(repoSlug("some-name")).toBe(before);
    } finally {
      process.chdir(cwd);
    }
  });

  it("keeps absolute paths on the resolved-path key", () => {
    expect(repoSlug("/tmp/repo-one")).toBe(repoSlug("/tmp/repo-one/"));
  });
});

describe("intent -> conflict -> digest chain (drives the canary)", () => {
  it("surfaces an overlapping intent from another session in the digest, repo-scoped", async () => {
    const now = new Date("2026-06-22T10:00:00Z");
    // A declares intent on an area in REPO1.
    declareIntentTool({ repo: REPO1, area: "src/lib/runner.ts", reason: "rewiring up()" }, A, now);
    // B asks for its digest on the SAME area in REPO1 -> conflict surfaces.
    const dB = await coordDigestTool({ repo: REPO1, area: "src/lib/runner.ts" }, B, now);
    expect(dB.hasConflicts).toBe(true);
    expect(dB.text).toContain(A);
    expect(dB.text).toContain("rewiring up()");
    expect(dB.bytes).toBeLessThan(1400); // a few hundred tokens

    // Repo-scoping: the SAME area in REPO2 sees NO conflict (cross-repo isolation).
    const dB2 = await coordDigestTool({ repo: REPO2, area: "src/lib/runner.ts" }, B, now);
    expect(dB2.hasConflicts).toBe(false);
  });

  it("the digest always carries the begin_planning nudge", async () => {
    const d = await coordDigestTool({ repo: REPO1 }, A, new Date());
    expect(d.text).toContain("begin_planning");
  });

  it("a session does not conflict with its OWN intent", async () => {
    const now = new Date("2026-06-22T10:00:00Z");
    declareIntentTool({ repo: REPO1, area: "x", reason: "mine" }, A, now);
    const d = await coordDigestTool({ repo: REPO1, area: "x" }, A, now);
    expect(d.hasConflicts).toBe(false);
  });
});
