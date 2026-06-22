import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// CO4 — the coord-mcp digest/nudge command hook + its installer.

const FITTING = path.resolve(__dirname, "..", "fittings", "seed", "coord-mcp");
const HOOK = path.join(FITTING, "scripts", "coord-hook.mjs");
const INSTALL = path.join(FITTING, "scripts", "install-hook.mjs");
const SERVER = path.join(FITTING, "scripts", "server.mjs");
const OWNER = "fitting:coord-mcp";

let sb: string;
let settingsPath: string;

function runHook(payload: object, env: Record<string, string> = {}): string {
  return execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, GARRISON_HOME: sb, ...env },
    encoding: "utf8"
  });
}
function declareIntentVia(session: string, repo: string, area: string, reason: string): void {
  // Drive the server's declare_intent so an intent exists for the digest to surface.
  const req = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "declare_intent", arguments: { repo, area, reason } } });
  execFileSync(process.execPath, [SERVER], { input: req + "\n", env: { ...process.env, GARRISON_HOME: sb, COORD_SESSION: session }, encoding: "utf8" });
}

beforeEach(() => {
  sb = mkdtempSync(path.join(tmpdir(), "coord-hook-"));
  settingsPath = path.join(sb, "settings.json");
});
afterEach(() => rmSync(sb, { recursive: true, force: true }));

describe("coord-hook (digest/nudge command hook)", () => {
  it("emits the begin_planning nudge as SessionStart additionalContext + writes a heartbeat line", () => {
    const out = runHook({ hook_event_name: "SessionStart", session_id: "S1", cwd: "/tmp/some-repo" });
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("begin_planning");
    // heartbeat line written (observability layer 3).
    const log = readFileSync(path.join(sb, "coord", "heartbeat.log"), "utf8").trim().split("\n");
    expect(log.length).toBeGreaterThanOrEqual(1);
    const last = JSON.parse(log[log.length - 1]);
    expect(last.session).toBe("S1");
    expect(typeof last.digestBytes).toBe("number");
  });

  it("surfaces a conflicting intent from another session on UserPromptSubmit (write->detect->inject)", () => {
    const repo = "/tmp/conflict-repo";
    declareIntentVia("OTHER", repo, "src/lib/runner.ts", "rewiring up()");
    const out = runHook({ hook_event_name: "UserPromptSubmit", session_id: "ME", cwd: repo, prompt: "let me change src/lib/runner.ts" });
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("OTHER");
    expect(ctx).toContain("rewiring up()");
  });

  it("fails open (empty context, exit 0) on a malformed payload", () => {
    const out = execFileSync(process.execPath, [HOOK], { input: "{ not json", env: { ...process.env, GARRISON_HOME: sb }, encoding: "utf8" });
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.additionalContext).toBeDefined(); // emitted, did not crash
  });
});

describe("coord-mcp install-hook", () => {
  function read() {
    return JSON.parse(readFileSync(settingsPath, "utf8"));
  }
  function run(): void {
    execFileSync(process.execPath, [INSTALL], { env: { ...process.env, GARRISON_HOME: sb, GARRISON_CLAUDE_SETTINGS_PATH: settingsPath }, stdio: "pipe" });
  }

  it("installs owner-tagged SessionStart + UserPromptSubmit groups, idempotently", () => {
    run();
    run();
    const s = read();
    const own = (ev: string) => (s.hooks[ev] || []).filter((g: { _garrison?: string }) => g._garrison === OWNER);
    expect(own("SessionStart")).toHaveLength(1);
    expect(own("UserPromptSubmit")).toHaveLength(1);
    expect(own("SessionStart")[0].hooks[0].command).toContain("coord-hook.mjs");
    expect(own("SessionStart")[0].hooks[0].command).toContain("|| true");
  });

  it("preserves unrelated hooks and never clobbers a corrupt settings.json", () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "echo user" }] }] } }));
    run();
    const s = read();
    expect(s.hooks.SessionStart.some((g: { hooks?: { command: string }[] }) => g.hooks?.[0]?.command === "echo user")).toBe(true);

    const corrupt = "{ broken";
    writeFileSync(settingsPath, corrupt);
    expect(() => run()).toThrow();
    expect(readFileSync(settingsPath, "utf8")).toBe(corrupt);
  });
});
