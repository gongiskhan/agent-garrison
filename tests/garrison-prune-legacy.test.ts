// GARRISON-FLOW-V2 S7 / RUN_SPEC A5 — the PRUNE half of the additive-then-prune
// hook transition. install.sh deliberately never removes the legacy autothing goal
// hooks (a run in flight loops on them); prune-legacy.sh retires them, but only
// once no legacy sentinel is live. A gate nothing can open is not a gate, so the
// prune is exercised here: it refuses while a legacy run is armed, removes exactly
// the legacy entries when clear, leaves the garrison entries intact, and is
// idempotent.
import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(
  __dirname,
  "../fittings/seed/garrison-skills/.apm/skills/garrison/hooks/prune-legacy.sh"
);

const LEGACY_STOP = "bash /home/ggomes/.claude/skills/autothing/hooks/goal-stop.sh";
const LEGACY_START = "bash /home/ggomes/.claude/skills/autothing/hooks/goal-sessionstart.sh";
const GARRISON_STOP = "bash /home/ggomes/.claude/skills/garrison/hooks/garrison-goal-stop.sh";
const GARRISON_START = "bash /home/ggomes/.claude/skills/garrison/hooks/garrison-goal-sessionstart.sh";

let home: string;
let settings: string;
let sentinels: string;

function seedSettings() {
  writeFileSync(
    settings,
    JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [
              { type: "command", command: LEGACY_STOP },
              { type: "command", command: GARRISON_STOP }
            ]
          }
        ],
        SessionStart: [
          {
            matcher: "",
            hooks: [
              { type: "command", command: LEGACY_START },
              { type: "command", command: GARRISON_START }
            ]
          }
        ]
      }
    }),
    "utf8"
  );
}

// Returns [exitCode, stdout]. The script exits 3 on a refusal, which execFileSync
// throws on, so the status is read off the error rather than assumed.
function runPrune(args: string[] = []): { code: number; out: string } {
  try {
    const out = execFileSync("bash", [SCRIPT, ...args], {
      env: { ...process.env, CLAUDE_SETTINGS: settings, AUTOTHING_SENTINEL_DIR: sentinels },
      encoding: "utf8"
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { code: e.status ?? 1, out: e.stdout ?? "" };
  }
}

function commands(): string[] {
  const cfg = JSON.parse(readFileSync(settings, "utf8"));
  const out: string[] = [];
  for (const groups of Object.values(cfg.hooks ?? {}) as Array<Array<{ hooks?: Array<{ command?: string }> }>>) {
    for (const g of groups) for (const h of g.hooks ?? []) if (h.command) out.push(h.command);
  }
  return out;
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "garrison-prune-"));
  settings = path.join(home, "settings.json");
  sentinels = path.join(home, "sentinels");
  mkdirSync(sentinels, { recursive: true });
  seedSettings();
});

describe("A5 prune-legacy — the second half of the hook transition", () => {
  it("REFUSES while a legacy sentinel is live (a run may still be looping on it)", () => {
    writeFileSync(path.join(sentinels, "some-session.json"), "{}", "utf8");
    const { code, out } = runPrune();
    expect(code).toBe(3);
    expect(out).toContain("REFUSED");
    // and it changed nothing
    expect(commands()).toContain(LEGACY_STOP);
  });

  it("removes exactly the legacy entries when the gate is clear, keeping the garrison ones", () => {
    const { code } = runPrune();
    expect(code).toBe(0);
    const cmds = commands();
    expect(cmds).not.toContain(LEGACY_STOP);
    expect(cmds).not.toContain(LEGACY_START);
    expect(cmds).toContain(GARRISON_STOP);
    expect(cmds).toContain(GARRISON_START);
  });

  it("is idempotent - a second run is a clean no-op", () => {
    expect(runPrune().code).toBe(0);
    const after = runPrune();
    expect(after.code).toBe(0);
    expect(after.out).toContain("already clean");
    expect(commands()).toEqual([GARRISON_STOP, GARRISON_START]);
  });

  it("--check reports without writing (exit 3 while legacy entries remain)", () => {
    const { code, out } = runPrune(["--check"]);
    expect(code).toBe(3);
    expect(out).toContain("gate CLEAR");
    expect(commands()).toContain(LEGACY_STOP); // unchanged
  });

  it("leaves a settings.json with no legacy entries untouched", () => {
    runPrune();
    const before = readFileSync(settings, "utf8");
    runPrune();
    expect(readFileSync(settings, "utf8")).toBe(before);
  });
});
