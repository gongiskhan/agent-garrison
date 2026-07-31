// Slice G3 - the basic-memory backend switch (`backend: local | cortex`).
//
// Drives the REAL setup.sh as the runner does: the fitting is copied into a
// sandbox composition (<tmp>/comp/apm_modules/_local/basic-memory), the
// scheduler fitting is copied in beside it, and `apm install` is simulated by
// placing the local SKILL.md where APM puts it. The external CLIs the hook
// talks to (basic-memory, claude, codex, gemini, uv) are STUBS on a shadowing
// PATH that record their argv and keep just enough state to answer
// `mcp get` / `project info` - so the test can assert the exact CLI
// conversation, not just its side effects, and can never touch the real
// ~/.claude or the developer's real MCP registrations.
//
// The load-bearing claim is hard rule 6: with `backend` absent or `local`, the
// artifacts are the ones the pre-switch fitting produced, pinned literally
// below rather than compared against a moving baseline.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..");
const FITTING_SRC = path.join(REPO_ROOT, "fittings", "seed", "basic-memory");
const SCHEDULER_SRC = path.join(
  REPO_ROOT,
  "fittings",
  "seed",
  "scheduler",
  "scripts",
  "scheduler.mjs"
);
const LOCAL_SKILL_SRC = path.join(FITTING_SRC, ".apm", "skills", "garrison-memory", "SKILL.md");
const CORTEX_SKILL_SRC = path.join(FITTING_SRC, "skill-variants", "cortex", "SKILL.md");

const FLUSH_JOB_ID = "basic-memory-spool-flush";

/** A stub CLI: logs its argv, then answers the few state questions setup.sh asks. */
function stub(name: string, body: string): string {
  return `#!/bin/sh\nprintf '${name} %s\\n' "$*" >> "$STUB_LOG"\n${body}\nexit 0\n`;
}

const STUBS: Record<string, string> = {
  uv: stub("uv", ""),
  "basic-memory": stub(
    "basic-memory",
    `case "$1 $2" in
  "project info") [ -f "$STUB_STATE/bm-project-$3" ] && exit 0 || exit 1 ;;
  "project add") : > "$STUB_STATE/bm-project-$3"; exit 0 ;;
esac`
  ),
  claude: stub(
    "claude",
    `if [ "$1" = "mcp" ]; then
  case "$2" in
    get) [ -f "$STUB_STATE/claude-mcp-$3" ] && exit 0 || exit 1 ;;
    add) : > "$STUB_STATE/claude-mcp-basic-memory"; exit 0 ;;
    remove) rm -f "$STUB_STATE/claude-mcp-basic-memory"; exit 0 ;;
  esac
fi`
  ),
  codex: stub(
    "codex",
    `if [ "$1" = "mcp" ]; then
  case "$2" in
    get) [ -f "$STUB_STATE/codex-mcp-$3" ] && exit 0 || exit 1 ;;
    add) : > "$STUB_STATE/codex-mcp-basic-memory"; exit 0 ;;
    remove) rm -f "$STUB_STATE/codex-mcp-basic-memory"; exit 0 ;;
  esac
fi`
  ),
  gemini: stub(
    "gemini",
    `if [ "$1" = "mcp" ]; then
  case "$2" in
    list) [ -f "$STUB_STATE/gemini-mcp-basic-memory" ] && echo "basic-memory"; exit 0 ;;
    add) : > "$STUB_STATE/gemini-mcp-basic-memory"; exit 0 ;;
    remove) rm -f "$STUB_STATE/gemini-mcp-basic-memory"; exit 0 ;;
  esac
fi`
  )
};

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

