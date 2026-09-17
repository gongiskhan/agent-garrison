import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
// @ts-ignore — the fitting's standalone modules deliberately have no TS dependency.
import { LANGS, diagnosticKeysFor, keysFor, localiseFindings, normaliseLang, otherLang, t, fmtTime, fmtDateTime } from "../fittings/seed/preflight/lib/i18n.mjs";
// @ts-ignore
import {
  assessDrift, assessSweepResults, assessVerifyResults, checkConfigProjection, classifyOrphans, crossCheckLibrary,
  findHookCwdAsymmetry, findOrphanServeMappings, findPortCollisions, attributeSandboxListeners, scanKinds, serveCoverage
} from "../fittings/seed/preflight/lib/preflight-core.mjs";

type Finding = { check: string; id: string; status: string; detail: string; fix?: string; evidence?: string; action?: { id: string; params: unknown; command: string }; i18n?: unknown };

const FITTING = path.resolve(__dirname, "..", "fittings", "seed", "preflight");

// Every situation a check can emit, driven with plain fixtures. Together these
// cover every message key the core tags a finding with; the parity test below
// asserts that from the source text, and this corpus proves it at runtime.
function corpus(): Finding[] {
  const out: Finding[] = [];
  out.push(...crossCheckLibrary(["alpha", "beta"], [{ id: "alpha", localPath: "fittings/seed/alpha" }, { id: "ghost", localPath: "fittings/seed/ghost" }]));
  out.push(...crossCheckLibrary(["alpha"], [{ id: "alpha", localPath: "fittings/seed/alpha" }]));
  const claims = [
    { port: 8080, claimant: "one", source: "default_port", key: "port", stationedIn: ["c"], pins: [] },
    { port: 8080, claimant: "two", source: "default_port", key: "port", stationedIn: ["c"], pins: [] },
    { port: 8090, claimant: "three", source: "default_port", key: "port", stationedIn: ["c"], pins: [] },
    { port: 8090, claimant: "four", source: "default_port", key: "port", stationedIn: ["c"], pins: [{ compositionId: "c", port: 8099 }] },
    { port: 7443, claimant: "five", source: "default_port", key: "port", stationedIn: [], pins: [] },
    { port: 8443, claimant: "six", source: "default_port", key: "port", stationedIn: [], pins: [] },
    { port: 8100, claimant: "seven", source: "default_port", key: "port", stationedIn: [], pins: [] },
    { port: 8101, claimant: "eight", source: "default_port", key: "port", stationedIn: [], pins: [] }
  ];
  out.push(...findPortCollisions(claims,
    [{ port: 8100, pid: 11, command: "node" }, { port: 8101, pid: 12, command: "java" }],
    [{ fittingId: "seven", port: 8100, pid: 99 }]));
  out.push(...findPortCollisions([], [], []));
  out.push(...attributeSandboxListeners([{ port: 8099, claimant: "scheduler" }], [{ port: 18099, pid: 5 }], { profile: "node", offsets: { dev: 10000 } }));
  out.push(...assessVerifyResults([
    { compositionId: "never", lastUp: null, runnerState: null },
    { compositionId: "spare", lastUp: null, runnerState: null },
    { compositionId: "live", lastUp: null, runnerState: { status: "failed", verifyResults: [{ fittingId: "x", ok: false, exitCode: 1, expect: "ok", command: "node probe", stderr: "boom" }] } },
    { compositionId: "old", lastUp: { at: "2026-09-01T00:00:00.000Z", verifyResults: [{ fittingId: "y", ok: true }] }, runnerState: null }
  ], { activeCompositionId: "never" }));
  out.push(...assessVerifyResults([], {}));
  out.push(...assessSweepResults("c", [{ fittingId: "a", ok: true, durationMs: 12 }, { fittingId: "b", ok: false, exitCode: 2, expect: "ok", command: "bash v.sh", stderr: "no" }]));
  out.push(...serveCoverage({ views: [{ fittingId: "un", port: 8076, tailnetUrl: null }, { fittingId: "sick", port: 8077, tailnetUrl: "https://n.ts.net:8477", healthy: false }] }));
  out.push(...serveCoverage({ views: [{ fittingId: "ok", port: 8076, tailnetUrl: "https://n.ts.net:8476", healthy: true }] }));
  out.push(...serveCoverage({ statusFiles: [{ fittingId: "un", port: 8076 }], serveMap: {} }));
  out.push(...serveCoverage({ statusFiles: [{ fittingId: "ok", port: 8076 }], serveMap: { 8076: "x" } }));
  out.push(...findOrphanServeMappings({ 8090: "x" }, [], new Set()));
  out.push(...findOrphanServeMappings({ 8090: "x", 8091: "y" }, [], new Set()));
  out.push(...findHookCwdAsymmetry([{ id: "bm", vars: [
    { name: "G", expr: "$SCRIPT_DIR/..", setupPath: "/a", verifyPath: "/b", setupExists: true, verifyExists: true, guarded: true },
    { name: "D", expr: "$SCRIPT_DIR/../..", setupPath: "/a", verifyPath: "/b", setupExists: false, verifyExists: true, guarded: false },
    { name: "A", expr: "$SCRIPT_DIR/../../..", setupPath: "/a", verifyPath: "/b", setupExists: true, verifyExists: true, guarded: false }
  ] }]));
  out.push(...findHookCwdAsymmetry([{ id: "bm", vars: [] }]));
  out.push(...checkConfigProjection([
    { id: "file-browser", configKeys: [{ key: "root", type: "string", default: "" }, { key: "blob", type: "object", default: "" }], envNames: ["GARRISON_FILE_BROWSER_ROOT"] },
    { id: "dev-env", configKeys: [{ key: "port", type: "integer", default: "1" }], envNames: ["GARRISON_DEV_ENV_PORT", "GARRISON_DEVENV_PORT"] }
  ]));
  out.push(...checkConfigProjection([{ id: "fine", configKeys: [], envNames: [] }]));
  out.push(...classifyOrphans([{ fittingId: "dead", port: 1, pid: 7 }], [{ fittingId: "leak", pid: 8 }], (pid: number) => pid === 8));
  out.push(...classifyOrphans([], [], () => true));
  const drift = (extra: Record<string, unknown>) => ({
    compositionId: "c", lastUp: { at: "2026-09-01T00:00:00.000Z", ok: true }, manifestMtimesMs: { "apm.yml": Date.parse("2026-09-02T00:00:00.000Z") },
    diskSelections: ["a", "b"], headSelections: ["a", "z"], unfitted: [], diffStat: " apm.yml | 2 +-", ...extra
  });
  out.push(...assessDrift(drift({ activeCompositionId: "c" })));
  out.push(...assessDrift(drift({ activeCompositionId: "other" })));
  out.push(...assessDrift({ compositionId: "c", lastUp: null, manifestMtimesMs: null, diskSelections: ["a"], headSelections: ["a"], unfitted: [], diffStat: " x | 1 +" }));
  out.push(...assessDrift({ compositionId: "c", lastUp: { at: "2026-09-01T00:00:00.000Z" }, manifestMtimesMs: {}, diskSelections: ["a"], headSelections: ["a"], unfitted: [], diffStat: null }));
  out.push(...assessDrift({ compositionId: "c", lastUp: null, manifestMtimesMs: null, diskSelections: ["a"], headSelections: ["a"], unfitted: [], diffStat: null }));
  out.push(...scanKinds([{ id: "m", kinds: ["agent-skill", "banana"] }], { vocabulary: new Set(["monitor"]) }));
  out.push(...scanKinds([{ id: "m", kinds: ["monitor"] }], { vocabulary: new Set(["monitor"]) }));
  out.push(...scanKinds([{ id: "m", kinds: ["monitor"] }], { vocabulary: null }));
  return out;
}

