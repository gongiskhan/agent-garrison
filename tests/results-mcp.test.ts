import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COORD_OWNERS, reconcileCoordTeardown } from "@/lib/coord-wiring";
import { apiBase, TOOLS } from "../fittings/seed/drill/scripts/results-mcp.mjs";
import { serverEntry, NAME } from "../fittings/seed/drill/scripts/register-results-mcp.mjs";

const REPO = process.cwd();
const DRILL = path.join(REPO, "fittings", "seed", "drill");
const REGISTER = path.join(DRILL, "scripts", "register-results-mcp.mjs");
const SERVER = path.join(DRILL, "scripts", "results-mcp.mjs");

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "garrison-results-mcp-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("the MCP is a wrapper, not a second implementation", () => {
  it("exposes the four reporting tools plus the listing", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      "results_add_step",
      "results_attach_media",
      "results_finalize_run",
      "results_list_runs",
      "results_open_run"
    ]);
  });

  it("requires only name + status on a step - everything else is the session's choice", () => {
    const step = TOOLS.find((t) => t.name === "results_add_step")!;
    expect(step.inputSchema.required).toEqual(["name", "status"]);
    expect(Object.keys(step.inputSchema.properties)).toEqual(
      expect.arrayContaining(["description", "logs", "notes", "tags"])
    );
  });

  it("offers no way to claim `executed` - this server executes nothing", () => {
    const open = TOOLS.find((t) => t.name === "results_open_run")!;
    expect(Object.keys(open.inputSchema.properties)).not.toContain("origin");
    // and the implementation pins it, rather than merely omitting the input
    expect(readFileSync(SERVER, "utf8")).toContain('origin: "reported"');
  });

  it("resolves the API from the baked registration first, then the instance env", () => {
    expect(apiBase({ GARRISON_RESULTS_API: "http://127.0.0.1:7777/", GARRISON_APP_URL: "http://127.0.0.1:8777" })).toBe(
      "http://127.0.0.1:7777"
    );
    expect(apiBase({ GARRISON_APP_URL: "http://127.0.0.1:8777" })).toBe("http://127.0.0.1:8777");
    // Last resort is prod - the always-on instance, the only defensible guess.
    expect(apiBase({})).toBe("http://127.0.0.1:8777");
  });

  it("names no port of its own anywhere else in the file", () => {
    // HARD RULE: a literal port pins one instance and silently answers for the
    // other. The single fallback constant is the only one allowed here.
    const src = readFileSync(SERVER, "utf8");
    const ports = [...src.matchAll(/127\.0\.0\.1:(\d+)/g)].map((m) => m[1]);
    expect(ports).toEqual(["8777"]);
  });
});

describe("registration", () => {
  it("bakes the registering instance's app URL into the server entry", () => {
    const entry = serverEntry({ GARRISON_APP_URL: "http://127.0.0.1:7777" }, "/usr/bin/node", "/x/results-mcp.mjs");
    expect(entry).toEqual({
      command: "/usr/bin/node",
      args: ["/x/results-mcp.mjs"],
      env: { GARRISON_RESULTS_API: "http://127.0.0.1:7777" }
    });
  });

  it("omits the pin entirely when no instance URL is available, rather than baking an empty one", () => {
    expect(serverEntry({}, "/usr/bin/node", "/x/s.mjs").env).toBeUndefined();
  });

  it("adds and removes the server in the profile's own Claude config", () => {
    const cj = path.join(tmp, ".claude.json");
    writeFileSync(cj, JSON.stringify({ mcpServers: { existing: { command: "keep" } }, otherKey: 1 }));
    const env = { ...process.env, GARRISON_CLAUDE_JSON: cj, GARRISON_HOME: tmp, GARRISON_APP_URL: "http://127.0.0.1:7777" };

    execFileSync("node", [REGISTER, "add"], { env, encoding: "utf8" });
    let parsed = JSON.parse(readFileSync(cj, "utf8"));
    expect(parsed.mcpServers[NAME].args[0]).toBe(SERVER);
    expect(parsed.mcpServers[NAME].env.GARRISON_RESULTS_API).toBe("http://127.0.0.1:7777");
    // Never disturbs what was already there.
    expect(parsed.mcpServers.existing).toEqual({ command: "keep" });
    expect(parsed.otherKey).toBe(1);

    execFileSync("node", [REGISTER, "remove"], { env, encoding: "utf8" });
    parsed = JSON.parse(readFileSync(cj, "utf8"));
    expect(parsed.mcpServers[NAME]).toBeUndefined();
    expect(parsed.mcpServers.existing).toEqual({ command: "keep" });
  });

  it("is idempotent - registering twice leaves one entry", () => {
    const cj = path.join(tmp, ".claude.json");
    const env = { ...process.env, GARRISON_CLAUDE_JSON: cj, GARRISON_HOME: tmp };
    execFileSync("node", [REGISTER, "add"], { env, encoding: "utf8" });
    execFileSync("node", [REGISTER, "add"], { env, encoding: "utf8" });
    const parsed = JSON.parse(readFileSync(cj, "utf8"));
    expect(Object.keys(parsed.mcpServers)).toEqual([NAME]);
  });

  it("refuses to clobber a corrupt Claude config", () => {
    const cj = path.join(tmp, ".claude.json");
    writeFileSync(cj, "{ this is not json");
    expect(() =>
      execFileSync("node", [REGISTER, "add"], { env: { ...process.env, GARRISON_CLAUDE_JSON: cj }, stdio: "pipe" })
    ).toThrow();
    expect(readFileSync(cj, "utf8")).toBe("{ this is not json");
  });

  it("snapshots the config once before the first write", () => {
    const cj = path.join(tmp, ".claude.json");
    writeFileSync(cj, JSON.stringify({ mcpServers: {} }));
    execFileSync("node", [REGISTER, "add"], {
      env: { ...process.env, GARRISON_CLAUDE_JSON: cj, GARRISON_HOME: tmp },
      encoding: "utf8"
    });
    expect(existsSync(path.join(tmp, "snapshots", "claude-json.before-drill-results.json"))).toBe(true);
  });

  it("is wired into the drill setup hook, so equipping the fitting is all it takes", () => {
    const setup = readFileSync(path.join(DRILL, "scripts", "setup.sh"), "utf8");
    expect(setup).toContain("register-results-mcp.mjs add");
    // Never fatal: a config this cannot write must not take the fitting down.
    expect(setup).toMatch(/if ! node scripts\/register-results-mcp\.mjs add/);
  });
});

