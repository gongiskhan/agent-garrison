import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeStateModel, type PrimitiveRecord } from "@/lib/primitive-state";
import { disablePlugin, enablePlugin } from "@/lib/plugin-disable";
import { disableHookGroup, enableHookGroup, purgeParkedHooksForOwner } from "@/lib/hooks-disable";
import { disableMcpServer, enableMcpServer, addUserMcpServer } from "@/lib/mcp-user";
import { applyMcpDelta, McpWriteRaceError } from "@/lib/claude-json";
import { readParkedMcp, readParkedHooks } from "@/lib/parked-config";
import { reconcile } from "@/lib/reconcile";

// HV4/5/6/7 — enable/disable = a real PARK move, round-trippable from the UI.

let sandbox: string;
let claudeRoot: string;
let claudeJson: string;
let prior: Record<string, string | undefined> = {};

function write(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function byId(r: PrimitiveRecord[], id: string): PrimitiveRecord | undefined {
  return r.find((x) => x.id === id);
}

beforeEach(() => {
  prior = {
    GARRISON_HOME: process.env.GARRISON_HOME,
    GARRISON_CLAUDE_HOME: process.env.GARRISON_CLAUDE_HOME,
    GARRISON_CLAUDE_JSON: process.env.GARRISON_CLAUDE_JSON
  };
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "gar-disable-"));
  claudeRoot = path.join(sandbox, ".claude");
  claudeJson = path.join(sandbox, ".claude.json");
  fs.mkdirSync(claudeRoot, { recursive: true });
  process.env.GARRISON_HOME = path.join(sandbox, ".garrison");
  process.env.GARRISON_CLAUDE_HOME = claudeRoot;
  delete process.env.GARRISON_CLAUDE_JSON;
});

afterEach(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("plugin enable/disable (HV4) — native enabledPlugins lever", () => {
  it("disable sets false, enable deletes the key; the record flips parked<->enabled", async () => {
    write(
      path.join(claudeRoot, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "p@mkt": [{ scope: "user", version: "1.0.0" }] } })
    );
    write(path.join(claudeRoot, "settings.json"), JSON.stringify({}));

    expect((await disablePlugin("p@mkt")).ok).toBe(true);
    expect(readJson(path.join(claudeRoot, "settings.json")).enabledPlugins["p@mkt"]).toBe(false);
    expect(byId((await computeStateModel()).records, "plugin:p@mkt")?.presence).toBe("parked");

    expect((await enablePlugin("p@mkt")).ok).toBe(true);
    expect("p@mkt" in (readJson(path.join(claudeRoot, "settings.json")).enabledPlugins ?? {})).toBe(false);
    expect(byId((await computeStateModel()).records, "plugin:p@mkt")?.presence).toBe("enabled");
  });

  it("refuses to disable a plugin that is not installed", async () => {
    write(path.join(claudeRoot, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {} }));
    expect((await disablePlugin("ghost@mkt")).code).toBe("not-found");
  });
});

describe("hook group enable/disable (HV5) — park to ~/.garrison/parked/hooks.json", () => {
  it("round-trips a group verbatim (incl _garrison tag) between settings and the parked store", async () => {
    const owned = { _garrison: "fitting:x", matcher: "*", hooks: [{ type: "command", command: "echo owned" }] };
    write(path.join(claudeRoot, "settings.json"), JSON.stringify({ hooks: { Stop: [owned] } }));

    expect((await disableHookGroup("Stop", 0)).ok).toBe(true);
    // gone from settings, parked verbatim
    expect(readJson(path.join(claudeRoot, "settings.json")).hooks.Stop).toEqual([]);
    const parked = await readParkedHooks();
    expect(parked).toHaveLength(1);
    expect(parked[0]).toEqual({ event: "Stop", group: owned });
    expect(byId((await computeStateModel()).records, "hook:Stop#parked0")?.presence).toBe("parked");

    // enable restores it UNCHANGED (tag preserved) and clears the parked store
    expect((await enableHookGroup(0)).ok).toBe(true);
    expect(readJson(path.join(claudeRoot, "settings.json")).hooks.Stop).toEqual([owned]);
    expect(await readParkedHooks()).toEqual([]);
  });

  it("uninstall purge drops only the parked groups owned by the fitting", async () => {
    write(path.join(claudeRoot, "settings.json"), JSON.stringify({}));
    fs.mkdirSync(path.join(sandbox, ".garrison", "parked"), { recursive: true });
    write(
      path.join(sandbox, ".garrison", "parked", "hooks.json"),
      JSON.stringify([
        { event: "Stop", group: { _garrison: "fitting:x", hooks: [] } },
        { event: "Stop", group: { hooks: [{ type: "command", command: "hand" }] } }
      ])
    );
    expect(await purgeParkedHooksForOwner("fitting:x")).toBe(1);
    const left = await readParkedHooks();
    expect(left).toHaveLength(1);
    expect(left[0].group._garrison).toBeUndefined();
  });
});

