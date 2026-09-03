import { describe, it, expect } from "vitest";
// The core is a pure .mjs module with no type declarations; single-line import
// so the @ts-ignore anchors to the module specifier and suppresses TS7016.
// @ts-ignore
import { parseManifest, parseComposition, crossCheckLibrary, buildPortClaims, findPortCollisions, servePort, assessVerifyResults, assessSweepResults, serveCoverage, classifyOrphans, assessDrift, scanKinds, summarize } from "../fittings/seed/preflight/lib/preflight-core.mjs";

type Finding = { check: string; id: string; status: "pass" | "warn" | "fail"; detail: string; evidence?: string; fix?: string };

const fails = (f: Finding[]) => f.filter((x) => x.status === "fail");
const warns = (f: Finding[]) => f.filter((x) => x.status === "warn");

// ---------------------------------------------------------------------------
// parsers
// ---------------------------------------------------------------------------
describe("parseManifest", () => {
  it("extracts default_port, own_port, and port-like config_schema defaults", () => {
    const m = parseManifest(
      [
        "name: x",
        "x-garrison:",
        "  own_port: true",
        "  default_port: 8076",
        "  config_schema:",
        "    - key: port",
        "      type: integer",
        "      default: 8076",
        "    - key: health_port",
        "      default: 8099",
        "    - key: bind_host",
        "      default: 127.0.0.1",
        "  provides:",
        "    - kind: monitor"
      ].join("\n"),
      "x"
    );
    expect(m.ownPort).toBe(true);
    expect(m.defaultPort).toBe(8076);
    expect(m.portKeys).toEqual([
      { key: "port", default: 8076 },
      { key: "health_port", default: 8099 }
    ]);
    expect(m.kinds).toEqual(["monitor"]);
  });

  it("handles the improver pattern: config_schema port with NO default_port", () => {
    const m = parseManifest(
      ["x-garrison:", "  config_schema:", "    - key: port", "      default: 8093"].join("\n"),
      "improver"
    );
    expect(m.defaultPort).toBeNull();
    expect(m.portKeys).toEqual([{ key: "port", default: 8093 }]);
  });
});

describe("parseComposition", () => {
  const doc = [
    "x-garrison:",
    "  composition:",
    "    selections:",
    "      channels:",
    "        - id: slack-channel",
    "          config:",
    "            slack_port: 9512",
    "            chat_timeout_ms: 600000",
    "        - id: whatsapp-web",
    "      observability:",
    "        - id: monitor-default",
    "          config:",
    "            port: 8077",
    "    unfitted:",
    "      - vault-git-sync",
    "    prompt_sources:",
    "      orchestrator: .garrison/prompts/orchestrator.md"
  ].join("\n");

  it("extracts selections per faculty with port-like pins only", () => {
    const c = parseComposition(doc);
    expect(c.selections.map((s: { id: string }) => s.id)).toEqual(["slack-channel", "whatsapp-web", "monitor-default"]);
    expect(c.selections[0].pins).toEqual([{ key: "slack_port", value: 9512 }]); // chat_timeout_ms is not a port
    expect(c.selections[2].faculty).toBe("observability");
    expect(c.selections[2].pins).toEqual([{ key: "port", value: 8077 }]);
  });

  it("extracts unfitted and stops at the next sibling key", () => {
    const c = parseComposition(doc);
    expect(c.unfitted).toEqual(["vault-git-sync"]);
  });
});

// ---------------------------------------------------------------------------
// check 2 — library cross-check
// ---------------------------------------------------------------------------
describe("crossCheckLibrary", () => {
  it("fails a seed dir with no entry and warns on a dangling entry", () => {
    const f = crossCheckLibrary(
      ["testing", "ports-default"],
      [
        { id: "ports-default", localPath: "fittings/seed/ports-default" },
        { id: "taste-copy", localPath: "fittings/seed/taste-copy" }
      ]
    ) as Finding[];
    expect(fails(f).map((x) => x.id)).toEqual(["testing"]);
    expect(warns(f).map((x) => x.id)).toEqual(["taste-copy"]);
    expect(fails(f)[0].fix).toContain("data/library.json");
  });

  it("passes a clean pairing with a single pass row", () => {
    const f = crossCheckLibrary(["a"], [{ id: "a", localPath: "fittings/seed/a" }]) as Finding[];
    expect(f).toHaveLength(1);
    expect(f[0].status).toBe("pass");
  });

  it("attaches whitelisted fix actions to both directions", () => {
    const f = crossCheckLibrary(["missing"], [{ id: "dangling", localPath: "fittings/seed/dangling" }]) as Finding[];
    const add = f.find((x) => x.id === "missing");
    const rm = f.find((x) => x.id === "dangling");
    expect(add?.action).toEqual(expect.objectContaining({ id: "library-add-entry", params: { fittingId: "missing" } }));
    expect(rm?.action).toEqual(expect.objectContaining({ id: "library-remove-entry", params: { entryId: "dangling" } }));
  });
});

