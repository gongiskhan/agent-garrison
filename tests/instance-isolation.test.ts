import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
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
  // The port-family rule exists so that a PER-INSTANCE fitting, once shifted by
  // its profile offset, cannot land on another instance"s port. coord-agentmail
  // is the opposite by construction: ONE agent-coordination server shared by
  // every project and every instance, registered user-scope in ~/.claude.json so
  // a bare `claude` run in any repo reaches the same address. Shifting it per
  // profile would give each instance its own island and defeat the fitting. Its
  // 28765 is therefore deliberate, not codex-family debt.
  const SHARED_SINGLETON_PORTS = new Set(["coord-agentmail"]);

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
      // Only the uv CACHE is per-instance; UV_TOOL_DIR/UV_TOOL_BIN_DIR are
      // deliberately SHARED (see the shared-tooling assertion below).
      "UV_CACHE_DIR",
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

  // uv TOOLS are shared for the same reason the Claude CLI is: they are
  // binaries, not per-instance state, and `uv tool install` writes a global
  // ~/.local/bin shim regardless. Projecting them per instance only pretended
  // to isolate them — it was inert (no instance ever populated $GARRISON_HOME/uv)
  // and would have meant one copy per instance still fighting over one shim.
  it("shares the uv tool dirs across instances while keeping the cache per-instance", () => {
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), "garrison-uv-"));
    sandboxes.push(fakeHome);

    for (const profile of Object.keys(PROFILE_OFFSET)) {
      const env = launcherEnv(profile, fakeHome);
      expect(env.UV_TOOL_DIR, `${profile} uv tools shared`).toBe(
        path.join(fakeHome, ".local", "share", "uv", "tools")
      );
      expect(env.UV_TOOL_BIN_DIR, `${profile} uv shims shared`).toBe(
        path.join(fakeHome, ".local", "bin")
      );
      // The cache stays per-instance — it IS disposable per-instance state.
      expect(env.UV_CACHE_DIR.startsWith(env.GARRISON_HOME + path.sep)).toBe(true);
    }
  });

  // The Claude CLI binary is SHARED, never owned by one instance. Its installer
  // writes to $XDG_DATA_HOME/claude/versions/<v> but repoints the GLOBAL
  // ~/.local/bin/claude, so isolating XDG_DATA_HOME without pointing the claude
  // subdir at a shared location lets whichever instance last updated capture the
  // user's binary inside its home — resetting that home would then break every
  // other instance and the user's own Claude Code.
  it("points each instance's XDG claude data dir at the shared, instance-neutral location", () => {
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), "garrison-claudedata-"));
    sandboxes.push(fakeHome);
    const shared = path.join(fakeHome, ".local", "share", "claude");

    for (const profile of Object.keys(PROFILE_OFFSET)) {
      const env = launcherEnv(profile, fakeHome);
      const linkPath = path.join(env.XDG_DATA_HOME, "claude");
      expect(existsSync(linkPath), `${profile}: ${linkPath} should exist`).toBe(true);
      expect(lstatSync(linkPath).isSymbolicLink(), `${profile}: must be a symlink`).toBe(true);
      expect(realpathSync(linkPath), `${profile}: must resolve to the shared dir`).toBe(
        realpathSync(shared)
      );
      // The whole point: the resolved payload is NOT inside any Garrison home.
      expect(realpathSync(linkPath).startsWith(env.GARRISON_HOME + path.sep)).toBe(false);
    }
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

  // main's rule was prod-ONLY, because its serve-port formula (8400 + port%1000)
  // aliased prod's 80xx onto dev's 70xx - both wanted 8486 - so whichever
  // instance ran last owned the always-on address. The two-tree split (dev 7xxx
  // / prod 8xxx) changed the formula to the identity: the serve port IS the
  // local port, so dev and prod publish disjoint numbers and cannot take each
  // other's address. dev is therefore allowed; any OTHER profile (codex, whose
  // +20000 offset would still alias) is still refused.
  //
  // NOTE: this relaxes a rule main introduced. It is safe on main's own stated
  // terms (the aliasing is gone), but it does newly expose the dev tree on the
  // tailnet, which is a policy call - flagged for review on merge-back.
  it("refuses to publish an aliasing (non-prod, non-dev) instance to the tailnet", () => {
    const script = path.join(ROOT, "scripts", "tailnet-serve-views.mjs");
    let failed = false;
    try {
      execFileSync("node", [script], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, GARRISON_INSTANCE_ID: "codex" },
        stdio: "pipe"
      });
    } catch (error: any) {
      failed = true;
      expect(String(error.stderr)).toContain("only prod is served");
    }
    expect(failed, "publishing a codex instance to the tailnet must fail").toBe(true);
  });

  // The identity formula is what makes the relaxation above safe. If anyone
  // reinstates an offset-based serve port, dev and prod alias again and the
  // prod-only guard must come back with it.
  it("maps each own-port view to its own local port number on the tailnet", () => {
    const source = readFileSync(
      path.join(ROOT, "scripts", "tailnet-serve-views.mjs"),
      "utf8"
    );
    expect(source).toContain("function pickServePort(localPort, used) {");
    expect(source).toContain("let p = localPort;");
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

  // The assertion above resolves `selected.config?.port ?? metadata.default_port`
  // — and since every own-port selection carries an explicit port, the
  // `?? default_port` branch never executed and the declared defaults went
  // unchecked. They had all drifted to the codex family (base + 20000), so any
  // spawn that failed to project a port bound the CODEX instance's port. That is
  // not hypothetical: a dev-profile drill was found live on 0.0.0.0:27096,
  // squatting the port of the codex instance running on the same box.
  //
  // The fallback is what gets used precisely when something has gone wrong, so
  // pin it directly rather than through the config that normally shadows it.
  it("keeps every own-port fitting's declared default_port on the base family, matching the composition", () => {
    const composition = readYaml(path.join(ROOT, "compositions", "default", "apm.yml"));
    const selections = composition["x-garrison"].composition.selections as Record<
      string,
      Array<{ id: string; config?: Record<string, unknown> }>
    >;
    const declaredPort = new Map<string, number>();
    for (const entries of Object.values(selections)) {
      for (const selected of entries ?? []) {
        const port = selected.config?.port;
        if (typeof port === "number") declaredPort.set(selected.id, port);
      }
    }

    const seedDir = path.join(ROOT, "fittings", "seed");
    const fittingIds = readdirSync(seedDir).filter((id) =>
      existsSync(path.join(seedDir, id, "apm.yml"))
    );
    let checked = 0;

    for (const id of fittingIds) {
      const metadata = readYaml(path.join(seedDir, id, "apm.yml"))["x-garrison"] ?? {};
      if (metadata.own_port !== true) continue;
      const declared = metadata.default_port;
      if (declared === undefined) continue;
      // coord-agentmail sits OUTSIDE the offset model entirely: 28765 is not a
      // base port and no composition declares one for it, so all three
      // instances resolve the same listener. That is a real isolation gap, but
      // the port is baked into MCP registrations held by other sessions, so
      // moving it is a deliberate migration rather than a rename. Exempted
      // explicitly, not silently, so it stays visible.
      if (id === "coord-agentmail") continue;
      checked++;

      // The offset model only works if the declared value is a BASE port: every
      // profile is the committed map plus its offset, so a default already
      // carrying an offset resolves into another instance's range.
      expect(
        declared,
        `${id}: default_port ${declared} is in another instance's family; it must be a base (7xxx) port`
      ).toBeLessThan(20000);

      const base = declaredPort.get(id);
      if (base !== undefined) {
        expect(
          declared,
          `${id}: default_port ${declared} disagrees with the composition's ${base}, so an unprojected start binds a different port than a projected one`
        ).toBe(base);
      }
    }

    expect(checked, "expected own-port fittings to be discovered").toBeGreaterThan(10);
  });

  // The THIRD copy of every port, and the last one to be re-baselined: a
  // Fitting's `config_schema` default. `defaultConfigForEntry` (src/lib/compositions.ts)
  // copies these verbatim into a composition when a Fitting is stationed, and the
  // offset is applied to the STORED value later — so a codex-family schema default
  // is written into the new composition and then shifted AGAIN (24777 -> 25777 on
  // prod, 44777 on codex), landing in no instance's range at all. 17 values across
  // 15 manifests had drifted while `default_port` was already correct, i.e. the two
  // halves of the same manifest disagreed. Nothing read the schema defaults in the
  // committed compositions (every selection pins its port), so this was invisible
  // until someone composed a fresh Operative.
  it("keeps every config_schema port/URL default on the base family and agreeing with default_port", () => {
    const seedDir = path.join(ROOT, "fittings", "seed");
    // See the coord-agentmail exemption note above — same Fitting, same reason.
    const EXEMPT = new Set(["coord-agentmail"]);
    const PORT_KEY = /^(port|.*_port)$/;
    const offenders: string[] = [];
    let checked = 0;

    for (const id of readdirSync(seedDir)) {
      const manifestPath = path.join(seedDir, id, "apm.yml");
      if (!existsSync(manifestPath) || EXEMPT.has(id)) continue;
      const metadata = readYaml(manifestPath)["x-garrison"] ?? {};
      const schema = (metadata.config_schema ?? []) as Array<{ key?: string; default?: unknown }>;

      for (const field of schema) {
        const key = String(field.key ?? "");
        const value = field.default;

        if (PORT_KEY.test(key) && typeof value === "number") {
          checked++;
          if (value >= 20000) {
            offenders.push(
              `${id}: config_schema ${key} default ${value} is in another instance's family — ` +
                `declare the base port and let the profile offset shift it`
            );
          }
          const declared = metadata.default_port;
          if (typeof declared === "number" && key === "port" && value !== declared) {
            offenders.push(
              `${id}: config_schema port default ${value} disagrees with default_port ${declared} ` +
                `in the same manifest`
            );
          }
        }

        // A URL default naming a loopback peer carries a port too, and gets the
        // same double-shift treatment.
        if (typeof value === "string") {
          const match = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d{4,5})/.exec(value);
          if (match) {
            checked++;
            if (Number(match[1]) >= 20000) {
              offenders.push(
                `${id}: config_schema ${key} default ${value} names another instance's port`
              );
            }
          }
        }
      }
    }

    expect(offenders, offenders.join("\n")).toEqual([]);
    expect(checked, "expected port/URL schema defaults to be discovered").toBeGreaterThan(10);
  });

  // Companion to the above: the manifest is only half the fallback. Each server
  // script carries its own literal, and the two drifting apart reintroduces the
  // same bug from the other side.
  it("keeps each own-port server script's fallback literal off the other instances' families", () => {
    const seedDir = path.join(ROOT, "fittings", "seed");
    // See the exemption note above.
    const EXEMPT = new Set(["coord-agentmail"]);
    const offenders: string[] = [];
    for (const id of readdirSync(seedDir)) {
      if (EXEMPT.has(id)) continue;
      const scriptsDir = path.join(seedDir, id, "scripts");
      if (!existsSync(scriptsDir)) continue;
      for (const file of readdirSync(scriptsDir).filter((f) => f.endsWith(".mjs"))) {
        const source = readFileSync(path.join(scriptsDir, file), "utf8");
        for (const raw of source.split("\n")) {
          const line = raw.trim();
          // Comments are prose: discussing the codex family is legal.
          if (line.startsWith("//") || line.startsWith("*")) continue;
          // Durations share the 5-digit shape; only PORT-bearing positions count.
          if (/_MS\b|TIMEOUT|INTERVAL|DELAY/i.test(line)) continue;
          const match = line.match(
            /[A-Z_]*PORT[A-Z_]*\s*=\s*(?:Number\()?(\d{5})\b|[A-Z_]*PORT[A-Z_]*\s*(?:\|\||\?\?)\s*"?(\d{5})\b|\bport:\s*(\d{5})\b|127\.0\.0\.1:(\d{5})\b/
          );
          const value = match && Number(match[1] ?? match[2] ?? match[3] ?? match[4]);
          if (value && value >= 20000) offenders.push(`${id}/scripts/${file}: ${line}`);
        }
      }
    }
    expect(offenders, `fallback ports must be base-family values:\n${offenders.join("\n")}`).toEqual(
      []
    );
  });

  // The guard above discriminates by MAGNITUDE (5 digits, >= 20000), so it only ever
  // caught the codex family. `http://127.0.0.1:4777` — the DEV gateway — sailed
  // through it twice, in the kanban tick and the kanban board server, and the prod
  // scheduler tick spent weeks pinging another instance's gateway as a result: every
  // 2 minutes it logged "gateway not reachable" and dispatched, advanced and swept
  // nothing. On dev the literal happened to be correct, so nothing ever surfaced it.
  //
  // Magnitude is the wrong axis. What matters is the ROLE of the literal:
  //   • defaulting your OWN listen port to the base family is fine (and is positively
  //     asserted elsewhere in this file) — the launcher shifts it per profile;
  //   • defaulting ANOTHER process's address (a gateway, an app base URL, an outpost
  //     host) is a GUESS about which instance you belong to. There is no safe guess:
  //     be told, or fail loudly.
  //
  // KNOWN_PEER_ADDRESS_LITERALS is a ratchet, not an approval. Every entry is a live
  // instance of this bug in a fitting that has not been audited yet. Do not add to it
  // to make a new literal pass — remove the literal instead.
  it("no fitting GUESSES another instance's address with a port literal", () => {
    const KNOWN_PEER_ADDRESS_LITERALS = new Set([
      "automations/scripts/server.mjs",
      "automations/lib/planner.mjs",
      "automations/lib/fixer.mjs",
      "automations/lib/engine.mjs",
      // loop-heartbeat/scripts/heartbeat.mjs retired from this ratchet: its
      // literal is gone. It now fails loudly when GARRISON_GATEWAY_URL is
      // absent, and its setup hook bakes this instance's address into the
      // registered job command.
      "dev-env/scripts/server.mjs",
      "drill/lib/curation.mjs",
      "drill/assets/drill-judge.ts"
    ]);
    // An env var naming a PEER service, not this process's own port.
    const PEER =
      /\b(GARRISON_GATEWAY_URL|GARRISON_GATEWAY_PORT|GARRISON_OUTPOST_URL|[A-Z_]*_HOST_URL|[A-Z_]*_BASE_URL|[A-Z_]*_GATEWAY_URL)\b/;
    const LITERAL = /127\.0\.0\.1:(\d{4,5})|\|\|\s*"?(\d{4,5})"?\s*[`)]/;

    const seedDir = path.join(ROOT, "fittings", "seed");
    const offenders: string[] = [];
    const walk = (dir: string, rel: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        const abs = path.join(dir, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { walk(abs, relPath); continue; }
        if (!/\.(mjs|ts|tsx)$/.test(entry.name)) continue;
        const source = readFileSync(abs, "utf8");
        source.split("\n").forEach((raw) => {
          const line = raw.trim();
          if (line.startsWith("//") || line.startsWith("*")) return; // prose may cite ports
          if (!PEER.test(line) || !LITERAL.test(line)) return;
          if (KNOWN_PEER_ADDRESS_LITERALS.has(relPath)) return; // known debt, ratcheted
          offenders.push(`${relPath}: ${line}`);
        });
      }
    };
    walk(seedDir, "");

    expect(
      offenders,
      "A fitting must be TOLD a peer's address (env projected by the runner), never guess it " +
        "from a port literal — the guess names one instance and silently sends another " +
        "instance's traffic there:\n" + offenders.join("\n")
    ).toEqual([]);
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

  // The test above reads only `default`, which is how compositions/jarvis
  // shipped kanban-loop with no `port` at all: it silently fell back to the
  // fitting's default_port, which was itself the CODEX value (27089). Every
  // profile therefore bound the same port and dev could not run the board
  // while prod held it. This covers every shipped composition instead.
  it("resolves every own-port fitting in every composition onto the committed base family", () => {
    const compositionDirs = readdirSync(path.join(ROOT, "compositions"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    // Compositions written FOR the codex secondary instance are deliberately on
    // the +20000 family — there those ports are the correct ones. Their
    // listeners are still checked for collisions with each other, just not for
    // membership of the primary family.
    // Compositions that deliberately SPAN instances, so a codex-family (2xxxx)
    // port in them is the point rather than a numbering slip. csg ("CSG
    // (all-Cursor)") is one: it commits 7083/7087/7089/4777 alongside
    // 27086/27091/27093/28765 on purpose, same genre as codex-mixed-proof.
    const SECONDARY_COMPOSITIONS = new Set([
      "secondary-minimal",
      "codex-mixed-proof-20260716",
      "csg"
    ]);

    expect(compositionDirs.length).toBeGreaterThan(0);

    for (const name of compositionDirs) {
      const file = path.join(ROOT, "compositions", name, "apm.yml");
      if (!existsSync(file)) continue;
      const composition = readYaml(file);
      const selections = (composition["x-garrison"]?.composition?.selections ?? {}) as Record<
        string,
        Array<{ id: string; config?: Record<string, unknown> }>
      >;

      const seen = new Map<number, string>();
      for (const entries of Object.values(selections)) {
        for (const selected of entries ?? []) {
          const fittingFile = path.join(ROOT, "fittings", "seed", selected.id, "apm.yml");
          if (!existsSync(fittingFile)) continue;
          const metadata = readYaml(fittingFile)["x-garrison"] ?? {};
          if (metadata.own_port !== true) continue;

          // The port MUST come from the composition config. Only composition
          // config is passed through applyPortOffsetToConfig and projected into
          // the fitting's env (runner.ts ownPortConfigEnv); `default_port` is
          // informational and never reaches the process. So an own-port fitting
          // that omits `port` binds its hardcoded default UNSHIFTED in every
          // profile — dev and prod collide by construction.
          expect(
            Number.isInteger(Number(selected.config?.port)),
            `${name}/${selected.id} is own-port but declares no \`port\` in its ` +
              `composition config, so every profile would bind its default_port ` +
              `(${metadata.default_port}) unshifted`
          ).toBe(true);

          const effective = Number(selected.config?.port);

          // A committed port must be a DEV-family port, because dev's offset is
          // 0 — the committed value IS the dev value and every other profile is
          // that value shifted. A committed 2xxxx is a codex port that no
          // offset can move out of the way.
          expect(
            SECONDARY_COMPOSITIONS.has(name) ||
              SHARED_SINGLETON_PORTS.has(selected.id) ||
              effective < 20000,
            `${name}/${selected.id} commits ${effective}, which is outside the base family — ` +
              `prod and dev would both bind it`
          ).toBe(true);

          expect(
            seen.has(effective),
            `${name}/${selected.id} collides with ${seen.get(effective)} on ${effective}`
          ).toBe(false);
          seen.set(effective, selected.id);
        }
      }
    }
  });

  // 2026-07-21: THIRTEEN seeds still carried codex-family (2xxxx) default
  // ports — legacy of this checkout’s codex-secondary past. A 2xxxx default is
  // never right in a committed seed: dev’s offset is 0, so the committed value
  // is what every profile starts from, and no offset moves 27xxx out of the
  // codex range. The sweep renumbered them all (-20000); this pins the family.
  it("keeps every seed fitting’s canonical port in the base family", () => {
    for (const id of readdirSync(path.join(ROOT, "fittings", "seed"))) {
      const apmFile = path.join(ROOT, "fittings", "seed", id, "apm.yml");
      if (!existsSync(apmFile)) continue;
      const meta = readYaml(apmFile)["x-garrison"] ?? {};
      const schema = Array.isArray(meta.config_schema)
        ? meta.config_schema.find((entry: { key?: string }) => entry?.key === "port")
        : undefined;
      const canonical =
        typeof meta.default_port === "number" ? meta.default_port : schema?.default;
      if (typeof canonical !== "number") continue;
      if (SHARED_SINGLETON_PORTS.has(id)) continue;
      expect(
        canonical < 20000,
        `${id} claims canonical port ${canonical} — codex family; commit the base (7xxx) value`
      ).toBe(true);
    }
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

  // The outpost daemon URL is instance-specific (dev 3702 / prod 4702 / codex
  // 23702). Three sites baked the CODEX literal into code every profile runs,
  // so on dev and prod the kanban engine probed a daemon that does not exist,
  // `outposts` came back empty, and EVERY card with an `outpost` affinity parked
  // as "outpost offline" — the failure looked like a dead Mac, not a wrong port.
  it("resolves the outpost daemon URL from config, never from a baked-in port", () => {
    const engine = readFileSync(
      path.join(ROOT, "fittings", "seed", "kanban-loop", "lib", "engine.mjs"),
      "utf8"
    );
    const dispatch = readFileSync(
      path.join(ROOT, "fittings", "seed", "kanban-loop", "lib", "outpost-dispatch.mjs"),
      "utf8"
    );
    const hostDaemon = readFileSync(path.join(ROOT, "scripts", "outpost-host.mjs"), "utf8");

    // No profile-specific literal survives in code any profile executes.
    for (const [name, source] of [
      ["engine.mjs", engine],
      ["outpost-dispatch.mjs", dispatch]
    ] as const) {
      expect(source.includes("23702"), `${name} hardcodes the codex outpost port`).toBe(false);
      expect(source.includes("4702"), `${name} hardcodes the prod outpost port`).toBe(false);
      expect(source.includes("3702"), `${name} hardcodes an outpost port`).toBe(false);
    }

    // The engine reads the projected composition key.
    expect(engine).toContain("GARRISON_KANBANLOOP_OUTPOST_HOST_URL");

    // The bare-run fallback in the daemon is the BASE of the family (dev), per
    // instance-profile.ts's "an unset profile IS dev" doctrine — not codex.
    expect(hostDaemon).toContain('process.env.GARRISON_OUTPOST_PORT || "3702"');
    expect(hostDaemon).not.toContain("23702");
  });

  it("declares outpost_host_url in every composition that stations kanban-loop", () => {
    const compositionsDir = path.join(ROOT, "compositions");
    let checked = 0;
    for (const id of readdirSync(compositionsDir)) {
      const manifest = path.join(compositionsDir, id, "apm.yml");
      if (!existsSync(manifest)) continue;
      const doc = yaml.load(readFileSync(manifest, "utf8")) as Record<string, unknown>;
      const composition = (doc?.["x-garrison"] as Record<string, unknown> | undefined)
        ?.composition as Record<string, unknown> | undefined;
      const selections = composition?.selections as
        | Record<string, Array<{ id?: string; config?: Record<string, unknown> }>>
        | undefined;
      if (!selections) continue;
      for (const entries of Object.values(selections)) {
        for (const entry of entries ?? []) {
          if (entry?.id !== "kanban-loop") continue;
          checked += 1;
          // Base-family value: shiftLoopbackUrl rewrites the loopback port per
          // profile, so the committed literal must be the 3702 base.
          expect(entry.config?.outpost_host_url, `${id} kanban-loop`).toBe("http://127.0.0.1:3702");
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
