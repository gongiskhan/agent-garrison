import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = process.cwd();
// The profile-driven launcher. start-codex-instance.sh is now a thin shim onto
// `garrison-instance.sh codex`, so the substantive assertions read this file.
const LAUNCHER = path.join(ROOT, "scripts", "garrison-instance.sh");
const START = path.join(ROOT, "scripts", "start-codex-instance.sh");

// Must match PROFILE_PORT_OFFSET in src/lib/instance-profile.ts and the case
// block in scripts/garrison-instance.sh. The three are pinned against each
// other below so a change to one without the others fails here.
const PROFILE_OFFSET: Record<string, number> = { dev: 0, prod: 1000, codex: 20000 };

// Run the launcher's `env` mode for a profile under a throwaway HOME, with
// every port/home override cleared so inherited shell env cannot leak in.
function launcherEnv(profile: string, fakeHome: string): Record<string, string> {
  const output = execFileSync("bash", [LAUNCHER, profile, "env"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: fakeHome,
      GARRISON_HOME: "",
      GARRISON_HOME_OVERRIDE: "",
      GARRISON_CLAUDE_HOME_OVERRIDE: "",
      GARRISON_APP_PORT: "",
      GARRISON_OUTPOST_PORT: "",
      GARRISON_SCHEDULER_HEALTH_PORT: "",
      GARRISON_KEYCHAIN_SERVICE: "",
      GARRISON_KEYCHAIN_ACCOUNT: "",
      NEXT_DIST_DIR: ""
    }
  });
  return parseEnv(output);
}
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
    const env = launcherEnv("codex", fakeHome);
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
    expect(env.GARRISON_SCHEDULER_HEALTH_PORT).toBe("27099");
    expect(env.GARRISON_SCHEDULER_SCRIPT).toBe(
      path.join(ROOT, "fittings", "seed", "scheduler", "scripts", "scheduler.mjs")
    );

    const startSource = readFileSync(LAUNCHER, "utf8");
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

  // HARD RULE: prod and dev are separate instances out of the SAME checkout.
  // They must never share a port, a Garrison home, or a Claude config dir —
  // the tailnet address is always-on prod, and a dev boot that lands on prod's
  // ports (or scribbles on the real ~/.claude) takes it down.
  it("keeps prod, dev and codex on disjoint ports and disjoint state roots", () => {
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), "garrison-profiles-"));
    sandboxes.push(fakeHome);

    const envs = Object.fromEntries(
      Object.keys(PROFILE_OFFSET).map((p) => [p, launcherEnv(p, fakeHome)])
    );

    // Every process-level port is the base value plus the profile's offset —
    // one committed port map, three instances, no second table to drift.
    for (const [profile, offset] of Object.entries(PROFILE_OFFSET)) {
      const env = envs[profile];
      expect(env.GARRISON_INSTANCE_ID, `${profile} identity`).toBe(profile);
      expect(Number(env.GARRISON_PORT_OFFSET), `${profile} offset`).toBe(offset);
      expect(Number(env.GARRISON_APP_PORT), `${profile} app port`).toBe(7777 + offset);
      expect(Number(env.GARRISON_OUTPOST_PORT), `${profile} outpost port`).toBe(3702 + offset);
      expect(Number(env.GARRISON_SCHEDULER_HEALTH_PORT), `${profile} scheduler port`).toBe(7099 + offset);
      // Next reads PORT; the runner's self-URL falls back to it. Drift between
      // the two sends every fitting's callback to the wrong instance.
      expect(env.PORT, `${profile} PORT tracks GARRISON_APP_PORT`).toBe(env.GARRISON_APP_PORT);
    }

    // No two profiles may claim the same listener.
    const claimed = new Map<string, string>();
    for (const [profile, env] of Object.entries(envs)) {
      for (const key of ["GARRISON_APP_PORT", "GARRISON_OUTPOST_PORT", "GARRISON_SCHEDULER_HEALTH_PORT"]) {
        const port = env[key];
        expect(claimed.has(port), `${profile}.${key} collides with ${claimed.get(port)} on ${port}`).toBe(false);
        claimed.set(port, `${profile}.${key}`);
      }
    }

    // Disjoint state roots. Only prod owns the real ~/.garrison and ~/.claude —
    // that ownership IS Garrison's control plane, and a dev instance writing
    // there would edit the user's live Claude Code config.
    expect(envs.prod.GARRISON_HOME).toBe(path.join(fakeHome, ".garrison"));
    expect(envs.prod.GARRISON_CLAUDE_HOME).toBe(path.join(fakeHome, ".claude"));
    const prodRoots = [envs.prod.GARRISON_HOME, envs.prod.GARRISON_CLAUDE_HOME];
    for (const profile of ["dev", "codex"]) {
      for (const [key, value] of Object.entries(envs[profile])) {
        if (!value) continue;
        expect(
          prodRoots.some((root) => value === root || value.startsWith(`${root}${path.sep}`)),
          `${profile}.${key} (${value}) must stay out of prod's state roots`
        ).toBe(false);
      }
    }

    // Prod serves a BUILT artifact from its own dist dir, so `next build` can
    // never clobber a running dev server's .next (and vice versa).
    expect(envs.prod.NEXT_DIST_DIR).toBe(".next-prod");
    expect(envs.dev.NEXT_DIST_DIR || "").toBe("");

    // The host-daemon sweep is single-owner: only prod reaps.
    expect(envs.prod.GARRISON_DISABLE_HOST_DAEMONS || "").toBe("");
    expect(envs.dev.GARRISON_DISABLE_HOST_DAEMONS).toBe("1");
    expect(envs.codex.GARRISON_DISABLE_HOST_DAEMONS).toBe("1");
  });

  // The Claude CLI keeps its user config at the SIBLING of its home
  // (~/.claude -> ~/.claude.json), not inside it. Setting CLAUDE_CONFIG_DIR to
  // the real ~/.claude is NOT a no-op — the CLI switches to
  // ~/.claude/.claude.json, a stub with no `theme`/`hasCompletedOnboarding`, so
  // the interactive TUI boots the onboarding screen and the gateway spawn dies
  // with "waiting on a login/setup screen". Prod must therefore leave
  // CLAUDE_CONFIG_DIR unset; the isolated profiles must still set it.
  it("leaves CLAUDE_CONFIG_DIR unset for prod and uses the sibling ~/.claude.json", () => {
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), "garrison-claudecfg-"));
    sandboxes.push(fakeHome);

    const prod = launcherEnv("prod", fakeHome);
    expect(prod.GARRISON_CLAUDE_HOME).toBe(path.join(fakeHome, ".claude"));
    expect(prod.CLAUDE_CONFIG_DIR || "").toBe("");
    expect(prod.GARRISON_CLAUDE_JSON).toBe(path.join(fakeHome, ".claude.json"));

    for (const profile of ["dev", "codex"]) {
      const env = launcherEnv(profile, fakeHome);
      expect(env.CLAUDE_CONFIG_DIR, `${profile} must redirect the CLI`).toBe(env.GARRISON_CLAUDE_HOME);
      expect(env.GARRISON_CLAUDE_JSON).toBe(path.join(env.GARRISON_CLAUDE_HOME, ".claude.json"));
    }
  });

  // systemd's PATH is minimal — it lacks everything a login profile supplies.
  // The launcher must therefore carry the user-level bin dirs itself, or the
  // http-gateway verify hook's `command -v claude` fails and `up` aborts. This
  // is invisible from an interactive shell, where the profile already added
  // them, so it only ever breaks under the service.
  it("puts the user-level bin dirs on PATH so verify hooks can find `claude`", () => {
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), "garrison-path-"));
    sandboxes.push(fakeHome);
    for (const profile of Object.keys(PROFILE_OFFSET)) {
      const launcherPath = launcherEnv(profile, fakeHome).PATH ?? "";
      const entries = launcherPath.split(":");
      for (const required of [`${fakeHome}/.local/bin`, `${fakeHome}/.bun/bin`]) {
        expect(entries, `${profile} PATH must contain ${required}`).toContain(required);
      }
      // node_modules/.bin keeps `next`/`concurrently` resolvable when the
      // launcher is invoked directly (systemd, garrison-redeploy.sh).
      expect(entries, `${profile} PATH must contain node_modules/.bin`).toContain(
        path.join(ROOT, "node_modules", ".bin")
      );
    }
  });

  // The launcher's offsets and the TypeScript module's offsets are two copies
  // of one fact; pin them together or a change to one silently splits the app
  // (which projects fitting ports) from the launcher (which binds the app).
  it("keeps the launcher's port offsets in step with src/lib/instance-profile.ts", async () => {
    const { PROFILE_PORT_OFFSET } = await import("@/lib/instance-profile");
    expect(PROFILE_PORT_OFFSET).toEqual(PROFILE_OFFSET);

    const launcherSource = readFileSync(LAUNCHER, "utf8");
    for (const [profile, offset] of Object.entries(PROFILE_OFFSET)) {
      expect(launcherSource, `${profile} offset must appear in the launcher`).toMatch(
        new RegExp(`PORT_OFFSET=${offset}\\b`)
      );
    }
  });

  // Only prod is published to the tailnet. Without this the serve-port formula
  // (8400 + port%1000) aliases prod's 80xx onto dev's 70xx and whichever
  // instance ran the script last owns the always-on address.
  it("refuses to publish a non-prod instance to the tailnet", () => {
    const script = path.join(ROOT, "scripts", "tailnet-serve-views.mjs");
    let failed = false;
    try {
      execFileSync("node", [script], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, GARRISON_INSTANCE_ID: "dev" },
        stdio: "pipe"
      });
    } catch (error: any) {
      failed = true;
      expect(String(error.stderr)).toContain("only prod is served");
    }
    expect(failed, "publishing a dev instance to the tailnet must fail").toBe(true);
  });

  // Two-instance topology on the dev box: THIS checkout is the PRIMARY (main)
  // instance — app :7777, gateway :4777, fittings 7xxx, real ~/.garrison — and
  // the committed compositions carry the primary scheme. The codex SECONDARY
  // instance runs from its own checkout; its isolation is the launcher ENV
  // (tested above) plus per-instance composition config there, never this
  // repo's committed composition values.
  it("keeps every effective default-composition listener on the primary family, off the codex ports", () => {
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
    ports.set(7777, "garrison-next");
    ports.set(3702, "outpost-host");

    // The codex secondary's reserved family (its launcher env + its checkout's
    // composition config): the primary composition must never squat these, or
    // the two instances cannot run side by side.
    const codexPorts = new Set([
      27777, 24777, 23702, 29512, 27999, 27077, 27079, 27082, 27083, 27084,
      27085, 27086, 27087, 27088, 27089, 27090, 27091, 27092, 27093, 27095,
      27096, 27098, 27099
    ]);
    for (const [port, owner] of ports) {
      expect(codexPorts.has(port), `${owner} squats codex port ${port}`).toBe(false);
    }
    expect(ports.get(7096)).toBe("drill");
    expect(ports.get(7089)).toBe("kanban-loop");
    expect(ports.get(4777)).toBe("http-gateway");
    expect(ports.get(7099)).toBe("scheduler");
  });

  it("keeps every shipped default profile on the primary state roots", () => {
    for (const profile of ["default", "default-build", "default-economy", "default-premium"]) {
      const composition = readYaml(path.join(ROOT, "compositions", profile, "apm.yml"));
      const selections = composition["x-garrison"].composition.selections as Record<
        string,
        Array<{ id: string; config?: Record<string, unknown> }>
      >;
      const config = (group: string, id: string) =>
        selections[group].find((entry) => entry.id === id)?.config;

      expect(config("memory", "basic-memory"), profile).toMatchObject({
        vault_dir: "~/ObsidianVault",
        project_name: "main",
        register_codex_gemini: false
      });
      // No automations_dir override: the primary default (~/.garrison/automations)
      // comes from the fitting itself, and a codex value here would silently
      // cross the instance boundary.
      expect(config("observability", "automations")?.automations_dir, profile).toBeUndefined();
      expect(config("observability", "improver")?.vault_dir, profile)
        .toBe("~/ObsidianVault");
      expect(config("observability", "scheduler"), profile).toMatchObject({
        jobs_file: "~/.garrison/scheduler-jobs.json",
        log_file: "~/.garrison/scheduler.log",
        health_port: 7099
      });
      expect(config("observability", "kanban-loop")?.board_dir, profile)
        .toBe("~/.garrison/kanban-loop");
      expect(config("sessions", "file-browser")?.root, profile)
        .toBe("~/.garrison/files");
      expect(config("sessions", "vault-git-sync")?.vault_dir, profile)
        .toBe("~/ObsidianVault");
      expect(config("surfaces", "outpost-tailscale-host")?.outpost_host_url, profile)
        .toBe("http://127.0.0.1:3702");
      const codexLeak = JSON.stringify(selections).includes(".garrison-codex");
      expect(codexLeak, `${profile} references the codex home`).toBe(false);
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
