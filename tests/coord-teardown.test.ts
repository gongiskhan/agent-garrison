import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  reconcileCoordTeardown,
  stripOwnerHookGroups,
  removeMcpByName,
  coordLedgerPath
} from "../src/lib/coord-wiring";

// Garrison-core clean-removal for the coordination fittings (Codex CO1 #1).
// Deselecting a coord fitting strips its owner-tagged hook group(s) + MCP
// registration(s); reconciled on `up`, scoped to known coord owners, never
// clobbering a corrupt live file.

let sb: string;
let settingsPath: string;
let cjPath: string;
let ledgerPath: string;

beforeEach(() => {
  sb = mkdtempSync(path.join(tmpdir(), "coord-teardown-"));
  settingsPath = path.join(sb, "settings.json");
  cjPath = path.join(sb, ".claude.json");
  ledgerPath = path.join(sb, "coord-lifecycle.json");
});
afterEach(() => rmSync(sb, { recursive: true, force: true }));

describe("stripOwnerHookGroups", () => {
  it("removes only the owner's groups and preserves the rest", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { _garrison: "fitting:coord-mcp", matcher: "", hooks: [{ type: "command", command: "x" }] },
            { matcher: "", hooks: [{ type: "command", command: "echo user" }] }
          ]
        }
      })
    );
    const r = stripOwnerHookGroups(settingsPath, "fitting:coord-mcp");
    expect(r).toEqual({ removed: 1, aborted: false });
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe("echo user");
  });

  it("aborts without writing on a corrupt file", () => {
    const corrupt = "{ not json ";
    writeFileSync(settingsPath, corrupt);
    const r = stripOwnerHookGroups(settingsPath, "fitting:coord-mcp");
    expect(r.aborted).toBe(true);
    expect(readFileSync(settingsPath, "utf8")).toBe(corrupt);
  });

  it("is a no-op when the file is absent", () => {
    const r = stripOwnerHookGroups(path.join(sb, "nope.json"), "fitting:coord-mcp");
    expect(r).toEqual({ removed: 0, aborted: false });
  });
});

describe("removeMcpByName", () => {
  it("removes the named server and preserves others", () => {
    writeFileSync(
      cjPath,
      JSON.stringify({ mcpServers: { "coord-agentmail": { type: "http", url: "x" }, other: { command: "y" } } })
    );
    const r = removeMcpByName(cjPath, "coord-agentmail");
    expect(r).toEqual({ removed: true, aborted: false });
    const cj = JSON.parse(readFileSync(cjPath, "utf8"));
    expect(cj.mcpServers["coord-agentmail"]).toBeUndefined();
    expect(cj.mcpServers.other).toBeDefined();
  });

  it("aborts without writing on a corrupt file", () => {
    const corrupt = "{ broken";
    writeFileSync(cjPath, corrupt);
    expect(removeMcpByName(cjPath, "coord-agentmail").aborted).toBe(true);
    expect(readFileSync(cjPath, "utf8")).toBe(corrupt);
  });
});

