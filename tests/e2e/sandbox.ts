import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Seeded sandbox for the config-plane e2e + walkthrough runs. The dev server is
// launched with GARRISON_CLAUDE_HOME / GARRISON_HOME pointing here, so NO
// automated run ever reads or writes the user's live ~/.claude.

export const SANDBOX_ROOT = path.join(os.homedir(), ".garrison-test");
export const CLAUDE_SANDBOX = path.join(SANDBOX_ROOT, "claude");
export const GARRISON_SANDBOX = path.join(SANDBOX_ROOT, "garrison");

export function seedSandbox(): void {
  fs.rmSync(CLAUDE_SANDBOX, { recursive: true, force: true });
  fs.rmSync(GARRISON_SANDBOX, { recursive: true, force: true });

  // A pre-existing, hand-authored skill on disk that matches the skill-shape
  // library fitting "memory" (which deploys skills/garrison-memory). This drives
  // the brown-field Adopt flow in Armory: Install -> collision -> Adopt.
  const memorySkill = path.join(CLAUDE_SANDBOX, "skills", "garrison-memory");
  fs.mkdirSync(memorySkill, { recursive: true });
  fs.writeFileSync(
    path.join(memorySkill, "SKILL.md"),
    "---\nname: garrison-memory\ndescription: pre-existing on disk\n---\n# existing\n"
  );

  // settings.json with documented (typed) + bespoke (passthrough) keys
  fs.writeFileSync(
    path.join(CLAUDE_SANDBOX, "settings.json"),
    JSON.stringify(
      {
        cleanupPeriodDays: 365,
        model: "claude-sonnet-4-6",
        advisorModel: "opus",
        autoDreamEnabled: true,
        autoMode: { environment: ["solo dev"] }
      },
      null,
      2
    )
  );

  fs.writeFileSync(
    path.join(CLAUDE_SANDBOX, "CLAUDE.md"),
    "# Sandbox user CLAUDE.md\n\nDurable behavioral guidance lives here.\n"
  );

  fs.mkdirSync(GARRISON_SANDBOX, { recursive: true });
}
