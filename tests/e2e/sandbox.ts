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

  // settings.json with documented (typed) + bespoke (passthrough) keys, plus a
  // hand-authored (untagged) hook group AND a fitting-owned (_garrison) one — so
  // the Quarters Hooks surface can prove editable-vs-read-only.
  fs.writeFileSync(
    path.join(CLAUDE_SANDBOX, "settings.json"),
    JSON.stringify(
      {
        cleanupPeriodDays: 365,
        model: "claude-sonnet-4-6",
        advisorModel: "opus",
        autoDreamEnabled: true,
        autoMode: { environment: ["solo dev"] },
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo hand-authored" }] }],
          Stop: [{ _garrison: "fitting:session-view", hooks: [{ type: "command", command: "echo owned" }] }]
        }
      },
      null,
      2
    )
  );

  fs.writeFileSync(
    path.join(CLAUDE_SANDBOX, "CLAUDE.md"),
    "# Sandbox user CLAUDE.md\n\nDurable behavioral guidance lives here.\n"
  );

  // A plan file for the Quarters -> Plans surface.
  const plansDir = path.join(CLAUDE_SANDBOX, "plans");
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(path.join(plansDir, "example-plan.md"), "# Example plan\n\nstep one.\n");

  // An MCP server for the Quarters -> MCPs surface.
  fs.writeFileSync(
    path.join(CLAUDE_SANDBOX, "mcp.json"),
    JSON.stringify({ mcpServers: { "sandbox-mcp": { command: "echo" } } }, null, 2)
  );

  // Plugins surface (Quarters -> Plugins): Claude-Code-managed installs.
  fs.mkdirSync(path.join(CLAUDE_SANDBOX, "plugins"), { recursive: true });
  fs.writeFileSync(
    path.join(CLAUDE_SANDBOX, "plugins", "installed_plugins.json"),
    JSON.stringify(
      {
        version: 2,
        plugins: {
          "frontend-design@claude-plugins-official": [
            { scope: "user", version: "08de64fff891", installPath: "/sandbox/fd" }
          ]
        }
      },
      null,
      2
    )
  );

  // Logs surface (Quarters -> Logs): a top-level *.log + a nested log file.
  fs.mkdirSync(path.join(CLAUDE_SANDBOX, "logs", "security"), { recursive: true });
  fs.writeFileSync(path.join(CLAUDE_SANDBOX, "daemon.log"), "daemon boot\ndaemon ready\ndaemon serving\n");
  fs.writeFileSync(
    path.join(CLAUDE_SANDBOX, "logs", "security", "audit.log"),
    "audit: start\naudit: ok\n"
  );

  // Scripts surface (Quarters -> Scripts): a loose command + rule .md (the shape
  // APM deploys), so the surface has hand-authored content to list/edit/delete.
  fs.mkdirSync(path.join(CLAUDE_SANDBOX, "commands"), { recursive: true });
  fs.writeFileSync(path.join(CLAUDE_SANDBOX, "commands", "example-command.md"), "# /example-command\n\nrun the thing.\n");
  fs.mkdirSync(path.join(CLAUDE_SANDBOX, "rules"), { recursive: true });
  fs.writeFileSync(path.join(CLAUDE_SANDBOX, "rules", "example-rule.md"), "# example-rule\n\nbe terse.\n");

  // Sessions surface (Quarters -> Sessions): a per-pid record + a transcript.
  fs.mkdirSync(path.join(CLAUDE_SANDBOX, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(CLAUDE_SANDBOX, "projects", "-sandbox-proj"), { recursive: true });
  fs.writeFileSync(
    path.join(CLAUDE_SANDBOX, "sessions", "9937.json"),
    JSON.stringify({ pid: 9937, cwd: "/tmp/sandbox" }, null, 2)
  );
  fs.writeFileSync(
    path.join(CLAUDE_SANDBOX, "projects", "-sandbox-proj", "transcript.jsonl"),
    '{"type":"user","text":"hello"}\n{"type":"assistant","text":"hi there"}\n'
  );

  fs.mkdirSync(GARRISON_SANDBOX, { recursive: true });
}
