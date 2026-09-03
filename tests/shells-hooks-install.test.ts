// The shells hook installer: merges (never replaces) the agent lifecycle
// hook into Cursor/Codex/Gemini's own config files, idempotent, preserving
// unrelated entries, snapshotting once, and uninstallable.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs
import { installHooks } from "../fittings/seed/remote-shell-runtime/scripts/install-hooks.mjs";
// @ts-ignore — pure .mjs
import { uninstallHooks } from "../fittings/seed/remote-shell-runtime/scripts/uninstall-hooks.mjs";

let sandbox: string;
let env: NodeJS.ProcessEnv;

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8"));
}

beforeEach(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), "shells-hooks-"));
  env = {
    ...process.env,
    HOME: sandbox,
    GARRISON_HOME: path.join(sandbox, "garrison"),
    GARRISON_CURSOR_HOME: path.join(sandbox, "cursor-home"),
    CODEX_HOME: path.join(sandbox, "codex-home"),
    GEMINI_CLI_HOME: path.join(sandbox, "gemini-home")
  } as NodeJS.ProcessEnv;
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("install-hooks.mjs", () => {
  it("skips a home that does not exist on this box", () => {
    // None of the three homes exist yet - installer must not create them.
    const result = installHooks(env, () => {});
    expect(result.skipped).toBe(false);
    expect(() => readJson(path.join(env.GARRISON_CURSOR_HOME!, "hooks.json"))).toThrow();
  });

  it("cursor: preserves a pre-existing entry and version, adds exactly the two hook commands, idempotent", () => {
    mkdirSync(env.GARRISON_CURSOR_HOME!, { recursive: true });
    writeFileSync(
      path.join(env.GARRISON_CURSOR_HOME!, "hooks.json"),
      JSON.stringify({ version: 1, hooks: { stop: [{ command: "echo user-defined" }] } })
    );

    installHooks(env, () => {});
    const first = readJson(path.join(env.GARRISON_CURSOR_HOME!, "hooks.json")) as {
      version: number;
      hooks: { stop: Array<{ command: string }>; beforeSubmitPrompt: Array<{ command: string }> };
    };
    expect(first.version).toBe(1);
    expect(first.hooks.stop.map((h) => h.command)).toEqual(["echo user-defined", expect.stringContaining("agent-stop cursor")]);
    expect(first.hooks.beforeSubmitPrompt.map((h) => h.command)).toEqual([expect.stringContaining("agent-start cursor")]);

    installHooks(env, () => {}); // idempotent
    const second = readJson(path.join(env.GARRISON_CURSOR_HOME!, "hooks.json")) as {
      hooks: { stop: unknown[]; beforeSubmitPrompt: unknown[] };
    };
    expect(second.hooks.stop).toHaveLength(2);
    expect(second.hooks.beforeSubmitPrompt).toHaveLength(1);
  });

  it("codex: adds the four Claude-shaped hook groups without touching config.toml", () => {
    mkdirSync(env.CODEX_HOME!, { recursive: true });
    writeFileSync(path.join(env.CODEX_HOME!, "config.toml"), "# untouched\n");
    installHooks(env, () => {});
    const cfg = readJson(path.join(env.CODEX_HOME!, "hooks.json")) as { hooks: Record<string, unknown[]> };
    for (const event of ["UserPromptSubmit", "Stop", "SessionStart", "SessionEnd"]) {
      expect(cfg.hooks[event]).toHaveLength(1);
    }
    expect(readFileSync(path.join(env.CODEX_HOME!, "config.toml"), "utf8")).toBe("# untouched\n");
  });

  it("gemini: adds hooks under settings.json without disturbing mcpServers", () => {
    mkdirSync(env.GEMINI_CLI_HOME!, { recursive: true });
    writeFileSync(
      path.join(env.GEMINI_CLI_HOME!, "settings.json"),
      JSON.stringify({ mcpServers: { demo: { command: "true" } } })
    );
    installHooks(env, () => {});
    const cfg = readJson(path.join(env.GEMINI_CLI_HOME!, "settings.json")) as {
      mcpServers: Record<string, unknown>;
      hooks: Record<string, unknown[]>;
    };
    expect(cfg.mcpServers.demo).toEqual({ command: "true" });
    for (const event of ["BeforeAgent", "AfterAgent", "SessionStart", "SessionEnd"]) {
      expect(cfg.hooks[event]).toHaveLength(1);
    }
  });

  it("writes the hook script once under $GARRISON_HOME/shells and points it at the local events file", () => {
    installHooks(env, () => {});
    const script = readFileSync(path.join(env.GARRISON_HOME!, "shells", "agent-event-hook.sh"), "utf8");
    expect(script).toContain(path.join(env.GARRISON_HOME!, "shells", "events.jsonl"));
  });

  it("snapshots each file exactly once, even across repeated installs", () => {
    mkdirSync(env.GARRISON_CURSOR_HOME!, { recursive: true });
    writeFileSync(path.join(env.GARRISON_CURSOR_HOME!, "hooks.json"), JSON.stringify({ version: 1, hooks: {} }));
    installHooks(env, () => {});
    const snap = path.join(env.GARRISON_HOME!, "snapshots", "shells-cursor.before.json");
    const before = readFileSync(snap, "utf8");
    installHooks(env, () => {});
    expect(readFileSync(snap, "utf8")).toBe(before);
  });

  it("respects the opt-out and never touches any file", () => {
    mkdirSync(env.GARRISON_CURSOR_HOME!, { recursive: true });
    writeFileSync(path.join(env.GARRISON_CURSOR_HOME!, "hooks.json"), JSON.stringify({ version: 1, hooks: {} }));
    const result = installHooks({ ...env, GARRISON_REMOTESHELLRUNTIME_INSTALL_HOOKS: "false" }, () => {});
    expect(result.skipped).toBe(true);
    expect(readJson(path.join(env.GARRISON_CURSOR_HOME!, "hooks.json"))).toEqual({ version: 1, hooks: {} });
  });
});

describe("uninstall-hooks.mjs", () => {
  it("removes only the shells hook entries, leaving user-defined ones intact", () => {
    mkdirSync(env.GARRISON_CURSOR_HOME!, { recursive: true });
    mkdirSync(env.CODEX_HOME!, { recursive: true });
    installHooks(env, () => {});
    // Add an unrelated cursor hook that must survive.
    const cursorFile = path.join(env.GARRISON_CURSOR_HOME!, "hooks.json");
    const cfg = readJson(cursorFile) as { hooks: { stop: Array<{ command: string }> } };
    cfg.hooks.stop.push({ command: "echo mine" });
    writeFileSync(cursorFile, JSON.stringify(cfg));

    const result = uninstallHooks(env, () => {});
    expect(result.removed).toBeGreaterThan(0);
    const after = readJson(cursorFile) as { hooks: { stop: Array<{ command: string }>; beforeSubmitPrompt?: unknown } };
    expect(after.hooks.stop.map((h) => h.command)).toEqual(["echo mine"]);
    expect(after.hooks.beforeSubmitPrompt).toBeUndefined();
  });

  it("does nothing when nothing was ever installed", () => {
    const result = uninstallHooks(env, () => {});
    expect(result.removed).toBe(0);
  });
});