describe("basic-memory backend switch", () => {
  let tmp: string;
  let home: string;
  let claudeHome: string;
  let vault: string;
  let comp: string;
  let fitting: string;
  let setupPath: string;
  let verifyPath: string;
  let binDir: string;
  let stubLog: string;
  let stubState: string;
  let jobsFile: string;
  let installedSkillPath: string;
  let bmBin: string;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-bm-backend-"));
    home = path.join(tmp, "home");
    claudeHome = path.join(home, ".claude");
    vault = path.join(tmp, "vault");
    comp = path.join(tmp, "comp");
    fitting = path.join(comp, "apm_modules", "_local", "basic-memory");
    setupPath = path.join(fitting, "scripts", "setup.sh");
    verifyPath = path.join(fitting, "scripts", "verify.sh");
    binDir = path.join(tmp, "bin");
    stubLog = path.join(tmp, "stub-calls.log");
    stubState = path.join(tmp, "stub-state");
    jobsFile = path.join(tmp, "scheduler-jobs.json");
    installedSkillPath = path.join(comp, ".claude", "skills", "garrison-memory", "SKILL.md");
    bmBin = path.join(binDir, "basic-memory");

    await fsp.mkdir(home, { recursive: true });
    await fsp.mkdir(stubState, { recursive: true });
    await fsp.mkdir(binDir, { recursive: true });
    for (const [name, body] of Object.entries(STUBS)) {
      await fsp.writeFile(path.join(binDir, name), body, { mode: 0o755 });
    }

    // The installed composition: the fitting under apm_modules/_local, the
    // scheduler beside it, and APM's skill install already done.
    await fsp.mkdir(path.dirname(fitting), { recursive: true });
    await fsp.cp(FITTING_SRC, fitting, { recursive: true });
    const schedulerDir = path.join(comp, "apm_modules", "_local", "scheduler", "scripts");
    await fsp.mkdir(schedulerDir, { recursive: true });
    await fsp.cp(SCHEDULER_SRC, path.join(schedulerDir, "scheduler.mjs"));
    await fsp.mkdir(path.dirname(installedSkillPath), { recursive: true });
    await fsp.cp(LOCAL_SKILL_SRC, installedSkillPath);
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  function runHook(script: string, overrides: Record<string, string | undefined> = {}) {
    // Start from the ambient env MINUS everything that could leak this
    // developer's real memory/Claude/provider config into the sandbox.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (/^(BASIC_MEMORY_|GARRISON_|CLAUDE_|CORTEX_|REMOTE_MEMORY_|STUB_)/.test(key)) continue;
      env[key] = value;
    }
    Object.assign(env, {
      HOME: home,
      PATH: `${binDir}:${env.PATH ?? ""}`,
      GARRISON_CLAUDE_HOME: claudeHome,
      GARRISON_HOME: path.join(tmp, "garrison-home"),
      GARRISON_SCHEDULER_JOBS: jobsFile,
      GARRISON_SCHEDULER_LOG: path.join(tmp, "scheduler.log"),
      BASIC_MEMORY_VAULT_DIR: vault,
      STUB_LOG: stubLog,
      STUB_STATE: stubState
    });
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    return spawnSync("bash", [script], {
      env: env as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 120_000
    });
  }

  const runSetup = (overrides: Record<string, string | undefined> = {}) =>
    runHook(setupPath, overrides);
  const runVerify = (overrides: Record<string, string | undefined> = {}) =>
    runHook(verifyPath, overrides);

  function calls(): string[] {
    if (!fs.existsSync(stubLog)) return [];
    return fs.readFileSync(stubLog, "utf8").trim().split("\n").filter(Boolean);
  }
  function clearCalls(): void {
    fs.rmSync(stubLog, { force: true });
  }
  function settings(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(claudeHome, "settings.json"), "utf8"));
  }
  function hookCommand(): string {
    const hooks = (settings() as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> })
      .hooks;
    return hooks.SessionEnd[0].hooks[0].command;
  }
  function jobs(): Array<{ id: string; cron: string; command: string }> {
    if (!fs.existsSync(jobsFile)) return [];
    return JSON.parse(fs.readFileSync(jobsFile, "utf8"));
  }
  function drainJob() {
    return jobs().find((job) => job.id === FLUSH_JOB_ID);
  }
  function installedSkill(): string {
    return fs.readFileSync(installedSkillPath, "utf8");
  }

  /** The capture-hook command the pre-switch fitting wrote - pinned literally. */
  const stockHookCommand = () =>
    `BASIC_MEMORY_VAULT_DIR="${vault}" BASIC_MEMORY_MEMORY_DIR="Memory" ` +
    `python3 "${path.join(claudeHome, "basic-memory", "capture-session.py")}"`;

  /** The exact CLI conversation the pre-switch fitting had on a first run. */
  const stockCalls = () => [
    "basic-memory --version",
    "basic-memory project info main",
    `basic-memory project add main ${vault}`,
    "basic-memory project default main",
    "claude mcp get basic-memory",
    `claude mcp add -s user basic-memory -- ${bmBin} mcp`,
    "codex mcp get basic-memory",
    `codex mcp add basic-memory -- ${bmBin} mcp`,
    "gemini mcp list",
    `gemini mcp add -s user basic-memory ${bmBin} mcp`
  ];

  describe("default backend (hard rule 6)", () => {
    it("with the key ABSENT, installs exactly the pre-switch artifacts and nothing else", () => {
      const result = runSetup();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);

      // 1. The registered MCP servers: all three CLIs, same argv as before.
      expect(calls()).toEqual(stockCalls());

      // 2. The installed hook command: byte-for-byte the historical one, with
      // no spool env prefix.
      expect(settings()).toEqual({
        hooks: {
          SessionEnd: [
            {
              matcher: "",
              hooks: [{ type: "command", command: stockHookCommand(), timeout: 10 }]
            }
          ],
          PreCompact: [
            {
              matcher: "",
              hooks: [{ type: "command", command: stockHookCommand(), timeout: 10 }]
            }
          ]
        }
      });

      // 3. No drain job, and no drain script staged.
      expect(fs.existsSync(jobsFile)).toBe(false);
      expect(fs.existsSync(path.join(claudeHome, "basic-memory", "flush-spool.mjs"))).toBe(false);

      // 4. The stock SKILL.md APM installed is untouched.
      expect(installedSkill()).toBe(fs.readFileSync(LOCAL_SKILL_SRC, "utf8"));
      expect(installedSkill()).not.toContain("garrison-memory-backend");
      expect(fs.readdirSync(path.dirname(installedSkillPath))).toEqual(["SKILL.md"]);

      // 5. verify passes unconfigured.
      const verified = runVerify();
      expect(verified.status).toBe(0);
      expect(verified.stdout.trim().endsWith("ok")).toBe(true);
    });

    it("an explicit backend=local is the same run as the key being absent", () => {
      const absent = runSetup();
      expect(absent.status).toBe(0);
      const absentCalls = calls();
      const absentSettings = settings();
      const absentSkill = installedSkill();

      // Fresh state, same sandbox, explicit key.
      fs.rmSync(stubState, { recursive: true, force: true });
      fs.mkdirSync(stubState, { recursive: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
      clearCalls();

      const explicit = runSetup({ BASIC_MEMORY_BACKEND: "local" });
      expect(explicit.status).toBe(0);
      expect(calls()).toEqual(absentCalls);
      expect(settings()).toEqual(absentSettings);
      expect(installedSkill()).toBe(absentSkill);
      expect(fs.existsSync(jobsFile)).toBe(false);
    });
  });

  describe("backend: cortex", () => {
    it("skips MCP registration on all three CLIs and installs the cortex skill variant", () => {
      const result = runSetup({ BASIC_MEMORY_BACKEND: "cortex" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);

      expect(calls().filter((line) => line.includes("mcp add"))).toEqual([]);
      expect(fs.existsSync(path.join(stubState, "claude-mcp-basic-memory"))).toBe(false);
      expect(fs.existsSync(path.join(stubState, "codex-mcp-basic-memory"))).toBe(false);
      expect(fs.existsSync(path.join(stubState, "gemini-mcp-basic-memory"))).toBe(false);

      expect(installedSkill()).toBe(fs.readFileSync(CORTEX_SKILL_SRC, "utf8"));
      expect(installedSkill()).toContain("garrison-memory-backend: cortex");
      // The capture hook still runs - it is the spool's source.
      expect(hookCommand()).toContain("capture-session.py");

      const verified = runVerify({ BASIC_MEMORY_BACKEND: "cortex" });
      expect(verified.status).toBe(0);
      expect(verified.stdout.trim().endsWith("ok")).toBe(true);
    });

    it("verify infers the backend from the installed skill, since the runner does not project config into verify hooks", () => {
      // runner.verify() passes only the gateway env to a verify hook, so
      // BASIC_MEMORY_BACKEND is absent in production. Verify must therefore key
      // on what setup actually installed, or a cortex composition would fail
      // its own verify demanding an MCP server it deliberately did not register.
      expect(runSetup({ BASIC_MEMORY_BACKEND: "cortex" }).status).toBe(0);
      const cortexVerify = runVerify();
      expect(cortexVerify.stderr).toBe("");
      expect(cortexVerify.status).toBe(0);

      expect(runSetup().status).toBe(0);
      const localVerify = runVerify();
      expect(localVerify.stderr).toBe("");
      expect(localVerify.status).toBe(0);
    });

    it("retires an MCP registration a previous local run left behind", () => {
      expect(runSetup().status).toBe(0);
      expect(fs.existsSync(path.join(stubState, "claude-mcp-basic-memory"))).toBe(true);
      clearCalls();

      expect(runSetup({ BASIC_MEMORY_BACKEND: "cortex" }).status).toBe(0);
      const removals = calls().filter((line) => line.includes("mcp remove"));
      expect(removals).toEqual([
        "claude mcp remove -s user basic-memory",
        "codex mcp remove basic-memory",
        "gemini mcp remove basic-memory"
      ]);
      expect(fs.existsSync(path.join(stubState, "claude-mcp-basic-memory"))).toBe(false);
      expect(fs.existsSync(path.join(stubState, "codex-mcp-basic-memory"))).toBe(false);
      expect(fs.existsSync(path.join(stubState, "gemini-mcp-basic-memory"))).toBe(false);

      // verify now FAILS if the registration somehow survives.
      fs.writeFileSync(path.join(stubState, "claude-mcp-basic-memory"), "");
      const verified = runVerify({ BASIC_MEMORY_BACKEND: "cortex" });
      expect(verified.status).toBe(1);
      expect(verified.stderr).toContain("still registered with Claude Code");
    });
  });

  describe("spool precedence: `auto` follows the backend, explicit beats it", () => {
    it("local + auto (the defaults): nothing spooled, no drain job", () => {
      expect(runSetup().status).toBe(0);
      expect(hookCommand()).toBe(stockHookCommand());
      expect(hookCommand()).not.toContain("BASIC_MEMORY_SPOOL_ENABLED");
      expect(drainJob()).toBeUndefined();
      expect(fs.existsSync(jobsFile)).toBe(false);
    });

    it("local + always: the pre-switch opt-in still turns the spool on", () => {
      expect(runSetup({ BASIC_MEMORY_SPOOL_ENABLED: "always" }).status).toBe(0);
      expect(hookCommand()).toContain("BASIC_MEMORY_SPOOL_ENABLED=1");
      const job = drainJob();
      expect(job).toBeDefined();
      expect(job!.cron).toBe("*/15 * * * *");
      expect(job!.command).toContain("flush-spool.mjs");
      expect(fs.existsSync(path.join(claudeHome, "basic-memory", "flush-spool.mjs"))).toBe(true);
    });

    it("local + a legacy boolean true is still read as an explicit opt-in", () => {
      expect(runSetup({ BASIC_MEMORY_SPOOL_ENABLED: "true" }).status).toBe(0);
      expect(hookCommand()).toContain("BASIC_MEMORY_SPOOL_ENABLED=1");
      expect(drainJob()).toBeDefined();
    });

    it("cortex + auto: the spool and its drain job come on with the backend", () => {
      expect(runSetup({ BASIC_MEMORY_BACKEND: "cortex" }).status).toBe(0);
      expect(hookCommand()).toContain("BASIC_MEMORY_SPOOL_ENABLED=1");
      expect(hookCommand()).toContain("REMOTE_MEMORY_CLI_BIN=cortex");
      const job = drainJob();
      expect(job).toBeDefined();
      expect(job!.command).toContain("REMOTE_MEMORY_CLI_BIN=cortex");
    });

    it("cortex + never: an explicit opt-out beats the backend default", () => {
      expect(
        runSetup({ BASIC_MEMORY_BACKEND: "cortex", BASIC_MEMORY_SPOOL_ENABLED: "never" }).status
      ).toBe(0);
      expect(hookCommand()).not.toContain("BASIC_MEMORY_SPOOL_ENABLED");
      expect(drainJob()).toBeUndefined();
      // The opt-out must not even create the machine-global jobs file.
      expect(fs.existsSync(jobsFile)).toBe(false);
    });

    it("cortex + a legacy boolean false is read as that same explicit opt-out", () => {
      expect(
        runSetup({ BASIC_MEMORY_BACKEND: "cortex", BASIC_MEMORY_SPOOL_ENABLED: "false" }).status
      ).toBe(0);
      expect(hookCommand()).not.toContain("BASIC_MEMORY_SPOOL_ENABLED");
      expect(drainJob()).toBeUndefined();
    });
  });

  describe("flipping the switch", () => {
    it("local -> cortex -> local leaves no stale skill and no stale drain job", () => {
      // local
      expect(runSetup().status).toBe(0);
      expect(installedSkill()).toBe(fs.readFileSync(LOCAL_SKILL_SRC, "utf8"));
      expect(drainJob()).toBeUndefined();

      // -> cortex
      expect(runSetup({ BASIC_MEMORY_BACKEND: "cortex" }).status).toBe(0);
      expect(installedSkill()).toBe(fs.readFileSync(CORTEX_SKILL_SRC, "utf8"));
      expect(drainJob()).toBeDefined();
      expect(fs.existsSync(path.join(stubState, "claude-mcp-basic-memory"))).toBe(false);

      // -> back to local. NOTE: `apm install` is deliberately NOT re-simulated
      // between runs, so the cleanup below is setup.sh's own doing.
      clearCalls();
      expect(runSetup().status).toBe(0);
      expect(installedSkill()).toBe(fs.readFileSync(LOCAL_SKILL_SRC, "utf8"));
      expect(installedSkill()).not.toContain("garrison-memory-backend");
      expect(fs.readdirSync(path.dirname(installedSkillPath))).toEqual(["SKILL.md"]);
      expect(drainJob()).toBeUndefined();
      expect(jobs()).toEqual([]);
      expect(hookCommand()).toBe(stockHookCommand());
      expect(fs.existsSync(path.join(stubState, "claude-mcp-basic-memory"))).toBe(true);
      expect(calls()).toContain(`claude mcp add -s user basic-memory -- ${bmBin} mcp`);
      expect(runVerify().status).toBe(0);
    });

    it("a flip back to local never rewrites a SKILL.md this fitting did not install", () => {
      const handAuthored = "---\nname: Garrison Memory\n---\n\n# mine, not the fitting's\n";
      fs.writeFileSync(installedSkillPath, handAuthored);
      expect(runSetup().status).toBe(0);
      expect(installedSkill()).toBe(handAuthored);
    });
  });

  describe("the two skill variants", () => {
    /** H2s outside fenced blocks - both variants embed a note template full of `##` lines. */
    const headings = (body: string) => {
      const out: string[] = [];
      let fenced = false;
      for (const line of body.split("\n")) {
        if (line.startsWith("```")) fenced = !fenced;
        else if (!fenced && line.startsWith("## ")) out.push(line.slice(3).trim());
      }
      return out;
    };
    /** Line wrapping is prose formatting, not meaning. */
    const flat = (body: string) => body.replace(/\s+/g, " ");

    it("keep the same section shape, differing only where the ops surface does", () => {
      const local = fs.readFileSync(LOCAL_SKILL_SRC, "utf8");
      const cortex = fs.readFileSync(CORTEX_SKILL_SRC, "utf8");

      expect(local.split("\n").filter((l) => l.startsWith("# "))[0]).toBe("# Garrison Memory");
      expect(cortex.split("\n").filter((l) => l.startsWith("# "))[0]).toBe("# Garrison Memory");

      expect(headings(local)).toEqual([
        "How it works",
        'Consolidation ("dream")',
        "Using memory (MCP tools)",
        "Writing durable memories",
        "Operating principles"
      ]);
      expect(headings(cortex)).toEqual([
        "How it works",
        'Consolidation ("dream")',
        "Using memory (the `cortex memory` CLI)",
        "Writing durable memories",
        "Operating principles"
      ]);
      // Exactly one section title differs: the one naming the ops surface.
      const differing = headings(local).filter((h, i) => h !== headings(cortex)[i]);
      expect(differing).toEqual(["Using memory (MCP tools)"]);
    });

    it("map the three tools that have an equivalent and mark the two that do not", () => {
      const cortex = flat(fs.readFileSync(CORTEX_SKILL_SRC, "utf8"));
      expect(cortex).toMatch(/`search_notes`[\s\S]{0,120}cortex memory search/);
      expect(cortex).toMatch(/`read_note`[\s\S]{0,120}cortex memory read/);
      expect(cortex).toMatch(/`write_note`[\s\S]{0,160}cortex memory write/);
      expect(cortex).toMatch(/`build_context`[\s\S]{0,120}no equivalent/);
      expect(cortex).toMatch(/`recent_activity`[\s\S]{0,120}no equivalent/);
      // The honesty is spelled out, not just tabulated.
      expect(cortex).toContain("no contract operation for it today");
      expect(cortex).toContain("is no contract operation for that either");
      // Environment-only config, and no example that puts a credential on the
      // command line (where it would land in shell history and process lists).
      expect(cortex).toContain("CORTEX_BASE_URL");
      expect(cortex).toContain("CORTEX_API_KEY");
      expect(cortex).toContain("Configuration is environment-only");
      expect(cortex).not.toMatch(/--(api-)?key[= ][^\s`]/);
    });

    it("the default variant never mentions a remote backend", () => {
      const local = fs.readFileSync(LOCAL_SKILL_SRC, "utf8");
      expect(local).not.toMatch(/cortex/i);
      expect(local).not.toMatch(/CORTEX_/);
    });
  });

  describe("nothing key-like is committed or installed", () => {
    it("no committed file in the fitting carries a credential or an off-allowlist URL", () => {
      const allowedHosts = new Set(["docs.astral.sh"]);
      const secretish = [
        /sk-[A-Za-z0-9]{16,}/,
        /ghp_[A-Za-z0-9]{16,}/,
        /xox[bpsa]-[A-Za-z0-9-]{16,}/,
        /ekoa_gk_[A-Za-z0-9]{8,}/,
        /Bearer\s+[A-Za-z0-9._-]{12,}/,
        /-----BEGIN [A-Z ]*PRIVATE KEY-----/
      ];
      for (const file of walkFiles(FITTING_SRC)) {
        const body = fs.readFileSync(file, "utf8");
        for (const pattern of secretish) {
          expect(pattern.test(body), `${file} matches ${pattern}`).toBe(false);
        }
        for (const url of body.match(/https?:\/\/[^\s"'`)\]]+/g) ?? []) {
          const host = new URL(url).hostname;
          expect(allowedHosts.has(host), `${file} reaches ${host}`).toBe(true);
        }
      }
    });

    it("a cortex run never writes the key or the base URL into any installed artifact", () => {
      const key = "ekoa_gk_SENTINELdeadbeefdeadbeef";
      const baseUrl = "https://sentinel-private-host.invalid";
      const result = runSetup({
        BASIC_MEMORY_BACKEND: "cortex",
        CORTEX_API_KEY: key,
        CORTEX_BASE_URL: baseUrl
      });
      expect(result.status).toBe(0);
      // Not echoed by the hook itself, either.
      expect(result.stdout).not.toContain(key);
      expect(result.stdout).not.toContain(baseUrl);
      expect(result.stderr).not.toContain(key);

      const artifacts = [...walkFiles(claudeHome), ...walkFiles(path.join(comp, ".claude"))];
      if (fs.existsSync(jobsFile)) artifacts.push(jobsFile);
      expect(artifacts.length).toBeGreaterThan(0);
      for (const file of artifacts) {
        const body = fs.readFileSync(file, "utf8");
        expect(body.includes(key), `${file} contains the key`).toBe(false);
        expect(body.includes(baseUrl), `${file} contains the base URL`).toBe(false);
      }
    });
  });
});
