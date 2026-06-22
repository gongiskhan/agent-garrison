import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// coord-beads hook installer gate (the COMMITTED correctness assertion).
// Owner-scoped (`_garrison: "fitting:coord-beads"`): install must add exactly one
// fail-open SessionStart group, be idempotent, de-dup ONLY the exact untagged
// native `bd prime` group, preserve unrelated user hooks, never clobber a corrupt
// settings.json, install a self-bounded fail-open wrapper, and uninstall must
// remove ONLY its own group. Runs the real scripts against a temp settings.json
// via GARRISON_CLAUDE_SETTINGS_PATH (never the live ~/.claude).

const FITTING_DIR = path.resolve(__dirname, "..", "fittings", "seed", "coord-beads");
const INSTALL = path.join(FITTING_DIR, "scripts", "install-hooks.mjs");
const UNINSTALL = path.join(FITTING_DIR, "scripts", "uninstall-hooks.mjs");
const OWNER = "fitting:coord-beads";

interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
}
interface HookGroup {
  _garrison?: string | boolean;
  matcher?: string;
  hooks?: HookEntry[];
}
type Settings = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

let sandbox: string;
let settingsPath: string;

function run(script: string): void {
  execFileSync(process.execPath, [script], {
    env: { ...process.env, HOME: sandbox, GARRISON_HOME: sandbox, GARRISON_CLAUDE_SETTINGS_PATH: settingsPath },
    stdio: "pipe"
  });
}

function readSettings(): Settings {
  return JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
}
function ownerGroups(s: Settings): HookGroup[] {
  return (s.hooks?.SessionStart ?? []).filter((g) => g && g._garrison === OWNER);
}

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "coord-beads-"));
  settingsPath = path.join(sandbox, "settings.json");
});
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("coord-beads install-hooks", () => {
  it("installs one owner-tagged fail-open SessionStart group + the stable wrapper", () => {
    run(INSTALL);
    const groups = ownerGroups(readSettings());
    expect(groups).toHaveLength(1);
    const cmd = groups[0].hooks?.[0];
    expect(cmd?.type).toBe("command");
    // Fail-open: the hook calls the stable wrapper, guarded, with `|| true`.
    expect(cmd?.command).toContain("coord-beads-prime.sh");
    expect(cmd?.command).toContain("|| true");
    expect(cmd?.timeout).toBe(8);
    const wrapper = path.join(sandbox, "bin", "coord-beads-prime.sh");
    expect(existsSync(wrapper)).toBe(true);
  });

  it("is idempotent — re-running never duplicates the group", () => {
    run(INSTALL);
    run(INSTALL);
    run(INSTALL);
    expect(ownerGroups(readSettings())).toHaveLength(1);
  });

  it("de-dups ONLY the exact untagged native `bd setup claude` group", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify(
        { hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "bd prime --hook-json" }] }] } },
        null,
        2
      )
    );
    run(INSTALL);
    const groups = readSettings().hooks?.SessionStart ?? [];
    expect(groups).toHaveLength(1);
    expect(groups[0]._garrison).toBe(OWNER);
  });

  it("does NOT strip a hand-authored group that merely mentions bd prime (tightened de-dup)", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              // not the exact native shape: extra command + extra hook
              { matcher: "", hooks: [{ type: "command", command: "bd prime --hook-json && echo custom" }] },
              { matcher: "", hooks: [{ type: "command", command: "bd prime" }, { type: "command", command: "echo two" }] }
            ]
          }
        },
        null,
        2
      )
    );
    run(INSTALL);
    const groups = readSettings().hooks?.SessionStart ?? [];
    // both hand-authored groups survive + our one owner group = 3
    expect(groups).toHaveLength(3);
    expect(groups.some((g) => g.hooks?.[0]?.command === "bd prime --hook-json && echo custom")).toBe(true);
    expect(groups.some((g) => (g.hooks?.length ?? 0) === 2)).toBe(true);
    expect(ownerGroups(readSettings())).toHaveLength(1);
  });

  it("preserves unrelated hand-authored hooks + unrelated settings keys", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "echo hello-user" }] }],
            PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo gate" }] }]
          },
          permissions: { defaultMode: "bypassPermissions" }
        },
        null,
        2
      )
    );
    run(INSTALL);
    const s = readSettings();
    expect(s.hooks?.SessionStart?.some((g) => g.hooks?.[0]?.command === "echo hello-user")).toBe(true);
    expect(ownerGroups(s)).toHaveLength(1);
    expect(s.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command).toBe("echo gate");
    expect((s as { permissions?: { defaultMode?: string } }).permissions?.defaultMode).toBe("bypassPermissions");
  });

  it("never clobbers a corrupt settings.json — aborts, leaves bytes untouched", () => {
    const corrupt = "{ this is : not json ";
    writeFileSync(settingsPath, corrupt);
    expect(() => run(INSTALL)).toThrow(); // non-zero exit
    expect(readFileSync(settingsPath, "utf8")).toBe(corrupt);
  });

  it("uninstall removes ONLY the owner group and leaves others intact", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify(
        { hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "echo hello-user" }] }] } },
        null,
        2
      )
    );
    run(INSTALL);
    run(UNINSTALL);
    const s = readSettings();
    expect(ownerGroups(s)).toHaveLength(0);
    expect(s.hooks?.SessionStart?.some((g) => g.hooks?.[0]?.command === "echo hello-user")).toBe(true);
  });

  it("uninstall is a no-op when nothing is installed", () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }, null, 2));
    expect(() => run(UNINSTALL)).not.toThrow();
    expect(existsSync(settingsPath)).toBe(true);
  });
});

describe("coord-beads prime-hook wrapper (fail-open + self-bounded)", () => {
  it("emits empty context and exits 0 within its own timeout even if bd hangs", () => {
    run(INSTALL);
    const wrapper = path.join(sandbox, "bin", "coord-beads-prime.sh");
    // A fake `bd` that hangs for 30s, earlier on PATH.
    const fakeBin = path.join(sandbox, "fakebin");
    mkdirSync(fakeBin, { recursive: true });
    const fakeBd = path.join(fakeBin, "bd");
    writeFileSync(fakeBd, "#!/bin/sh\nsleep 30\n");
    chmodSync(fakeBd, 0o755);
    const start = Date.now();
    const out = execFileSync("sh", [wrapper], {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
      encoding: "utf8"
    });
    const elapsed = Date.now() - start;
    expect(out).toContain('"additionalContext":""');
    expect(elapsed).toBeLessThan(15000); // self-bounded (~5s), never the 30s hang
  });
});
