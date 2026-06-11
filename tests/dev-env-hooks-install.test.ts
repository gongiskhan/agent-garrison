import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Dev Env hook installer gate. install-hooks.mjs is owner-scoped
// (`_garrison: "fitting:dev-env"`): it must strip its own prior groups AND
// the retired session-view-sequoias owner's groups (the migration path),
// preserve unrelated user groups, install exactly 4 fresh groups, and be
// idempotent. Runs the real script against a temp settings.json via the
// GARRISON_CLAUDE_SETTINGS_PATH override.

const SCRIPT = path.resolve(
  __dirname,
  "..",
  "fittings",
  "seed",
  "dev-env",
  "scripts",
  "install-hooks.mjs"
);
const HOOK_EVENTS = ["UserPromptSubmit", "Stop", "Notification", "PostToolUse"];

interface HookGroup {
  _garrison?: string | boolean;
  matcher?: string;
  hooks?: Array<{ type: string; command: string; timeout?: number }>;
}

type Settings = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

let sandbox: string;
let settingsPath: string;

function runInstaller(): void {
  // HOME points at the sandbox so the installer's first-install snapshot
  // (~/.garrison/snapshots) never touches the real home directory.
  execFileSync(process.execPath, [SCRIPT], {
    env: { ...process.env, HOME: sandbox, GARRISON_CLAUDE_SETTINGS_PATH: settingsPath },
    stdio: "pipe"
  });
}

function readSettings(): Settings {
  return JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
}

function groupsByOwner(settings: Settings, owner: string): HookGroup[] {
  const out: HookGroup[] = [];
  for (const list of Object.values(settings.hooks ?? {})) {
    for (const group of list) {
      if (group._garrison === owner) out.push(group);
    }
  }
  return out;
}

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "garrison-dev-env-hooks-"));
  settingsPath = path.join(sandbox, "settings.json");
  // Pre-seed: a retired session-view owner group, a legacy bare-true group,
  // and an unrelated user-authored group that must survive untouched.
  const seeded: Settings = {
    model: "opus",
    hooks: {
      UserPromptSubmit: [
        {
          _garrison: "fitting:session-view-sequoias",
          matcher: "",
          hooks: [{ type: "command", command: "curl old-session-view", timeout: 5 }]
        },
        {
          matcher: "",
          hooks: [{ type: "command", command: "echo user-defined-keep-me" }]
        }
      ],
      Stop: [
        {
          _garrison: true,
          matcher: "",
          hooks: [{ type: "command", command: "curl legacy-bare-true", timeout: 5 }]
        }
      ]
    }
  };
  writeFileSync(settingsPath, JSON.stringify(seeded, null, 2));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("dev-env install-hooks.mjs", () => {
  it("strips the retired owner, preserves user groups, installs 4 dev-env groups", () => {
    runInstaller();
    const settings = readSettings();

    expect(groupsByOwner(settings, "fitting:session-view-sequoias")).toHaveLength(0);
    const bareTrue = Object.values(settings.hooks ?? {})
      .flat()
      .filter((g) => g._garrison === true);
    expect(bareTrue).toHaveLength(0);

    const userGroups = (settings.hooks?.UserPromptSubmit ?? []).filter(
      (g) => g._garrison === undefined
    );
    expect(userGroups).toHaveLength(1);
    expect(userGroups[0].hooks?.[0].command).toContain("user-defined-keep-me");

    const devEnvGroups = groupsByOwner(settings, "fitting:dev-env");
    expect(devEnvGroups).toHaveLength(4);
    for (const event of HOOK_EVENTS) {
      const eventGroups = (settings.hooks?.[event] ?? []).filter(
        (g) => g._garrison === "fitting:dev-env"
      );
      expect(eventGroups, `event ${event} needs exactly one dev-env group`).toHaveLength(1);
      expect(eventGroups[0].hooks?.[0].command).toContain(`/_hook?event=${event}`);
      expect(eventGroups[0].hooks?.[0].command).toContain("7086");
    }

    expect(settings.model).toBe("opus");
  });

  it("is idempotent: a second run leaves exactly 4 dev-env groups", () => {
    runInstaller();
    runInstaller();
    const settings = readSettings();
    expect(groupsByOwner(settings, "fitting:dev-env")).toHaveLength(4);
    expect(groupsByOwner(settings, "fitting:session-view-sequoias")).toHaveLength(0);
    const userGroups = (settings.hooks?.UserPromptSubmit ?? []).filter(
      (g) => g._garrison === undefined
    );
    expect(userGroups).toHaveLength(1);
  });
});
