import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
// eslint-disable-next-line
const patterns = (): Promise<any> =>
  import(pathToFileURL(path.join(REPO, "fittings/seed/improver/lib/shadcn-patterns.mjs")).href);
// eslint-disable-next-line
const rq = (): Promise<any> =>
  import(pathToFileURL(path.join(REPO, "fittings/seed/improver/lib/review-queue.mjs")).href);

let dataDir: string;
let repoRoot: string;
beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "imp-"));
  process.env.IMPROVER_DATA = dataDir;
  repoRoot = mkdtempSync(path.join(os.tmpdir(), "repo-"));
  mkdirSync(path.join(repoRoot, "src"), { recursive: true });
  writeFileSync(path.join(repoRoot, "src", "a.ts"), "line1\nconst leak = readSecret();\nline3\n");
});
afterEach(() => {
  delete process.env.IMPROVER_DATA;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("pattern 1 — evidence discipline (enqueue preserves evidence + confidence)", () => {
  it("a proposal's file:line evidence and confidence survive enqueue; legacy proposals still load", async () => {
    const { enqueue } = await rq();
    const withEv = enqueue([], {
      id: "p1", rule: "correctness", targetClass: "code", claim: "x", diff: "d", decision: "?", applyVia: "v", at: "t",
      citations: [{ file: "src/a.ts", line: 2, snippet: "readSecret" }], confidence: "high"
    });
    expect(withEv[0].citations).toEqual([{ file: "src/a.ts", line: 2, snippet: "readSecret" }]);
    expect(withEv[0].confidence).toBe("high");
    // legacy proposal (no evidence) — unaffected
    const legacy = enqueue([], { id: "p2", rule: "r", targetClass: "c", claim: "x", diff: "d", decision: "?", applyVia: "v", at: "t" });
    expect(legacy[0].citations).toBeUndefined();
    expect(legacy[0].confidence).toBeUndefined();
  });
});

describe("pattern 2 — vet pass drops proposals whose evidence no longer holds", () => {
  it("keeps a proposal whose cited snippet is present; DROPS a planted false-positive", async () => {
    const { vetProposals } = await patterns();
    const good = { id: "good", claim: "real", citations: [{ file: "src/a.ts", line: 2, snippet: "readSecret" }] };
    const falsePositive = { id: "planted-fp", claim: "bogus", citations: [{ file: "src/a.ts", line: 2, snippet: "THIS_STRING_IS_NOT_THERE" }] };
    const missingFile = { id: "gone", claim: "x", citations: [{ file: "src/deleted.ts", line: 1 }] };
    const logs: string[] = [];
    const { kept, dropped } = vetProposals([good, falsePositive, missingFile], { repoRoot, log: (m: string) => logs.push(m) });
    expect(kept.map((p: { id: string }) => p.id)).toEqual(["good"]);
    expect(dropped.map((p: { id: string }) => p.id).sort()).toEqual(["gone", "planted-fp"]);
    expect(logs.join("\n")).toMatch(/vet: dropped planted-fp — evidence stale at src\/a\.ts:2/);
  });
});

describe("pattern 3 — rejection ledger: a rejected finding does not reappear", () => {
  it("records a reject with a reason and suppresses the same finding on the next run", async () => {
    const { recordRejection, suppressRejected, isSuppressed } = await patterns();
    const proposal = { id: "feedback-x", rule: "feedback", targetClass: "orchestrator/policy", claim: "step X up" };

    // RUN 1: the finding is fresh — not suppressed.
    const before = suppressRejected([proposal]);
    expect(before.kept.map((p: { id: string }) => p.id)).toEqual(["feedback-x"]);

    // human rejects it WITH A REASON.
    recordRejection(proposal, "not worth it — X is intentionally lightweight", "2026-07-12T00:00:00Z");
    expect(isSuppressed(proposal)).toBe(true);

    // RUN 2: the SAME finding (even re-phrased identically, new id) is suppressed.
    const rerun = { id: "feedback-x-run2", rule: "feedback", targetClass: "orchestrator/policy", claim: "Step X Up" };
    const after = suppressRejected([rerun]);
    expect(after.kept).toEqual([]);
    expect(after.suppressed.map((p: { id: string }) => p.id)).toEqual(["feedback-x-run2"]);

    // the ledger persisted the reason
    const ledger = JSON.parse(readFileSync(path.join(dataDir, "rejection-ledger.json"), "utf8"));
    expect(ledger.rejections[0].reason).toContain("not worth it");
  });

  it("markRejected persists the rejection reason on the proposal", async () => {
    const { markRejected } = await rq();
    const q = markRejected([{ id: "a", status: "pending" }], "a", "2026-07-12T00:00:00Z", "duplicate");
    expect(q[0].status).toBe("rejected");
    expect(q[0].rejectionReason).toBe("duplicate");
  });
});

describe("pattern 4 — reconcile verifies applied, refreshes drifted, retires stale", () => {
  it("verifies applied entries, refreshes valid pending, retires evidence-gone + over-TTL pending", async () => {
    const { reconcile } = await patterns();
    const queue = [
      { id: "applied-ok", status: "applied", citations: [{ file: "src/a.ts", line: 2, snippet: "readSecret" }] },
      { id: "pending-ok", status: "pending", at: "2026-07-12T00:00:00Z", citations: [{ file: "src/a.ts", line: 2, snippet: "readSecret" }] },
      { id: "pending-gone", status: "pending", at: "2026-07-12T00:00:00Z", citations: [{ file: "src/deleted.ts", line: 1 }] },
      { id: "pending-old", status: "pending", at: "2020-01-01T00:00:00Z", evidence: [] },
    ];
    const logs: string[] = [];
    const r = reconcile(queue, { repoRoot, ttlDays: 30, now: "2026-07-12T12:00:00Z", log: (m: string) => logs.push(m) });
    expect(r.verified).toBe(1);
    expect(r.refreshed).toBe(1);
    expect(r.retired).toBe(2);
    const byId = Object.fromEntries(r.queue.map((p: { id: string }) => [p.id, p]));
    expect(byId["pending-gone"].status).toBe("retired");
    expect(byId["pending-gone"].retiredReason).toBe("evidence gone");
    expect(byId["pending-old"].status).toBe("retired");
    expect(byId["applied-ok"].status).toBe("applied"); // never touches applied history
    expect(logs.join("\n")).toMatch(/reconcile: verified 1 applied · refreshed 1 pending · retired 2 stale/);
  });
});

describe("hardening (S8 codex findings)", () => {
  it("I2: a structurally-corrupt ledger THROWS (never silently un-suppresses or clobbers)", async () => {
    const { loadRejectionLedger, recordRejection } = await patterns();
    const { writeFileSync } = await import("node:fs");
    const p = await import("node:path");
    const f = p.join(dataDir, "rejection-ledger.json");
    writeFileSync(f, JSON.stringify({ rejections: "oops" })); // valid JSON, wrong shape
    expect(() => loadRejectionLedger()).toThrow(/not a \{rejections/);
    expect(() => recordRejection({ id: "x", rule: "r", targetClass: "c", claim: "y" }, "reason", "t")).toThrow(/refusing/);
    // the corrupt file is untouched
    expect(JSON.parse((await import("node:fs")).readFileSync(f, "utf8")).rejections).toBe("oops");
  });

  it("I4: a citation escaping the repo root reads as 'does not hold' (drops the proposal), never an out-of-root read", async () => {
    const { evidenceHolds, proposalEvidenceHolds } = await patterns();
    expect(evidenceHolds({ file: "/etc/passwd", line: 1 }, repoRoot)).toBe(false);
    expect(evidenceHolds({ file: "../../../../etc/passwd", line: 1 }, repoRoot)).toBe(false);
    // an in-root citation still works
    expect(evidenceHolds({ file: "src/a.ts", line: 2, snippet: "readSecret" }, repoRoot)).toBe(true);
    // a proposal whose only citation escapes is vetted out
    expect(proposalEvidenceHolds({ citations: [{ file: "/etc/passwd", line: 1 }] }, repoRoot)).toBe(false);
  });
});