describe("reconcileCoordTeardown", () => {
  function seedLive() {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ _garrison: "fitting:coord-mcp", matcher: "", hooks: [{ type: "command", command: "x" }] }]
        }
      })
    );
    writeFileSync(cjPath, JSON.stringify({ mcpServers: { "coord-agentmail": { type: "http", url: "x" } } }));
  }

  it("tears down a deselected coord fitting; preserves a still-selected one", () => {
    seedLive();
    // Last time both were selected.
    writeFileSync(ledgerPath, JSON.stringify({ comp: ["coord-mcp", "coord-agentmail"] }));
    // Now only coord-mcp is selected → agentmail must be torn down.
    const res = reconcileCoordTeardown({
      compositionId: "comp",
      selectedFittingIds: ["coord-mcp", "some-other-fitting"],
      settingsPath,
      claudeJsonPath: cjPath,
      ledgerPath
    });
    expect(res.removed).toEqual(["coord-agentmail"]);
    expect(res.removedMcp["coord-agentmail"]).toEqual(["coord-agentmail"]);
    // coord-mcp hook still present (still selected).
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(s.hooks.SessionStart).toHaveLength(1);
    // agentmail MCP gone.
    const cj = JSON.parse(readFileSync(cjPath, "utf8"));
    expect(cj.mcpServers["coord-agentmail"]).toBeUndefined();
    // ledger now records only the selected coord fitting.
    expect(JSON.parse(readFileSync(ledgerPath, "utf8")).comp).toEqual(["coord-mcp"]);
  });

  it("tears down coord-mcp hook when it is deselected", () => {
    seedLive();
    writeFileSync(ledgerPath, JSON.stringify({ comp: ["coord-mcp"] }));
    const res = reconcileCoordTeardown({
      compositionId: "comp",
      selectedFittingIds: [],
      settingsPath,
      claudeJsonPath: cjPath,
      ledgerPath
    });
    expect(res.removed).toEqual(["coord-mcp"]);
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect((s.hooks?.SessionStart ?? []).length).toBe(0);
  });

  it("is idempotent — a second reconcile with the same selection removes nothing", () => {
    seedLive();
    writeFileSync(ledgerPath, JSON.stringify({ comp: ["coord-mcp", "coord-agentmail"] }));
    reconcileCoordTeardown({ compositionId: "comp", selectedFittingIds: ["coord-mcp"], settingsPath, claudeJsonPath: cjPath, ledgerPath });
    const res2 = reconcileCoordTeardown({ compositionId: "comp", selectedFittingIds: ["coord-mcp"], settingsPath, claudeJsonPath: cjPath, ledgerPath });
    expect(res2.removed).toEqual([]);
  });

  it("ignores non-coord fittings entirely", () => {
    writeFileSync(ledgerPath, JSON.stringify({ comp: [] }));
    const res = reconcileCoordTeardown({
      compositionId: "comp",
      selectedFittingIds: ["dev-env", "monitor-default"],
      settingsPath,
      claudeJsonPath: cjPath,
      ledgerPath
    });
    expect(res.removed).toEqual([]);
    // ledger records no coord fittings (the non-coord ids are filtered out).
    expect(JSON.parse(readFileSync(ledgerPath, "utf8")).comp).toEqual([]);
  });

  it("retries cleanup on the next up when a corrupt live file aborted it (no silent permanent install)", () => {
    // coord-mcp was selected last time; now deselected — but settings.json is corrupt.
    const corrupt = "{ corrupt settings ";
    writeFileSync(settingsPath, corrupt);
    writeFileSync(cjPath, JSON.stringify({ mcpServers: {} }));
    writeFileSync(ledgerPath, JSON.stringify({ comp: ["coord-mcp"] }));

    const res1 = reconcileCoordTeardown({
      compositionId: "comp",
      selectedFittingIds: [],
      settingsPath,
      claudeJsonPath: cjPath,
      ledgerPath
    });
    expect(res1.aborted).toContain("hooks:coord-mcp");
    expect(readFileSync(settingsPath, "utf8")).toBe(corrupt); // never clobbered
    // CRITICAL: the fitting is RETAINED in the ledger for retry (not dropped).
    expect(JSON.parse(readFileSync(ledgerPath, "utf8")).comp).toContain("coord-mcp");

    // Repair the file (now it has the owner-tagged group) and re-run: cleanup succeeds.
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: { SessionStart: [{ _garrison: "fitting:coord-mcp", matcher: "", hooks: [{ type: "command", command: "x" }] }] }
      })
    );
    const res2 = reconcileCoordTeardown({
      compositionId: "comp",
      selectedFittingIds: [],
      settingsPath,
      claudeJsonPath: cjPath,
      ledgerPath
    });
    expect(res2.removed).toContain("coord-mcp");
    expect(res2.aborted).toEqual([]);
    expect((JSON.parse(readFileSync(settingsPath, "utf8")).hooks?.SessionStart ?? []).length).toBe(0);
    // now fully cleaned → dropped from the ledger.
    expect(JSON.parse(readFileSync(ledgerPath, "utf8")).comp).toEqual([]);
  });

  it("uses the default ledger path when none is given", () => {
    expect(coordLedgerPath()).toContain("coord-lifecycle.json");
  });
});
