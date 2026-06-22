import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readClaudeJson, userMcpServerNames } from "@/lib/claude-json";
import { readMcpServerNames } from "@/lib/claude-scan";

// HV2 — MCP source-of-truth. Claude Code reads user-scope MCP servers from
// ~/.claude.json (a sibling of ~/.claude), NOT the empty ~/.claude/mcp.json the
// old code read. Sandbox layout mirrors production: <root>/.claude (the home)
// and <root>/.claude.json (its sibling), so claudeJsonPath() derives correctly
// from GARRISON_CLAUDE_HOME with no extra override.

let sandbox: string;
let claudeRoot: string;
let claudeJson: string;
let priorHome: string | undefined;
let priorClaude: string | undefined;
let priorJson: string | undefined;

function write(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

beforeEach(() => {
  priorHome = process.env.GARRISON_HOME;
  priorClaude = process.env.GARRISON_CLAUDE_HOME;
  priorJson = process.env.GARRISON_CLAUDE_JSON;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "gar-cj-"));
  claudeRoot = path.join(sandbox, ".claude");
  claudeJson = path.join(sandbox, ".claude.json");
  fs.mkdirSync(claudeRoot, { recursive: true });
  process.env.GARRISON_HOME = path.join(sandbox, ".garrison");
  process.env.GARRISON_CLAUDE_HOME = claudeRoot;
  delete process.env.GARRISON_CLAUDE_JSON; // exercise the sibling derivation
});

afterEach(() => {
  for (const [k, v] of [
    ["GARRISON_HOME", priorHome],
    ["GARRISON_CLAUDE_HOME", priorClaude],
    ["GARRISON_CLAUDE_JSON", priorJson]
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("claude-json reader", () => {
  it("extracts the user-scope mcpServers subtree and preserves all sibling keys", async () => {
    write(
      claudeJson,
      JSON.stringify({
        oauthAccount: { id: "keep-me" },
        projects: { "/x": { mcpServers: { projectScoped: {} } } },
        mcpServers: { serena: { command: "serena" }, render: { url: "https://r" } }
      })
    );
    const { raw, mcpServers } = await readClaudeJson();
    expect(Object.keys(mcpServers).sort()).toEqual(["render", "serena"]);
    // sibling keys survive a read (write-back in HV6 preserves them)
    expect(raw.oauthAccount).toEqual({ id: "keep-me" });
    expect((raw.projects as Record<string, unknown>)["/x"]).toBeTruthy();
    expect(await userMcpServerNames()).toEqual(["render", "serena"]);
  });

  it("degrades to zero servers (never throws) on a missing or malformed file", async () => {
    expect(await userMcpServerNames()).toEqual([]); // file absent
    write(claudeJson, "{ not json");
    const { mcpServers } = await readClaudeJson();
    expect(mcpServers).toEqual({});
  });
});

describe("readMcpServerNames source-of-truth (HV2)", () => {
  it("reads live servers from ~/.claude.json (the bug: it was reading the empty mcp.json)", async () => {
    // The real-world shape: mcp.json is empty, the servers live in claude.json.
    write(path.join(claudeRoot, "mcp.json"), JSON.stringify({ mcpServers: {} }));
    write(claudeJson, JSON.stringify({ mcpServers: { serena: {}, render: {}, codegraph: {} } }));
    expect(await readMcpServerNames()).toEqual(["codegraph", "render", "serena"]);
  });

  it("claude.json wins precedence — a stale/empty mcp.json can never shadow a live server", async () => {
    // claude.json has the live server; mcp.json is empty (the real machine's state).
    write(path.join(claudeRoot, "mcp.json"), JSON.stringify({ mcpServers: {} }));
    write(claudeJson, JSON.stringify({ mcpServers: { serena: { command: "serena" } } }));
    expect(await readMcpServerNames()).toContain("serena");
  });

  it("ignores the legacy mcp.json ENTIRELY when claude.json is present (authoritative)", async () => {
    write(path.join(claudeRoot, "mcp.json"), JSON.stringify({ mcpServers: { legacyOnly: {} } }));
    write(claudeJson, JSON.stringify({ mcpServers: { serena: {} } }));
    // legacyOnly is NOT resurrected — Claude Code never reads mcp.json, so a
    // stale entry there is not a live server.
    expect(await readMcpServerNames()).toEqual(["serena"]);
  });

  it("falls back to legacy mcp.json ONLY when claude.json is absent/unreadable", async () => {
    write(path.join(claudeRoot, "mcp.json"), JSON.stringify({ mcpServers: { legacyOnly: {} } }));
    // no claude.json on disk → migration fallback
    expect(await readMcpServerNames()).toEqual(["legacyOnly"]);
  });
});
