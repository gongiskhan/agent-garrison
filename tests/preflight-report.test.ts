import { describe, expect, it } from "vitest";
// @ts-ignore
import { buildReport } from "../fittings/seed/preflight/lib/report.mjs";
// @ts-ignore
import { reconcile } from "../fittings/seed/preflight/lib/ledger.mjs";

type Finding = { check: string; id: string; status: string; detail: string };

// A machine where nothing is wrong: one active composition brought up with every
// verify passing, one composition that has simply never been used, a registry
// that agrees with the seeds, one own-port fitting listening on its own port and
// mapped onto the tailnet.
//
// The point of this fixture is the SECOND composition. A doctor that reports
// warnings for a composition nobody is running reports warnings every day, and a
// report that is never clean is a report nobody reads.
function healthy(overrides: Record<string, unknown> = {}) {
  const upAt = "2026-09-08T09:00:00.000Z";
  const composition = (id: string, brought: boolean) => ({
    compositionId: id,
    parsed: { selections: [{ faculty: "observability", id: "alpha", pins: [] }], unfitted: [] },
    lastUp: brought ? { at: upAt, ok: true, verifyResults: [{ fittingId: "alpha", ok: true }] } : null,
    manifestMtimesMs: { "apm.yml": Date.parse(upAt) - 60_000, "local.yml": null, "apm.lock.yaml": null },
    diskSelections: ["alpha"],
    headSelections: ["alpha"],
    unfitted: [],
    diffStat: null
  });
  return {
    findRepoRoot: () => "/fixture",
    readSeedManifests: () => [{ id: "alpha", ownPort: true, defaultPort: 8076, portKeys: [], kinds: ["monitor"] }],
    readCuratedLibrary: () => [{ id: "alpha", localPath: "fittings/seed/alpha" }],
    readCompositions: async () => [composition("active", true), composition("spare", false)],
    readLiveListeners: async () => [{ port: 8076, pid: 42, command: "node" }],
    readStatusFiles: () => [{ fittingId: "alpha", port: 8076, pid: 42 }],
    readGatewayRecords: () => [],
    readProcessCommands: async () => new Map(),
    readSpawnRecords: () => [{ fittingId: "alpha", pid: 42 }],
    readTailscaleServeMap: async () => ({ 8076: "https://node.ts.net:8476" }),
    readActiveComposition: () => "active",
    readTetheredPorts: () => new Set<number>(),
    pidAlive: () => true,
    isAppUp: async () => true,
    fetchViews: async () => [{ fittingId: "alpha", port: 8076, tailnetUrl: "https://node.ts.net:8476", healthy: true }],
    fetchRunnerState: async () => null,
    appUrl: () => "http://127.0.0.1:8777",
    readFixJournal: async () => [],
    libraryChange: async () => ({ diff: null, diffHash: null }),
    ...overrides
  };
}

const report = (collectors: Record<string, unknown>) => buildReport({ startDir: "/fixture", collectors });

describe("a healthy machine reports PASS", () => {
  it("has no warnings and no failures", async () => {
    const r = await report(healthy());
    const loud = (r.findings as Finding[]).filter((f) => f.status === "warn" || f.status === "fail");
    expect(loud.map((f) => `${f.check}/${f.id}: ${f.detail}`)).toEqual([]);
    expect(r.summary.overall).toBe("pass");
  });

  // Ranking must never be filtering. The unused composition is still reported.
  it("still reports the unused composition, in the informational band", async () => {
    const r = await report(healthy());
    const spare = (r.findings as Finding[]).filter((f) => f.id.includes("spare"));
    expect(spare.length).toBeGreaterThan(0);
    // Nothing about it is loud, and the reason it was quieted is written down.
    expect(spare.filter((f) => f.status === "warn" || f.status === "fail")).toEqual([]);
    expect(spare.some((f) => f.status === "info" && f.detail.includes("not the active composition"))).toBe(true);
  });

  it("names the active composition it ranked by", async () => {
    expect((await report(healthy())).activeComposition).toBe("active");
  });

  // With no usable pointer nothing may be demoted: an unreadable config must
  // never be able to quiet a finding.
  it("demotes nothing when the active-composition pointer is unusable", async () => {
    const r = await report(healthy({ readActiveComposition: () => null }));
    expect(r.activeComposition).toBeNull();
    expect((r.findings as Finding[]).filter((f) => f.status === "info")).toEqual([]);
    expect(r.summary.overall).toBe("warn");
  });

  it("ignores a pointer naming a composition that does not exist", async () => {
    const r = await report(healthy({ readActiveComposition: () => "ghost" }));
    expect(r.activeComposition).toBeNull();
  });
});

