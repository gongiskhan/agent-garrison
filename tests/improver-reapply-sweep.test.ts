import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore - pure .mjs
import { runReapplySweep, readReapplySweepLog } from "../fittings/seed/improver/lib/reapply-sweep.mjs";
// @ts-ignore - pure .mjs
import { loadQueue } from "../fittings/seed/improver/lib/review-queue.mjs";

function writeQueue(dir: string, entries: any[]): string {
  const file = join(dir, "review-queue.json");
  writeFileSync(file, JSON.stringify(entries, null, 2), "utf8");
  return file;
}

function appliedEntry(id: string, targetFile: string) {
  return {
    id,
    rule: "memory-consolidation",
    targetClass: "memory",
    claim: "test claim",
    diff: "+ some tracked improvement line",
    decision: "approved",
    applyVia: "reconcile",
    status: "applied",
    at: "2026-06-15T00:00:00Z",
    appliedAt: "2026-06-15T00:00:01Z",
    evidence: { targetFile, bytes: 10, sha: "sha256:whatever" },
  };
}

describe("reapply-sweep - runReapplySweep", () => {
  it("reapplies (restores the marker) when an applied entry's target was clobbered", async () => {
    const root = mkdtempSync(join(tmpdir(), "gar-sweep-"));
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const target = join(root, "knowledge-memory.md");
    // clobbered: the file exists but has been overwritten, losing the marker
    writeFileSync(target, "# Memory\nsomething else entirely\n", "utf8");

    const entry = appliedEntry("id-1", target);
    const queuePath = writeQueue(stateDir, [entry]);

    const summary = await runReapplySweep({ stateDir, queuePath });
    expect(summary.checked).toBe(1);
    expect(summary.restored).toBe(1);
    expect(summary.failed).toEqual([]);

    const after = readFileSync(target, "utf8");
    expect(after).toContain("<!-- improver:id-1 -->");
    expect(after).toContain("some tracked improvement line");

    const queue = await loadQueue(queuePath);
    expect(queue[0].status).toBe("applied");
    expect(queue[0].evidence.targetFile).toBe(target);

    const log = await readReapplySweepLog(stateDir);
    expect(log).toHaveLength(1);
    expect(log[0]).toEqual(summary);
  });

  it("leaves an already-protected entry untouched and does not count it as restored", async () => {
    const root = mkdtempSync(join(tmpdir(), "gar-sweep-ok-"));
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const target = join(root, "knowledge-memory.md");
    writeFileSync(target, "# Memory\n\n<!-- improver:id-2 -->\n## rule: claim\nsome tracked improvement line\n", "utf8");
    const before = readFileSync(target, "utf8");

    const entry = appliedEntry("id-2", target);
    const queuePath = writeQueue(stateDir, [entry]);

    const summary = await runReapplySweep({ stateDir, queuePath });
    expect(summary.checked).toBe(1);
    expect(summary.restored).toBe(0);
    expect(summary.failed).toEqual([]);
    expect(readFileSync(target, "utf8")).toBe(before); // no unnecessary write
  });

  it("marks reapply-failed with a reason when the target file no longer exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "gar-sweep-missing-"));
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const target = join(root, "does-not-exist.md");

    const entry = appliedEntry("id-3", target);
    const queuePath = writeQueue(stateDir, [entry]);

    const summary = await runReapplySweep({ stateDir, queuePath });
    expect(summary.checked).toBe(1);
    expect(summary.restored).toBe(0);
    expect(summary.failed).toEqual([{ id: "id-3", reason: "target file missing" }]);

    const queue = await loadQueue(queuePath);
    expect(queue[0].status).toBe("reapply-failed");
    expect(queue[0].reapplyFailureReason).toBe("target file missing");
    expect(queue[0].reapplyFailedAt).toBeTruthy();
  });

  it("ignores entries that are not status:applied", async () => {
    const root = mkdtempSync(join(tmpdir(), "gar-sweep-ignore-"));
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const target = join(root, "t.md");
    writeFileSync(target, "# base\n", "utf8");

    const pending = { ...appliedEntry("id-4", target), status: "pending" };
    const rejected = { ...appliedEntry("id-5", target), status: "rejected" };
    const queuePath = writeQueue(stateDir, [pending, rejected]);

    const summary = await runReapplySweep({ stateDir, queuePath });
    expect(summary.checked).toBe(0);
    expect(summary.restored).toBe(0);
    expect(summary.failed).toEqual([]);
  });

  it("never clobbers a malformed/unreadable review-queue.json with an empty queue", async () => {
    const root = mkdtempSync(join(tmpdir(), "gar-sweep-corrupt-queue-"));
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const queuePath = join(stateDir, "review-queue.json");
    const corrupt = "{ this is not valid json";
    writeFileSync(queuePath, corrupt, "utf8");

    const summary = await runReapplySweep({ stateDir, queuePath });
    expect(summary.checked).toBe(0);
    expect(summary.queueReadable).toBe(false);

    // the real (corrupt) file must be left exactly as it was - never
    // overwritten with "[]" just because it happened to be unreadable.
    expect(readFileSync(queuePath, "utf8")).toBe(corrupt);
  });
});
