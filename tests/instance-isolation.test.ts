import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = process.cwd();
const START = path.join(ROOT, "scripts", "start-codex-instance.sh");
const sandboxes: string[] = [];
const priorEnv = new Map<string, string | undefined>();

function rememberEnv(key: string, value: string): void {
  if (!priorEnv.has(key)) priorEnv.set(key, process.env[key]);
  process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of priorEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  priorEnv.clear();
  vi.resetModules();
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function parseEnv(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((line) => {
        const eq = line.indexOf("=");
        return [line.slice(0, eq), line.slice(eq + 1)];
      })
  );
}

function readYaml(file: string): any {
  return yaml.load(readFileSync(file, "utf8"));
}

describe("Codex secondary-instance isolation", () => {
  it("projects every writable control-plane/config surface into the secondary homes without starting services", () => {
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), "garrison-instance-env-"));
    sandboxes.push(fakeHome);
    const output = execFileSync("bash", [START, "env"], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: fakeHome,
        CODEX_GARRISON_HOME: "",
        CODEX_GARRISON_CLAUDE_HOME: "",
        GARRISON_KEYCHAIN_SERVICE: "",
        GARRISON_KEYCHAIN_ACCOUNT: ""
      }
    });
    const env = parseEnv(output);
    const garrison = path.join(fakeHome, ".garrison-codex");
    const claude = path.join(fakeHome, ".claude-garrison-codex");

    expect(env.GARRISON_INSTANCE_ID).toBe("codex");
    expect(env.GARRISON_HOME).toBe(garrison);
    expect(env.GARRISON_CLAUDE_HOME).toBe(claude);
    expect(env.CLAUDE_CONFIG_DIR).toBe(claude);
    expect(env.GARRISON_CLAUDE_JSON).toBe(path.join(claude, ".claude.json"));
    expect(env.GARRISON_CLAUDE_CONFIG_PATH).toBe(path.join(claude, ".claude.json"));
    expect(env.GARRISON_CLAUDE_PROJECTS_DIR).toBe(path.join(claude, "projects"));
    expect(env.GARRISON_CLAUDE_SESSIONS_DIR).toBe(path.join(claude, "sessions"));
    expect(env.GARRISON_CLAUDE_SETTINGS_PATH).toBe(path.join(claude, "settings.json"));

    const garrisonPaths = [
      "GARRISON_VAULT_PATH",
      "GARRISON_KANBAN_DIR",
      "GARRISON_AUTOMATIONS_DIR",
      "GARRISON_POLICY_PATH",
      "GARRISON_RUNS_DIR",
      "GARRISON_SCHEDULER_JOBS",
      "GARRISON_SCHEDULER_LOG",
      "GARRISON_TMUX_SOCKET_PATH",
      "BASIC_MEMORY_CONFIG_DIR",
      "BASIC_MEMORY_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "PLAYWRIGHT_BROWSERS_PATH",
      "UV_CACHE_DIR",
      "UV_TOOL_DIR",
      "UV_TOOL_BIN_DIR",
      "npm_config_cache",
      "CODEX_HOME",
      "GEMINI_CLI_HOME"
    ];
    for (const key of garrisonPaths) {
      const value = env[key];
      expect(
        value === garrison || value.startsWith(`${garrison}${path.sep}`),
        `${key} must stay under the secondary Garrison home`
      ).toBe(true);
    }

    expect(env.GARRISON_KEYCHAIN_SERVICE).toBe("agent-garrison-vault-codex");
    expect(env.GARRISON_KEYCHAIN_ACCOUNT).toBe("vault-master-key-codex");
    expect(env.GARRISON_DISABLE_HOST_DAEMONS).toBe("1");
    expect(env.GARRISON_APP_PORT).toBe("27777");
    expect(env.GARRISON_OUTPOST_PORT).toBe("23702");
    expect(env.GARRISON_SCHEDULER_HEALTH_PORT).toBe("27999");
    expect(env.GARRISON_SCHEDULER_SCRIPT).toBe(
      path.join(ROOT, "fittings", "seed", "scheduler", "scripts", "scheduler.mjs")
    );

    const startSource = readFileSync(START, "utf8");
    expect(startSource).toContain("--names next,outpost,scheduler");
    expect(startSource).toContain("--kill-others-on-fail");
    expect(startSource).toContain(
      'node \\"$GARRISON_SCHEDULER_SCRIPT\\" daemon --health-port $GARRISON_SCHEDULER_HEALTH_PORT'
    );
    expect(startSource).not.toMatch(/\bsystemctl\b|garrison-scheduler\.service/);

    const primaryRoots = [path.join(fakeHome, ".garrison"), path.join(fakeHome, ".claude")];
    for (const value of Object.values(env)) {
      expect(primaryRoots.some((root) => value === root || value.startsWith(`${root}${path.sep}`))).toBe(false);
    }
  });

  it("keeps every effective default-composition listener off the primary instance ports", () => {
    const composition = readYaml(path.join(ROOT, "compositions", "default", "apm.yml"));
    const selections = composition["x-garrison"].composition.selections as Record<
      string,
      Array<{ id: string; config?: Record<string, unknown> }>
    >;
    const ports = new Map<number, string>();

    for (const entries of Object.values(selections)) {
      for (const selected of entries ?? []) {
        const fitting = readYaml(path.join(ROOT, "fittings", "seed", selected.id, "apm.yml"));
        const metadata = fitting["x-garrison"] ?? {};
        if (metadata.own_port === true) {
          const effective = Number(selected.config?.port ?? metadata.default_port);
          expect(Number.isInteger(effective), `${selected.id} must resolve an own-port listener`).toBe(true);
          expect(ports.has(effective), `${selected.id} collides with ${ports.get(effective)} on ${effective}`).toBe(false);
          ports.set(effective, selected.id);
        }
      }
    }

    const gateway = selections.gateway.find((entry) => entry.id === "http-gateway");
    const slack = selections.channels.find((entry) => entry.id === "slack-channel");
    const scheduler = selections.observability.find((entry) => entry.id === "scheduler");
    ports.set(Number(gateway?.config?.port), "http-gateway");
    ports.set(Number(slack?.config?.slack_port), "slack-channel");
    ports.set(Number(scheduler?.config?.health_port), "scheduler");
    ports.set(27777, "garrison-next");
    ports.set(23702, "outpost-host");

    const primaryPorts = new Set([
      7777, 4777, 3702, 9512, 7077, 7082, 7083, 7084, 7085, 7086, 7087, 7088,
      7090, 7091, 7092, 7093, 7095, 7096, 7099, 27099
    ]);
    for (const [port, owner] of ports) {
      expect(primaryPorts.has(port), `${owner} still uses primary port ${port}`).toBe(false);
    }
    expect(ports.get(27096)).toBe("drill");
    expect(ports.get(24777)).toBe("http-gateway");
    expect(ports.get(27999)).toBe("scheduler");
  });

  it("keeps every shipped default profile on the same isolated state roots", () => {
    for (const profile of ["default", "default-build", "default-economy", "default-premium"]) {
      const composition = readYaml(path.join(ROOT, "compositions", profile, "apm.yml"));
      const selections = composition["x-garrison"].composition.selections as Record<
        string,
        Array<{ id: string; config?: Record<string, unknown> }>
      >;
      const config = (group: string, id: string) =>
        selections[group].find((entry) => entry.id === id)?.config;

      expect(config("memory", "basic-memory"), profile).toMatchObject({
        vault_dir: "~/.garrison-codex/ObsidianVault",
        project_name: "codex",
        register_codex_gemini: false
      });
      expect(config("observability", "automations")?.automations_dir, profile)
        .toBe("~/.garrison-codex/automations");
      expect(config("observability", "improver")?.vault_dir, profile)
        .toBe("~/.garrison-codex/ObsidianVault");
      expect(config("observability", "scheduler"), profile).toMatchObject({
        jobs_file: "~/.garrison-codex/scheduler-jobs.json",
        log_file: "~/.garrison-codex/scheduler.log",
        health_port: 27999
      });
      expect(config("observability", "kanban-loop")?.board_dir, profile)
        .toBe("~/.garrison-codex/kanban-loop");
      expect(config("sessions", "file-browser")?.root, profile)
        .toBe("~/.garrison-codex/files");
      expect(config("sessions", "vault-git-sync")?.vault_dir, profile)
        .toBe("~/.garrison-codex/ObsidianVault");
      expect(config("surfaces", "outpost-tailscale-host")?.outpost_host_url, profile)
        .toBe("http://127.0.0.1:23702");
    }
  });

  it("keeps helper fitting state and transport discovery inside the isolated homes", () => {
    const sandbox = mkdtempSync(path.join(os.tmpdir(), "garrison-instance-helpers-"));
    sandboxes.push(sandbox);
    const garrison = path.join(sandbox, "garrison");
    const pythonProbe = [
      "import json, runpy, sys",
      "values = runpy.run_path(sys.argv[1])",
      "print(json.dumps({key: values[key] for key in sys.argv[2:]}))"
    ].join("; ");
    const pythonEnv = {
      ...process.env,
      GARRISON_HOME: garrison,
      GARRISON_OUTPOST_PORT: "23888"
    };

    const outpost = JSON.parse(execFileSync(
      "python3",
      [
        "-c",
        pythonProbe,
        path.join(ROOT, "fittings", "seed", "outpost-actions", "scripts", "outpost.py"),
        "OUTPOST_HOST"
      ],
      { encoding: "utf8", env: pythonEnv }
    ));
    expect(outpost.OUTPOST_HOST).toBe("http://127.0.0.1:23888");

    const vaultSync = JSON.parse(execFileSync(
      "python3",
      [
        "-c",
        pythonProbe,
        path.join(ROOT, "fittings", "seed", "vault-sync", "scripts", "sync.py"),
        "OUTPOST_HOST",
        "_GARRISON_DIR",
        "STATUS_PATH",
        "CACHE_PATH"
      ],
      { encoding: "utf8", env: pythonEnv }
    ));
    expect(vaultSync).toEqual({
      OUTPOST_HOST: "http://127.0.0.1:23888",
      _GARRISON_DIR: garrison,
      STATUS_PATH: path.join(garrison, "vault-sync-status.json"),
      CACHE_PATH: path.join(garrison, "vault-sync-cache.json")
    });

    const reportServe = readFileSync(
      path.join(
        ROOT,
        "fittings",
        "seed",
        "garrison-skills",
        ".apm",
        "skills",
        "garrison-report",
        "scripts",
        "serve.mjs"
      ),
      "utf8"
    );
    expect(reportServe).toContain("path.join(GARRISON_HOME_DIR, 'report')");
    expect(reportServe).toContain("path.join(GARRISON_HOME_DIR, 'report-serve.json')");
    expect(reportServe).not.toContain("path.join(HOME, '.garrison', 'report')");

    const notify = readFileSync(
      path.join(
        ROOT,
        "fittings",
        "seed",
        "garrison-skills",
        ".apm",
        "skills",
        "garrison-report",
        "scripts",
        "notify.mjs"
      ),
      "utf8"
    );
    expect(notify).toContain("process.env.XDG_CONFIG_HOME");

    const improver = readFileSync(
      path.join(ROOT, "fittings", "seed", "improver", "scripts", "server.mjs"),
      "utf8"
    );
    expect(improver).toContain("process.env.GARRISON_CLAUDE_HOME");
  });

  it("resolves model-facing paths and runtime helpers through the isolated homes", async () => {
    const sandbox = mkdtempSync(path.join(os.tmpdir(), "garrison-instance-paths-"));
    sandboxes.push(sandbox);
    const garrison = path.join(sandbox, "garrison");
    const claude = path.join(sandbox, "claude");
    const automations = path.join(garrison, "automations");
    rememberEnv("GARRISON_HOME", garrison);
    rememberEnv("GARRISON_CLAUDE_HOME", claude);
    rememberEnv("GARRISON_AUTOMATIONS_DIR", automations);
    rememberEnv("GARRISON_POLICY_PATH", path.join(garrison, "orchestrator", "policy.json"));
    rememberEnv("GARRISON_INSTANCE_ID", "codex");

    const skillDir = path.join(claude, "skills", "only-secondary");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "---\ndescription: isolated\n---\n");

    const { claudeHome, claudeJsonPath, garrisonDir, globalCompositionDir } =
      await import("@/lib/claude-home");
    const { statusFilePath, spawnRecordPath } = await import("@/lib/own-port-lifecycle");
    const { scanWorkflows } = await import("@/lib/workflows-scan");
    const { keychainIdentity } = await import("@/lib/keychain");
    const { buildAutomationKickoff, buildDiscussParams } =
      await import("../fittings/seed/automations/lib/discuss.mjs");
    const { kanbanModelFile } =
      await import("../fittings/seed/kanban-loop/lib/resolved-model.mjs");
    const { listSkills } = await import("../fittings/seed/kanban-loop/lib/discover.mjs");
    const { scanSkillTelemetry } =
      await import("../fittings/seed/improver/lib/skill-telemetry.mjs");
    const { attachOrCreateArgs, TMUX_SESSION_PREFIX, TMUX_SOCKET_PATH, tmuxSessionName } =
      await import("../fittings/seed/dev-env/scripts/tmux.mjs");
    const { enumerateCommands } = await import("@garrison/claude-pty");

    expect(garrisonDir()).toBe(garrison);
    expect(claudeHome()).toBe(claude);
    expect(claudeJsonPath()).toBe(path.join(claude, ".claude.json"));
    expect(globalCompositionDir()).toBe(path.join(garrison, "global-composition"));
    expect(statusFilePath("drill")).toBe(path.join(garrison, "ui-fittings", "drill.json"));
    expect(spawnRecordPath("drill")).toBe(path.join(garrison, "ui-fittings", "spawn", "drill.json"));
    expect(kanbanModelFile()).toBe(path.join(garrison, "kanban-loop", "model.json"));
    expect(listSkills().map((skill: { name: string }) => skill.name)).toEqual(["only-secondary"]);
    expect(enumerateCommands().some((command: { name: string }) => command.name === "only-secondary")).toBe(true);
    expect(scanWorkflows()).toEqual([]);
    expect(scanSkillTelemetry().scanned.files).toBe(0);
    expect(TMUX_SOCKET_PATH).toBe(path.join(garrison, "tmux", "dev-env.sock"));
    expect(TMUX_SESSION_PREFIX).toBe("garrison_codex_");
    expect(tmuxSessionName("session-claude")).toBe("garrison_codex_session-claude");
    expect(
      attachOrCreateArgs({
        name: "garrison_codex_session-claude",
        cwd: sandbox,
        cols: 80,
        rows: 24,
        createCommand: "zsh"
      }).slice(0, 2)
    ).toEqual(["-S", path.join(garrison, "tmux", "dev-env.sock")]);

    const expectedBrief = path.join(automations, "briefs", "weekly-report.md");
    expect(buildAutomationKickoff({ name: "Weekly Report" })).toContain(expectedBrief);
    expect(buildAutomationKickoff({ name: "Weekly Report" })).not.toContain("~/.garrison");
    const context = JSON.parse(
      Buffer.from(buildDiscussParams({ name: "Weekly Report" }).context, "base64").toString("utf8")
    );
    expect(context.briefAbsPath).toBe(expectedBrief);

    rememberEnv("GARRISON_KEYCHAIN_SERVICE", "agent-garrison-vault-codex");
    rememberEnv("GARRISON_KEYCHAIN_ACCOUNT", "vault-master-key-codex");
    expect(keychainIdentity()).toMatchObject({
      service: "agent-garrison-vault-codex",
      account: "vault-master-key-codex"
    });
  });

  it("blocks host-global power actions and does not auto-launch external adapters", async () => {
    const { hostPowerActionsDisabled } =
      await import("../fittings/seed/power-default/scripts/server.mjs");
    expect(hostPowerActionsDisabled({ GARRISON_DISABLE_HOST_DAEMONS: "1" })).toBe(true);
    expect(hostPowerActionsDisabled({})).toBe(false);

    const runner = readFileSync(path.join(ROOT, "src", "lib", "runner.ts"), "utf8");
    expect(runner).not.toContain("slack-adapter.js");
    const slack = readYaml(path.join(ROOT, "fittings", "seed", "slack-channel", "apm.yml"));
    expect(slack["x-garrison"].own_port).not.toBe(true);
    const trelloSetup = readFileSync(
      path.join(ROOT, "fittings", "seed", "trello", "scripts", "setup.sh"),
      "utf8"
    );
    expect(trelloSetup).not.toMatch(/https?:\/\/|\bcurl\b/);

    const snapshotSetup = readFileSync(
      path.join(ROOT, "fittings", "seed", "snapshots-default", "scripts", "setup.sh"),
      "utf8"
    );
    expect(snapshotSetup).toContain('GARRISON_DISABLE_HOST_DAEMONS:-0');
    const daemonGuard = snapshotSetup.indexOf('GARRISON_DISABLE_HOST_DAEMONS:-0');
    expect(daemonGuard).toBeGreaterThanOrEqual(0);
    expect(daemonGuard).toBeLessThan(snapshotSetup.indexOf("USER_UNIT_DIR="));
    expect(daemonGuard).toBeLessThan(snapshotSetup.indexOf("systemctl --user daemon-reload"));
  });

  it("ships selected operative instructions without executable primary-home literals", () => {
    const browserSkill = readFileSync(
      path.join(ROOT, "fittings", "seed", "browser-default", ".apm", "skills", "garrison-browser", "SKILL.md"),
      "utf8"
    );
    const drillSkill = readFileSync(
      path.join(ROOT, "fittings", "seed", "drill", ".apm", "skills", "garrison-drill", "SKILL.md"),
      "utf8"
    );
    expect(browserSkill).not.toContain("~/.garrison/bin/garrison-browser");
    expect(browserSkill).toContain("garrison-browser tabs");
    expect(drillSkill).not.toContain("~/.garrison/orchestrator/policy.json");
    expect(drillSkill).toContain("$GARRISON_POLICY_PATH");
  });
});