describe("mcp enable/disable (HV6) — guarded ~/.claude.json writes", () => {
  it("disable parks the server and preserves every sibling key byte-for-value; enable reverses", async () => {
    write(
      claudeJson,
      JSON.stringify({
        oauthAccount: { id: "keep" },
        projects: { "/a": { mcpServers: { projScoped: {} } } },
        mcpServers: { serena: { command: "serena" }, render: { url: "https://r" } }
      })
    );

    expect((await disableMcpServer("serena")).ok).toBe(true);
    const after = readJson(claudeJson);
    expect("serena" in after.mcpServers).toBe(false); // gone from live
    expect(after.mcpServers.render).toEqual({ url: "https://r" }); // other server intact
    expect(after.oauthAccount).toEqual({ id: "keep" }); // siblings preserved
    expect(after.projects).toEqual({ "/a": { mcpServers: { projScoped: {} } } });
    expect((await readParkedMcp()).serena).toEqual({ command: "serena" }); // parked verbatim

    const recs = (await computeStateModel()).records;
    expect(byId(recs, "mcp:serena")?.presence).toBe("parked");
    expect(byId(recs, "mcp:render")?.presence).toBe("enabled");

    expect((await enableMcpServer("serena")).ok).toBe(true);
    expect(readJson(claudeJson).mcpServers.serena).toEqual({ command: "serena" });
    expect("serena" in (await readParkedMcp())).toBe(false);
  });

  it("retries (not reverts) when a concurrent write lands mid-flight — the concurrent change survives", async () => {
    write(claudeJson, JSON.stringify({ mcpServers: { keep: {} } }));
    // A concurrent Claude write lands ONCE (attempt 1), adding `concurrent`.
    await applyMcpDelta(
      { op: "remove", name: "keep" },
      {
        file: claudeJson,
        beforeWrite: (attempt) => {
          if (attempt === 1) fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { keep: {}, concurrent: { x: 1 } } }));
        }
      }
    );
    const after = readJson(claudeJson);
    expect("keep" in after.mcpServers).toBe(false); // our delta applied
    expect(after.mcpServers.concurrent).toEqual({ x: 1 }); // concurrent change NOT clobbered
  });

  it("aborts leaving the live file UNTOUCHED when the race never settles", async () => {
    write(claudeJson, JSON.stringify({ mcpServers: { keep: {} } }));
    let threw: unknown;
    try {
      await applyMcpDelta(
        { op: "remove", name: "keep" },
        {
          file: claudeJson,
          maxAttempts: 3,
          // A different concurrent write EVERY attempt → CAS never settles.
          beforeWrite: (attempt) => fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { keep: {}, [`c${attempt}`]: {} } }))
        }
      );
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(McpWriteRaceError);
    const after = readJson(claudeJson);
    expect("keep" in after.mcpServers).toBe(true); // our "remove keep" was NOT forced on top
    expect("c3" in after.mcpServers).toBe(true); // file is exactly the last concurrent write
  });

  it("REFUSES to overwrite an unparseable ~/.claude.json (protects the 731KB shared file)", async () => {
    const corrupt = '{ "mcpServers": { "keep": {} '; // truncated / invalid JSON
    fs.writeFileSync(claudeJson, corrupt);
    const res = await addUserMcpServer("new", { command: "x" });
    expect(res.ok).toBe(false);
    // the corrupt file is left EXACTLY as-is — not clobbered with `{mcpServers}`
    expect(fs.readFileSync(claudeJson, "utf8")).toBe(corrupt);
  });
});

describe("reconcile adopt (HV7) — present presence-managed surfaces, parking nothing", () => {
  it("adopts manually-placed mcp/hook/plugin as enabled and leaves the parked store empty on bootstrap", async () => {
    // manually placed, no Garrison install:
    write(claudeJson, JSON.stringify({ mcpServers: { manualMcp: {} } }));
    write(path.join(claudeRoot, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "hand" }] }] } }));
    write(
      path.join(claudeRoot, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "p@mkt": [{ scope: "user", version: "1" }] } })
    );

    const report = await reconcile({ trigger: "bootstrap" });
    expect(report.adopted).toContain("mcp:manualMcp");
    expect(report.adopted).toContain("hook:Stop#0");
    expect(report.adopted).toContain("plugin:p@mkt");

    // bootstrap parks NOTHING
    expect(await readParkedMcp()).toEqual({});
    expect(await readParkedHooks()).toEqual([]);

    // and the manually-placed server shows as an enabled record with no install
    expect((await computeStateModel()).records.find((r) => r.id === "mcp:manualMcp")?.presence).toBe("enabled");
  });
});
