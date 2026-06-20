import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeStateModel, type PrimitiveRecord } from "@/lib/primitive-state";

// HV3 — the presence axis + active ∪ parked union. A disabled mcp/hook is
// physically removed from the live config, so the model must ALSO read the
// parked store and surface those as presence:"parked" — otherwise the
// disable→enable loop is impossible from the UI. Sandbox: <root>/.claude (home)
// + <root>/.claude.json (real MCP source) + <root>/.garrison/parked (parked store).

let sandbox: string;
let claudeRoot: string;
let garrisonRoot: string;
let prior: Record<string, string | undefined> = {};

function write(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
function byId(records: PrimitiveRecord[], id: string): PrimitiveRecord | undefined {
  return records.find((r) => r.id === id);
}

beforeEach(() => {
  prior = {
    GARRISON_HOME: process.env.GARRISON_HOME,
    GARRISON_CLAUDE_HOME: process.env.GARRISON_CLAUDE_HOME,
    GARRISON_CLAUDE_JSON: process.env.GARRISON_CLAUDE_JSON
  };
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "gar-presence-"));
  claudeRoot = path.join(sandbox, ".claude");
  garrisonRoot = path.join(sandbox, ".garrison");
  fs.mkdirSync(claudeRoot, { recursive: true });
  process.env.GARRISON_HOME = garrisonRoot;
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

describe("presence model (HV3)", () => {
  it("surfaces active ∪ parked for mcp + hooks, plugin presence, and apm-managed files", async () => {
    // --- mcp: one active (claude.json), one parked (~/.garrison/parked/mcp.json)
    write(path.join(sandbox, ".claude.json"), JSON.stringify({ mcpServers: { activeMcp: { command: "x" } } }));
    write(path.join(garrisonRoot, "parked", "mcp.json"), JSON.stringify({ parkedMcp: { command: "y" } }));

    // --- hooks: one active (settings.json) + one parked (parked/hooks.json); + a disabled plugin
    write(
      path.join(claudeRoot, "settings.json"),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo active-hook" }] }] },
        enabledPlugins: { "disabled@mkt": false }
      })
    );
    write(
      path.join(garrisonRoot, "parked", "hooks.json"),
      JSON.stringify([{ event: "Stop", group: { hooks: [{ type: "command", command: "echo parked-hook" }] } }])
    );

    // --- plugins: one disabled (enabledPlugins false above), one enabled (absent key)
    write(
      path.join(claudeRoot, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "enabled@mkt": [{ scope: "user", version: "1.0.0" }],
          "disabled@mkt": [{ scope: "user", version: "2.0.0" }]
        }
      })
    );

    // --- a loose skill (APM-managed surface, presence N/A)
    write(path.join(claudeRoot, "skills", "foo", "SKILL.md"), "---\nname: foo\n---\n");

    const model = await computeStateModel();
    const r = model.records;

    // mcp: active enabled, parked parked
    expect(byId(r, "mcp:activeMcp")?.presence).toBe("enabled");
    expect(byId(r, "mcp:activeMcp")?.managedBy).toBe("presence");
    expect(byId(r, "mcp:parkedMcp")?.presence).toBe("parked");

    // hooks: active enabled, parked parked (parked id is event#parked<idx>)
    expect(byId(r, "hook:SessionStart#0")?.presence).toBe("enabled");
    expect(byId(r, "hook:Stop#parked0")?.presence).toBe("parked");
    expect(byId(r, "hook:Stop#parked0")?.preview).toBe("echo parked-hook");

    // plugins: disabled -> parked, enabled (absent key) -> enabled
    expect(byId(r, "plugin:disabled@mkt")?.presence).toBe("parked");
    expect(byId(r, "plugin:enabled@mkt")?.presence).toBe("enabled");

    // file surface: apm-managed, no presence
    expect(byId(r, "skill:foo")?.managedBy).toBe("apm");
    expect(byId(r, "skill:foo")?.presence).toBeUndefined();

    // The presence-parked count is real (mcp + hook + plugin = 3)…
    expect(r.filter((x) => x.presence === "parked").length).toBe(3);
    // …while the state-axis `parked` count stays 0 (no off-disk fitting leak; D10).
    expect(model.counts.parked).toBe(0);
  });

  it("does not double-list a server present in BOTH active and parked (active wins)", async () => {
    write(path.join(sandbox, ".claude.json"), JSON.stringify({ mcpServers: { dup: {} } }));
    write(path.join(garrisonRoot, "parked", "mcp.json"), JSON.stringify({ dup: {} }));
    const model = await computeStateModel();
    const dups = model.records.filter((x) => x.id === "mcp:dup");
    expect(dups.length).toBe(1);
    expect(dups[0].presence).toBe("enabled"); // active wins
  });
});