// ---------------------------------------------------------------------------
// check 3 — ports
// ---------------------------------------------------------------------------
describe("port claims + collisions", () => {
  it("derives serve ports per the mesh formula", () => {
    expect(servePort(8076)).toBe(8476);
    expect(servePort(8098)).toBe(8498);
    expect(servePort(7098)).toBe(8498);
  });

  it("one claim when default_port and schema port agree; extra claims when they differ", () => {
    const claims = buildPortClaims([
      { id: "agree", ownPort: true, defaultPort: 8088, portKeys: [{ key: "port", default: 8088 }], kinds: [] },
      { id: "sched", ownPort: false, defaultPort: null, portKeys: [{ key: "health_port", default: 8099 }], kinds: [] }
    ]);
    expect(claims).toEqual([
      { port: 8088, claimant: "agree", source: "default_port" },
      { port: 8099, claimant: "sched", source: "config_schema health_port" }
    ]);
  });

  it("includes composition pins as claims", () => {
    const claims = buildPortClaims([], [
      { compositionId: "default-2", parsed: { selections: [{ faculty: "channels", id: "slack-channel", pins: [{ key: "slack_port", value: 9512 }] }], unfitted: [] } }
    ]);
    expect(claims).toEqual([{ port: 9512, claimant: "slack-channel", source: "default-2 pin slack_port" }]);
  });

  it("fails a canonical collision between two fittings", () => {
    const f = findPortCollisions([
      { port: 8093, claimant: "improver", source: "config_schema port" },
      { port: 8093, claimant: "newbie", source: "default_port" }
    ]) as Finding[];
    expect(fails(f)).toHaveLength(1);
    expect(fails(f)[0].detail).toContain("improver");
    expect(fails(f)[0].detail).toContain("newbie");
  });

  it("fails a serve-axis collision between DIFFERENT canonical ports (8098 vs 7098)", () => {
    const f = findPortCollisions([
      { port: 8098, claimant: "remote-shell-runtime", source: "default_port" },
      { port: 7098, claimant: "old-thing", source: "default_port" }
    ]) as Finding[];
    const serveFails = fails(f).filter((x) => x.id.startsWith("serve:"));
    expect(serveFails).toHaveLength(1);
    expect(serveFails[0].detail).toContain("8498");
  });

  it("warns when a live listener's pid disagrees with the status file", () => {
    const f = findPortCollisions(
      [{ port: 8088, claimant: "ports-default", source: "default_port" }],
      [{ port: 8088, pid: 111, command: "java" }],
      [{ fittingId: "ports-default", port: 8088, pid: 222 }]
    ) as Finding[];
    expect(warns(f)).toHaveLength(1);
    expect(warns(f)[0].detail).toContain("111");
  });

  it("passes a clean inventory", () => {
    const f = findPortCollisions([{ port: 8076, claimant: "preflight", source: "default_port" }]) as Finding[];
    expect(f).toHaveLength(1);
    expect(f[0].status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// check 1 — verify results
// ---------------------------------------------------------------------------
describe("assessVerifyResults", () => {
  it("reports EVERY failure, not just the first", () => {
    const f = assessVerifyResults([
      {
        compositionId: "default-2",
        lastUp: {
          ok: false,
          at: "2026-09-01T12:00:00Z",
          verifyResults: [
            { fittingId: "basic-memory", ok: false, exitCode: 1, expect: "ok", command: "probe a", stdout: "", stderr: "missing consumer" },
            { fittingId: "monitor-default", ok: true, exitCode: 0, expect: "ok", command: "probe b", stdout: "ok", stderr: "" },
            { fittingId: "vault-git-sync", ok: false, exitCode: 1, expect: "ok", command: "probe c", stdout: "", stderr: "no git repo" }
          ]
        }
      }
    ]) as Finding[];
    expect(fails(f).map((x) => x.id)).toEqual(["default-2:basic-memory", "default-2:vault-git-sync"]);
    // Every failing verify offers the one safe click: unstation the fitting.
    expect(fails(f)[0].action).toEqual(expect.objectContaining({
      id: "unstation-fitting",
      params: { compositionId: "default-2", fittingId: "basic-memory" }
    }));
  });

  it("warns when there is no last-up record and no runner state", () => {
    const f = assessVerifyResults([{ compositionId: "fresh", lastUp: null, runnerState: null }]) as Finding[];
    expect(warns(f)).toHaveLength(1);
  });

  it("prefers the LIVE runner state — a failed up's results show even with no last-up.json", () => {
    const f = assessVerifyResults([
      {
        compositionId: "default-2",
        lastUp: null, // failed ups never write last-up.json
        runnerState: {
          status: "failed",
          verifyResults: [
            { fittingId: "ok-one", ok: true, exitCode: 0, expect: "ok", command: "a", stdout: "ok", stderr: "" },
            { fittingId: "broken", ok: false, exitCode: 1, expect: "ok", command: "b", stdout: "", stderr: "boom" }
          ]
        }
      }
    ]) as Finding[];
    expect(fails(f).map((x) => x.id)).toEqual(["default-2:broken"]);
    expect(fails(f)[0].detail).toContain("runner status: failed");
    expect(warns(f)).toHaveLength(0);
  });

  it("runner state also wins over a stale last-up.json", () => {
    const f = assessVerifyResults([
      {
        compositionId: "c",
        lastUp: { ok: true, at: "2026-08-01T00:00:00Z", verifyResults: [{ fittingId: "old", ok: true, exitCode: 0, expect: "ok", command: "x", stdout: "ok", stderr: "" }] },
        runnerState: {
          status: "failed",
          verifyResults: [{ fittingId: "new-broken", ok: false, exitCode: 1, expect: "ok", command: "y", stdout: "", stderr: "z" }]
        }
      }
    ]) as Finding[];
    expect(fails(f).map((x) => x.id)).toEqual(["c:new-broken"]);
  });
});

describe("assessSweepResults", () => {
  it("maps live sweep results one-to-one", () => {
    const f = assessSweepResults("default-2", [
      { fittingId: "a", ok: true, durationMs: 5, exitCode: 0, expect: "ok", command: "x", stdout: "ok", stderr: "" },
      { fittingId: "b", ok: false, durationMs: 9, exitCode: 1, expect: "ok", command: "y", stdout: "", stderr: "boom" }
    ]) as Finding[];
    expect(f).toHaveLength(2);
    expect(fails(f)[0].id).toBe("default-2:b");
  });
});

// ---------------------------------------------------------------------------
// check 4 — serve coverage
// ---------------------------------------------------------------------------
describe("serveCoverage", () => {
  it("app mode: fails unmapped views, warns unhealthy mapped ones", () => {
    const f = serveCoverage({
      views: [
        { fittingId: "kanban-loop", port: 8089, tailnetUrl: "https://host:8489", healthy: true },
        { fittingId: "blank-view", port: 8083, tailnetUrl: null, healthy: true },
        { fittingId: "sick-view", port: 8084, tailnetUrl: "https://host:8484", healthy: false }
      ]
    }) as Finding[];
    expect(fails(f).map((x) => x.id)).toEqual(["blank-view"]);
    expect(warns(f).map((x) => x.id)).toEqual(["sick-view"]);
    expect(fails(f)[0].detail).toContain("127.0.0.1");
  });

  it("degraded mode: checks status files against the raw serve map", () => {
    const f = serveCoverage({
      statusFiles: [
        { fittingId: "mapped", port: 8089 },
        { fittingId: "unmapped", port: 8090 }
      ],
      serveMap: { 8089: "https://host:8489" }
    }) as Finding[];
    expect(fails(f).map((x) => x.id)).toEqual(["unmapped"]);
  });
});

// ---------------------------------------------------------------------------
// check 5 — orphans
// ---------------------------------------------------------------------------
describe("classifyOrphans", () => {
  const alive = new Set([100, 200]);
  const isAlive = (pid: number) => alive.has(pid);

  it("warns a status file with a dead pid, fails a live ledgered pid without status", () => {
    const f = classifyOrphans(
      [{ fittingId: "healthy", pid: 100, port: 8088 }, { fittingId: "crashed", pid: 999, port: 8090 }],
      [{ fittingId: "healthy", pid: 100 }, { fittingId: "local-voice", pid: 200 }],
      isAlive
    ) as Finding[];
    expect(warns(f).map((x) => x.id)).toEqual(["crashed"]);
    expect(fails(f).map((x) => x.id)).toEqual(["local-voice"]);
    expect(fails(f)[0].fix).toContain("never kills");
  });

  it("passes a consistent ledger", () => {
    const f = classifyOrphans([{ fittingId: "a", pid: 100, port: 1 }], [{ fittingId: "a", pid: 100 }], isAlive) as Finding[];
    expect(f).toHaveLength(1);
    expect(f[0].status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// check 6 — drift + re-station
// ---------------------------------------------------------------------------
describe("assessDrift", () => {
  const base = {
    compositionId: "default-2",
    lastUp: { at: "2026-09-01T12:00:00Z", ok: true },
    manifestMtimesMs: { "apm.yml": Date.parse("2026-09-01T11:00:00Z"), "local.yml": null, "apm.lock.yaml": null },
    diskSelections: ["a", "b"],
    headSelections: ["a", "b"],
    unfitted: [],
    diffStat: null
  };

  it("passes when everything matches", () => {
    const f = assessDrift(base) as Finding[];
    expect(f).toHaveLength(1);
    expect(f[0].status).toBe("pass");
  });

  it("warns staleness when the manifest is newer than the last up", () => {
    const f = assessDrift({ ...base, manifestMtimesMs: { "apm.yml": Date.parse("2026-09-02T12:00:00Z") } }) as Finding[];
    expect(warns(f).some((x) => x.id === "default-2:stale")).toBe(true);
  });

  it("FAILS the re-station case: on disk, not at HEAD, not unfitted (vault-git-sync)", () => {
    const f = assessDrift({ ...base, diskSelections: ["a", "vault-git-sync"], headSelections: ["a"] }) as Finding[];
    expect(fails(f).map((x) => x.id)).toEqual(["default-2:vault-git-sync"]);
    expect(fails(f)[0].fix).toContain("PUT");
    expect(fails(f)[0].action).toEqual(expect.objectContaining({
      id: "unstation-fitting",
      params: { compositionId: "default-2", fittingId: "vault-git-sync" }
    }));
  });

  it("passes a deliberate unfit (absent from disk AND recorded unfitted)", () => {
    const f = assessDrift({ ...base, diskSelections: ["a"], headSelections: ["a", "gone"], unfitted: ["gone"] }) as Finding[];
    expect(f.filter((x) => x.id.includes("gone"))).toHaveLength(0);
  });

  it("warns a removal WITHOUT an unfitted record (it will come back)", () => {
    const f = assessDrift({ ...base, diskSelections: ["a"], headSelections: ["a", "gone"], unfitted: [] }) as Finding[];
    expect(warns(f).map((x) => x.id)).toEqual(["default-2:gone"]);
  });

  it("warns on no last-up record", () => {
    const f = assessDrift({ ...base, lastUp: null }) as Finding[];
    expect(warns(f).some((x) => x.id === "default-2:no-record")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// check 7 — kinds
// ---------------------------------------------------------------------------
describe("scanKinds", () => {
  it("fails a retired kind, passes current ones", () => {
    const f = scanKinds([
      { id: "old-thing", kinds: ["agent-skill", "vault"] },
      { id: "fine", kinds: ["monitor"] }
    ]) as Finding[];
    expect(fails(f).map((x) => x.id)).toEqual(["old-thing"]);
    expect(fails(f)[0].detail).toContain("agent-skill");
  });
});

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------
describe("summarize", () => {
  it("worst-of ordering and counts", () => {
    const mkf = (status: string) => ({ check: "x", id: "y", status, detail: "" });
    expect(summarize([mkf("pass"), mkf("warn")]).overall).toBe("warn");
    expect(summarize([mkf("warn"), mkf("fail")]).overall).toBe("fail");
    expect(summarize([mkf("pass")]).overall).toBe("pass");
    expect(summarize([mkf("pass"), mkf("fail"), mkf("fail")]).counts).toEqual({ pass: 1, warn: 0, fail: 2 });
  });
});
