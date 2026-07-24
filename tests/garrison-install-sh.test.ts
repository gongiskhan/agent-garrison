import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Phase 0: the garrison goal-loop self-installer (garrison-skills/.../hooks/install.sh)
// must (a) tag the hook groups it writes with _garrison so they are attributable,
// (b) take a NON-overwriting timestamped backup, and (c) skip entirely when the
// machine's install-state says Garrison is not enabled.

const HOOKS_SRC = path.join(
  process.cwd(),
  "fittings/seed/garrison-skills/.apm/skills/garrison/hooks"
);

function hasJq(): boolean {
  try {
    execSync("command -v jq", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let base: string;
let hooksDir: string;
let settings: string;
let garrisonHome: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "gar-install-sh-"));
  // Run a COPY of the hooks dir so the script's `chmod +x` never touches the repo.
  hooksDir = path.join(base, "hooks");
  fs.cpSync(HOOKS_SRC, hooksDir, { recursive: true });
  settings = path.join(base, "settings.json");
  garrisonHome = path.join(base, ".garrison");
  fs.mkdirSync(garrisonHome, { recursive: true });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function runInstall(env: Record<string, string> = {}): string {
  return execFileSync("bash", [path.join(hooksDir, "install.sh")], {
    env: { ...process.env, CLAUDE_SETTINGS: settings, GARRISON_HOME: garrisonHome, ...env },
    encoding: "utf8"
  });
}

describe.skipIf(!hasJq())("garrison goal-loop installer (install.sh)", () => {
  it("tags the Stop/SessionStart groups it writes with _garrison and backs up (timestamped)", () => {
    fs.writeFileSync(settings, JSON.stringify({ model: "opus", env: { EXISTING: "keep" } }, null, 2));
    runInstall();

    const doc = JSON.parse(fs.readFileSync(settings, "utf8"));
    // Pre-existing unrelated keys survive.
    expect(doc.model).toBe("opus");
    expect(doc.env.EXISTING).toBe("keep");
    // Goal-loop groups are present AND owner-tagged.
    const stop = doc.hooks.Stop.find((g: { _garrison?: string }) => g._garrison === "fitting:garrison-skills");
    const ss = doc.hooks.SessionStart.find((g: { _garrison?: string }) => g._garrison === "fitting:garrison-skills");
    expect(stop).toBeTruthy();
    expect(ss).toBeTruthy();
    expect(JSON.stringify(stop.hooks)).toContain("garrison-goal-stop.sh");
    expect(JSON.stringify(ss.hooks)).toContain("garrison-goal-sessionstart.sh");

    // A timestamped backup exists (NOT the legacy fixed .garrison.bak).
    const baks = fs.readdirSync(base).filter((f) => /settings\.json\.garrison-.*\.bak$/.test(f));
    expect(baks.length).toBe(1);
    expect(fs.existsSync(path.join(base, "settings.json.garrison.bak"))).toBe(false);
  });

  it("retro-tags a pre-existing UNTAGGED goal-loop group (self-heal)", () => {
    fs.writeFileSync(
      settings,
      JSON.stringify(
        {
          env: { CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: "999" },
          hooks: {
            Stop: [{ matcher: "*", hooks: [{ type: "command", command: "bash '/x/garrison-goal-stop.sh'" }] }],
            SessionStart: [
              { matcher: "*", hooks: [{ type: "command", command: "bash '/x/garrison-goal-sessionstart.sh'" }] }
            ]
          }
        },
        null,
        2
      )
    );
    runInstall();
    const doc = JSON.parse(fs.readFileSync(settings, "utf8"));
    expect(doc.hooks.Stop[0]._garrison).toBe("fitting:garrison-skills");
    expect(doc.hooks.SessionStart[0]._garrison).toBe("fitting:garrison-skills");
    // No duplicate group was appended.
    expect(doc.hooks.Stop.length).toBe(1);
    expect(doc.hooks.SessionStart.length).toBe(1);
  });

  it("skips entirely when install-state.json says management is disabled", () => {
    fs.writeFileSync(settings, JSON.stringify({ model: "opus" }, null, 2));
    fs.writeFileSync(
      path.join(garrisonHome, "install-state.json"),
      JSON.stringify({ version: 1, installed: false })
    );
    runInstall();
    // settings.json is untouched — no hooks wired.
    const doc = JSON.parse(fs.readFileSync(settings, "utf8"));
    expect(doc.hooks).toBeUndefined();
    expect(fs.readdirSync(base).some((f) => /\.bak$/.test(f))).toBe(false);
  });

  it("proceeds when install-state.json says installed", () => {
    fs.writeFileSync(settings, JSON.stringify({}, null, 2));
    fs.writeFileSync(
      path.join(garrisonHome, "install-state.json"),
      JSON.stringify({ version: 1, installed: true })
    );
    runInstall();
    const doc = JSON.parse(fs.readFileSync(settings, "utf8"));
    expect(doc.hooks.Stop.some((g: { _garrison?: string }) => g._garrison === "fitting:garrison-skills")).toBe(true);
  });
});