describe("deselecting drill takes the registration away again", () => {
  it("removes drill-results from the Claude config on the next up", () => {
    const cj = path.join(tmp, ".claude.json");
    const settings = path.join(tmp, "settings.json");
    const ledger = path.join(tmp, "coord-lifecycle.json");
    writeFileSync(cj, JSON.stringify({ mcpServers: { "drill-results": { command: "node" }, keep: { command: "x" } } }));
    writeFileSync(settings, JSON.stringify({}));

    // up #1 with drill selected: the ledger records it, nothing is removed.
    const first = reconcileCoordTeardown({
      compositionId: "default",
      selectedFittingIds: ["drill", "kanban-loop"],
      settingsPath: settings,
      claudeJsonPath: cj,
      ledgerPath: ledger
    });
    expect(first.removed).toEqual([]);
    expect(JSON.parse(readFileSync(cj, "utf8")).mcpServers["drill-results"]).toBeDefined();

    // up #2 with drill deselected: the registration goes.
    const second = reconcileCoordTeardown({
      compositionId: "default",
      selectedFittingIds: ["kanban-loop"],
      settingsPath: settings,
      claudeJsonPath: cj,
      ledgerPath: ledger
    });
    expect(second.removed).toEqual(["drill"]);
    expect(second.removedMcp.drill).toEqual(["drill-results"]);
    const parsed = JSON.parse(readFileSync(cj, "utf8"));
    expect(parsed.mcpServers["drill-results"]).toBeUndefined();
    expect(parsed.mcpServers.keep).toEqual({ command: "x" });
  });

  it("registers drill as an owner of standing user-scope config", () => {
    expect(COORD_OWNERS.drill).toEqual({ mcpNames: ["drill-results"] });
  });

  it("survives a corrupt config by retrying on the next up instead of forgetting", () => {
    const cj = path.join(tmp, ".claude.json");
    const ledger = path.join(tmp, "coord-lifecycle.json");
    writeFileSync(cj, "{ corrupt");
    mkdirSync(path.join(tmp, "s"), { recursive: true });
    const settings = path.join(tmp, "s", "settings.json");

    const base = { compositionId: "c", settingsPath: settings, claudeJsonPath: cj, ledgerPath: ledger };
    reconcileCoordTeardown({ ...base, selectedFittingIds: ["drill"] });
    const aborted = reconcileCoordTeardown({ ...base, selectedFittingIds: [] });
    expect(aborted.aborted).toContain("mcp:drill:drill-results");
    expect(readFileSync(cj, "utf8")).toBe("{ corrupt");
    // Retained in the ledger, so the removal is retried once the file is fixed.
    expect(JSON.parse(readFileSync(ledger, "utf8")).c).toEqual(["drill"]);
  });
});
