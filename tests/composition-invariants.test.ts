import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkCompositionInvariants } from "@/lib/composition-invariants";
import { disableMcpServer } from "@/lib/mcp-user";
import { reconcile } from "@/lib/reconcile";
import { readParkedMcp, readParkedHooks } from "@/lib/parked-config";
import { parseGarrisonMetadata } from "@/lib/metadata";

// HV9 — the cross-cutting invariants.

let sandbox: string;
let claudeRoot: string;
let claudeJson: string;
let prior: Record<string, string | undefined> = {};

function write(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// recursive { relpath -> sha256 } snapshot, for the write-blast-radius check
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else out[path.relative(root, abs)] = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}
function changedPaths(before: Record<string, string>, after: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => before[k] !== after[k]).sort();
}

beforeEach(() => {
  prior = {
    GARRISON_HOME: process.env.GARRISON_HOME,
    GARRISON_CLAUDE_HOME: process.env.GARRISON_CLAUDE_HOME,
    GARRISON_CLAUDE_JSON: process.env.GARRISON_CLAUDE_JSON
  };
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "gar-inv-"));
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

describe("composition invariants (HV9)", () => {
  it("XOR: a clean disabled state has no violation; a server in BOTH active and parked is flagged", async () => {
    write(claudeJson, JSON.stringify({ mcpServers: { serena: {} } }));
    await disableMcpServer("serena"); // moves serena active -> parked
    expect(await checkCompositionInvariants()).toEqual([]); // exactly one place: clean

    // Force drift: serena back in the active file while still parked.
    write(claudeJson, JSON.stringify({ mcpServers: { serena: {} } }));
    const v = await checkCompositionInvariants();
    expect(v.map((x) => x.invariant)).toContain("mcp-xor");
  });

  it("a fresh bootstrap parks NOTHING", async () => {
    write(claudeJson, JSON.stringify({ mcpServers: { live: {} } }));
    write(path.join(claudeRoot, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [] }] } }));
    await reconcile({ trigger: "bootstrap" });
    expect(await readParkedMcp()).toEqual({});
    expect(await readParkedHooks()).toEqual([]);
  });

  it("empty contracts are accepted for a presence-managed fitting", () => {
    const md = parseGarrisonMetadata({
      faculty: "memory",
      cardinality_hint: "single",
      component_shape: "skill",
      platforms: ["claude-code"],
      provides: [],
      consumes: [],
      verify: { command: "echo ok", expect: "ok" }
    });
    expect(md.provides).toEqual([]);
    expect(md.consumes).toEqual([]);
  });

  it("a presence write is confined to managed locations (disableMcpServer touches only claude.json + parked/mcp.json)", async () => {
    write(claudeJson, JSON.stringify({ mcpServers: { serena: {} } }));
    write(path.join(claudeRoot, "settings.json"), JSON.stringify({ theme: "dark" }));
    write(path.join(claudeRoot, "skills", "foo", "SKILL.md"), "---\nname: foo\n---\n");

    const before = snapshot(sandbox);
    await disableMcpServer("serena");
    const after = snapshot(sandbox);

    const changed = changedPaths(before, after);
    const allowed = [".claude.json", path.join(".garrison", "parked", "mcp.json")];
    for (const c of changed) {
      expect(allowed, `unexpected write to ${c}`).toContain(c);
    }
    // settings.json and the skill were NOT touched
    expect(changed).not.toContain(path.join(".claude", "settings.json"));
    expect(changed).not.toContain(path.join(".claude", "skills", "foo", "SKILL.md"));
  });
});