const strip = (f: Finding) => { const { i18n, ...rest } = f; return rest; };

describe("preflight i18n mechanism", () => {
  it("normalises language tags and flips between exactly two", () => {
    expect(LANGS).toEqual(["en", "pt"]);
    expect(normaliseLang("pt-BR")).toBe("pt");
    expect(normaliseLang("PT")).toBe("pt");
    expect(normaliseLang("zz")).toBe("en");
    expect(normaliseLang("zz", "pt")).toBe("pt");
    expect(normaliseLang("", "pt")).toBe("pt");
    expect(otherLang("en")).toBe("pt");
    expect(otherLang("pt")).toBe("en");
  });

  it("carries the same chrome keys in both languages, and they differ", () => {
    expect(keysFor("pt")).toEqual(keysFor("en"));
    expect(keysFor("en").length).toBeGreaterThan(50);
    const differing = keysFor("en").filter((k) => t("en", k) !== t("pt", k));
    expect(differing.length).toBeGreaterThan(40);
  });

  it("fills placeholders, picks plural forms by n, and returns the key for a gap", () => {
    expect(t("en", "headline.failing", { n: 1 })).toBe("1 fitting failing verify:");
    expect(t("en", "headline.failing", { n: 3 })).toBe("3 fittings failing verify:");
    expect(t("pt", "headline.failing", { n: 1 })).toBe("1 fitting a falhar o verify:");
    expect(t("pt", "no.such.key")).toBe("no.such.key");
  });

  it("formats timestamps by the UI language, day first in both", () => {
    const iso = "2026-09-17T10:12:45.000Z";
    expect(fmtTime("pt", iso)).toMatch(/\d\d:\d\d:\d\d/);
    expect(fmtDateTime("en", iso)).toMatch(/^17\/09\/2026/);
    expect(fmtDateTime("pt", iso)).toMatch(/^17\/09\/26/);
    expect(fmtTime("en", "garbage")).toBe("garbage");
  });
});