describe("real problems survive the ranking", () => {
  it("keeps a failing verify in a NON-active composition at full severity", async () => {
    const collectors = healthy({
      readCompositions: async () => [{
        compositionId: "spare",
        parsed: { selections: [], unfitted: [] },
        lastUp: { at: "2026-09-08T09:00:00.000Z", ok: true, verifyResults: [{ fittingId: "beta", ok: false, exitCode: 1, expect: "ok", command: "x" }] },
        manifestMtimesMs: {}, diskSelections: [], headSelections: [], unfitted: [], diffStat: null
      }],
      readActiveComposition: () => "active"
    });
    const r = await report(collectors);
    const fails = (r.findings as Finding[]).filter((f) => f.status === "fail");
    expect(fails.some((f) => f.id === "spare:beta")).toBe(true);
    expect(r.summary.overall).toBe("fail");
  });

  it("keeps a registry gap failing even on an otherwise clean machine", async () => {
    const r = await report(healthy({ readCuratedLibrary: () => [] }));
    expect((r.findings as Finding[]).some((f) => f.check === "library-crosscheck" && f.status === "fail")).toBe(true);
    expect(r.summary.overall).toBe("fail");
  });

  it("reports a serve mapping that leads nowhere", async () => {
    const r = await report(healthy({ readTailscaleServeMap: async () => ({ 8076: "https://n:8476", 9999: "https://n:8399" }) }));
    const orphan = (r.findings as Finding[]).find((f) => f.id === "orphan-mappings");
    expect(orphan?.status).toBe("warn");
    expect(orphan?.detail).toContain("9999");
  });
});

// "What changed since last time" is derived from finding IDENTITY, not from
// diffing two reports: a report carries generatedAt, live pids and counts, so
// comparing two of them says "changed" every single run.
describe("the finding ledger", () => {
  const row = (status: string) => ({ firstSeenAt: "t0", lastSeenAt: "t0", lastStatus: status, seenCount: 1 });

  it("marks new, ongoing, regressed and resolved", () => {
    const previous = { version: 1, findings: { "a:1": row("warn"), "b:2": row("pass"), "gone:3": row("fail") } };
    const out = reconcile(previous, [
      { check: "a", id: "1", status: "fail" },
      { check: "b", id: "2", status: "pass" },
      { check: "c", id: "9", status: "warn" }
    ], "t1");
    expect(out.annotated.map((f: any) => `${f.check}:${f.id}=${f.age}`))
      .toEqual(["a:1=regressed", "b:2=ongoing", "c:9=new"]);
    expect(out.resolved.map((r: any) => r.key)).toEqual(["gone:3"]);
  });

  it("keeps the date a finding was first seen", () => {
    const out = reconcile({ version: 1, findings: { "a:1": row("warn") } }, [{ check: "a", id: "1", status: "warn" }], "t9");
    expect(out.annotated[0].firstSeenAt).toBe("t0");
    expect(out.next.findings["a:1"].seenCount).toBe(2);
  });

  // A pass that disappears is not an achievement worth announcing.
  it("does not announce a vanished pass as resolved", () => {
    const out = reconcile({ version: 1, findings: { "a:1": row("pass"), "b:2": row("info") } }, [], "t1");
    expect(out.resolved).toEqual([]);
  });

  it("annotates and persists through buildReport", async () => {
    let stored: unknown = null;
    const collectors = healthy({
      readLedger: async () => ({ version: 1, findings: {} }),
      writeLedger: async (doc: unknown) => { stored = doc; }
    });
    const r = await buildReport({ startDir: "/fixture", collectors, ledger: "update" });
    expect((r.findings as any[]).every((f) => f.age === "new")).toBe(true);
    expect(stored).not.toBeNull();
  });

  // Reading a corrupt ledger as empty would announce the whole board as new and
  // everything remembered as resolved. Refuse loudly instead.
  it("reports an unusable ledger instead of silently starting over", async () => {
    const collectors = healthy({
      readLedger: async () => { throw new Error("not valid JSON"); },
      writeLedger: async () => { throw new Error("must not be called"); }
    });
    const r = await buildReport({ startDir: "/fixture", collectors, ledger: "update" });
    const row = (r.findings as Finding[]).find((f) => f.check === "ledger");
    expect(row?.status).toBe("warn");
    expect(row?.detail).toContain("not valid JSON");
  });

  it("does not touch the ledger when it is off", async () => {
    const collectors = healthy({
      readLedger: async () => { throw new Error("must not be read"); },
      writeLedger: async () => { throw new Error("must not be written"); }
    });
    const r = await buildReport({ startDir: "/fixture", collectors });
    expect((r.findings as Finding[]).some((f) => f.check === "ledger")).toBe(false);
  });
});
