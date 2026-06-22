import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// CO6 — wiring. Installing the coord fittings' user-scope config lands the MCP
// servers in ~/.claude.json and the hooks in ~/.claude/settings.json — the SINGLE
// user-scope config a direct `claude` run AND the orchestrator's claude child read.
//
// Codex CO6 hardening: drive the install scripts via HOME (no GARRISON override
// env), so the test asserts the EXACT production paths claude consumes
// ($HOME/.claude.json + $HOME/.claude/settings.json), not an override path.

const SEED = path.resolve(__dirname, "..", "fittings", "seed");
const REPO_ROOT = path.resolve(__dirname, "..");

let home: string; // sandbox HOME — the scripts resolve production paths under it
let settingsPath: string;
let cjPath: string;

function node(script: string, args: string[]): void {
  execFileSync(process.execPath, [script, ...args], {
    // ONLY HOME + GARRISON_HOME — the override paths are deliberately unset so the
    // scripts fall through to the real ~/.claude(.json) layout under HOME.
    env: { ...process.env, HOME: home, GARRISON_HOME: path.join(home, ".garrison"), GARRISON_CLAUDE_SETTINGS_PATH: "", GARRISON_CLAUDE_JSON: "" },
    stdio: "pipe"
  });
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "coord-wiring-"));
  settingsPath = path.join(home, ".claude", "settings.json"); // what `claude` reads
  cjPath = path.join(home, ".claude.json"); // what `claude` reads (sibling)
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("coord wiring — installs to the EXACT user-scope paths claude reads", () => {
  it("registers both MCP servers in $HOME/.claude.json and both hook owners in $HOME/.claude/settings.json", () => {
    node(path.join(SEED, "coord-beads", "scripts", "install-hooks.mjs"), []);
    node(path.join(SEED, "coord-mcp", "scripts", "register-mcp.mjs"), ["add"]);
    node(path.join(SEED, "coord-mcp", "scripts", "install-hook.mjs"), []);
    node(path.join(SEED, "coord-agentmail", "scripts", "register-mcp.mjs"), ["add", "8765"]);

    // Wrote to the production paths claude consumes (NOT an override path).
    expect(existsSync(cjPath)).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);

    const cj = JSON.parse(readFileSync(cjPath, "utf8"));
    expect(cj.mcpServers["coord-mcp"].command).toContain("node");
    expect(cj.mcpServers["coord-agentmail"]).toEqual({ type: "http", url: "http://127.0.0.1:8765/mcp" });

    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const owners = (ev: string) => (settings.hooks[ev] || []).map((g: { _garrison?: string }) => g._garrison);
    expect(owners("SessionStart")).toContain("fitting:coord-beads");
    expect(owners("SessionStart")).toContain("fitting:coord-mcp");
    expect(owners("UserPromptSubmit")).toContain("fitting:coord-mcp");
  });

  it("PTY-SAFE: every coord hook is type 'command' (no agent/prompt model-invoking hooks)", () => {
    node(path.join(SEED, "coord-beads", "scripts", "install-hooks.mjs"), []);
    node(path.join(SEED, "coord-mcp", "scripts", "install-hook.mjs"), []);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    for (const groups of Object.values(settings.hooks) as Array<Array<{ _garrison?: string; hooks?: { type: string; command?: string }[] }>>) {
      for (const g of groups) {
        if (!g._garrison || !String(g._garrison).startsWith("fitting:coord")) continue;
        for (const h of g.hooks || []) {
          expect(h.type).toBe("command");
          expect(h.command || "").not.toMatch(/claude\s+-p\b/);
        }
      }
    }
  });

  it("LICENSE-ISOLATION: the MIT tree never imports/requires mcp_agent_mail", () => {
    // Search only dirs that exist; distinguish grep exit 1 (no match = PASS) from
    // exit >=2 (operational error = FAIL) so an error can never false-pass.
    const dirs = ["src", "fittings", "scripts", "packages"].filter((d) => existsSync(path.join(REPO_ROOT, d)));
    const res = spawnSync("grep", ["-rIn", "-E", "(import|require|from)[^\\n]*mcp_agent_mail", ...dirs], {
      cwd: REPO_ROOT,
      encoding: "utf8"
    });
    if (res.error) throw res.error;
    // grep: 0 = matches found (FAIL), 1 = no match (PASS), >=2 = error (FAIL).
    expect([0, 1]).toContain(res.status);
    expect(res.status, `grep matched an import:\n${res.stdout}`).toBe(1);
  });
});