describe("preflight diagnostics catalog", () => {
  const core = readFileSync(path.join(FITTING, "lib", "preflight-core.mjs"), "utf8")
    + readFileSync(path.join(FITTING, "lib", "report.mjs"), "utf8");
  // Every literal key the source tags a finding with — plain, in a ternary,
  // or as a demote reason — scanned as text the way preflight-parity.test.ts
  // pins RESERVED_SERVE: the module cannot import a catalog of itself.
  const tagged = new Set<string>();
  for (const m of core.matchAll(/(?:key:\s*|demote\([^)]*?,\s*"[^"]*",\s*|\?\s*|:\s*)"([a-z-]+\.[A-Za-z.]+)"/g)) tagged.add(m[1]);
  for (const m of core.matchAll(/"((?:demote|state)\.[A-Za-z]+)"/g)) tagged.add(m[1]);
  const pt = new Set(diagnosticKeysFor("pt"));
  const base = (k: string) => k.replace(/\.(fix|command|one|other)$/, "");

  it("translates every key the checks emit", () => {
    const missing = [...tagged].filter((k) => !pt.has(k) && !pt.has(`${k}.other`));
    expect(missing).toEqual([]);
    expect(tagged.size).toBeGreaterThan(45);
  });

  it("carries no orphan Portuguese key", () => {
    const glue = new Set(["finding.demoted", "state.present", "state.missing", "verify-results.label.attempt", "verify-results.label.lastUp"]);
    const orphans = [...pt].filter((k) => !glue.has(k) && !tagged.has(base(k)));
    expect(orphans).toEqual([]);
  });
});

describe("localiseFindings", () => {
  const findings = corpus();

  it("drives every catalog key at least once through the fixtures", () => {
    const seen = new Set(findings.map((f) => (f.i18n as { key: string } | undefined)?.key).filter(Boolean));
    const untagged = findings.filter((f) => !f.i18n).map((f) => `${f.check}/${f.id}`);
    expect(untagged).toEqual([]);
    expect(seen.size).toBeGreaterThan(40);
  });

  it("leaves English byte-identical and strips the tag", () => {
    const en = localiseFindings(findings, "en") as Finding[];
    expect(en).toEqual(findings.map(strip));
    expect(en.some((f) => "i18n" in f)).toBe(false);
  });

  it("renders every finding in Portuguese with no unresolved placeholder", () => {
    const pt = localiseFindings(findings, "pt") as Finding[];
    for (const f of pt) {
      expect(f).not.toHaveProperty("i18n");
      for (const text of [f.detail, f.fix, f.action?.command].filter(Boolean) as string[]) {
        // The one legitimate brace: the JSON snippet the registry fix quotes.
        expect(text.replace(/\{"id"/g, "")).not.toMatch(/\{[A-Za-z]/);
        expect(text).not.toMatch(/^[a-z-]+\.[A-Za-z.]+$/);
      }
    }
  });

  it("really translates: no Portuguese detail equals its English source", () => {
    const en = localiseFindings(findings, "en") as Finding[];
    const pt = localiseFindings(findings, "pt") as Finding[];
    const same = en.filter((f, i) => f.detail === pt[i].detail).map((f) => `${f.check}/${f.id}`);
    expect(same).toEqual([]);
  });

  it("preserves what crosses the wire to the repair whitelist, and the evidence", () => {
    const en = localiseFindings(findings, "en") as Finding[];
    const pt = localiseFindings(findings, "pt") as Finding[];
    en.forEach((f, i) => {
      expect(pt[i].check).toBe(f.check);
      expect(pt[i].id).toBe(f.id);
      expect(pt[i].status).toBe(f.status);
      expect(pt[i].evidence).toBe(f.evidence);
      expect(pt[i].action?.id).toBe(f.action?.id);
      expect(pt[i].action?.params).toEqual(f.action?.params);
    });
  });

  it("rebuilds a demoted sentence from its parts in Portuguese", () => {
    const demoted = findings.filter((f) => f.status === "info" && (f.i18n as { demote?: string })?.demote);
    expect(demoted.length).toBeGreaterThan(2);
    const pt = localiseFindings(demoted, "pt") as Finding[];
    for (const f of pt) expect(f.detail).toMatch(/\)$/);
    const notActive = pt.find((f) => f.check === "verify-results" && f.id === "spare");
    expect(notActive?.detail).toContain("(spare não é a composição ativa");
  });

  it("interpolates nested messages, so the verify label agrees with the sentence", () => {
    const pt = localiseFindings(findings, "pt") as Finding[];
    expect(pt.find((f) => f.id === "live:x")?.detail).toContain("na última tentativa (estado do runner: failed)");
    expect(pt.find((f) => f.id === "old" && f.check === "verify-results")?.detail).toContain("no último up (2026-09-01T00:00:00.000Z)");
    expect(pt.find((f) => f.id === "bm:D")?.detail).toContain("(em falta)");
    expect(pt.find((f) => f.id === "bm:D")?.detail).toContain("(presente)");
  });

  it("plural forms agree with the count", () => {
    const pt = localiseFindings(findings, "pt") as Finding[];
    const orphanRows = pt.filter((f) => f.id === "orphan-mappings").map((f) => f.detail);
    expect(orphanRows[0]).toMatch(/^1 mapeamento do tailscale serve aponta/);
    expect(orphanRows[1]).toMatch(/^2 mapeamentos do tailscale serve apontam/);
  });
});
