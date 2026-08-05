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
const KANBAN_CAPTURE_JOB_ID = "basic-memory-kanban-personal-completions";

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
  function jobs(): Array<{ id: string; cron: string; command: string; enabled?: boolean }> {
    if (!fs.existsSync(jobsFile)) return [];
    return JSON.parse(fs.readFileSync(jobsFile, "utf8"));
  }
  function drainJob() {
    return jobs().find((job) => job.id === FLUSH_JOB_ID);
  }
  function kanbanCaptureJob() {
    return jobs().find((job) => job.id === KANBAN_CAPTURE_JOB_ID);
  }
  function installedSkill(): string {
    return fs.readFileSync(installedSkillPath, "utf8");
  }

  /**
   * The capture-hook command, pinned literally.
   *
   * STATED EXCEPTION to hard rule 6, and the only one: the values are now %q-quoted rather than
   * wrapped in literal double quotes. `vault_dir` and `memory_dir` are operator config and this
   * string is written into ~/.claude/settings.json and RUN AS A SHELL COMMAND on every SessionEnd
   * and PreCompact, so an unquoted `$()` in either one executed on a recurring trigger - proven by
   * the run-level security review. %q leaves a safe path untouched, so the command is behaviourally
   * identical for every value that was ever safe; only the literal differs. A cosmetic byte change
   * was the right price for closing a shell injection, and it is recorded rather than hidden.
   */
  const stockHookCommand = () =>
    `BASIC_MEMORY_VAULT_DIR=${vault} BASIC_MEMORY_MEMORY_DIR=Memory ` +
    `python3 ${path.join(claudeHome, "basic-memory", "capture-session.py")}`;

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

  describe("personal Kanban completion capture wiring", () => {
    it("registers a guarded exact-outbox job, executes it, and verify catches missing staged pieces", () => {
      const kanbanFitting = path.join(comp, "apm_modules", "_local", "kanban-loop");
      const exactKanbanDir = path.join(tmp, "custom-instance", "kanban-data");
      fs.mkdirSync(kanbanFitting, { recursive: true });

      const setup = runSetup({ GARRISON_KANBAN_DIR: exactKanbanDir });
      expect(setup.stderr).toBe("");
      expect(setup.status).toBe(0);

      const job = kanbanCaptureJob();
      expect(job).toBeDefined();
      expect(job!.enabled).toBe(true);
      expect(job!.command).toContain("consume-kanban-completions.mjs");
      expect(job!.command).toContain(`GARRISON_KANBAN_DIR=${exactKanbanDir}`);
      expect(job!.command).toContain("if [ -d");
      expect(job!.command).toContain(fitting); // deselection guard pins this composition module

      const staged = path.join(claudeHome, "basic-memory", "consume-kanban-completions.mjs");
      const shared = path.join(claudeHome, "basic-memory", "lib", "memory-vault.mjs");
      expect(fs.existsSync(staged)).toBe(true);
      expect(fs.existsSync(shared)).toBe(true);
      expect(runVerify({ GARRISON_KANBAN_DIR: exactKanbanDir }).status).toBe(0);

      // Execute the persisted scheduler command, not merely the consumer
      // module. This pins shell quoting, the deselection guard, and every
      // baked environment assignment as one end-to-end contract.
      const cardId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
      const packetId = `${cardId}-g0`;
      const packetDir = path.join(
        exactKanbanDir,
        "memory-outbox",
        "personal-completions",
        "packets"
      );
      fs.mkdirSync(packetDir, { recursive: true });
      fs.writeFileSync(path.join(packetDir, `${packetId}.json`), `${JSON.stringify({
        schemaVersion: 1,
        kind: "garrison.personal-card-completion",
        packetId,
        cardId,
        coordinationSeq: 0,
        scope: "personal",
        completedAt: "2026-08-05T17:00:00.000Z",
        title: "Renew passport",
        description: "Book the appointment",
        checklist: [],
        manualCompletionNote: null,
        agentCloseout: null
      }, null, 2)}\n`);
      const executed = spawnSync("/bin/sh", ["-c", job!.command], {
        env: process.env,
        encoding: "utf8",
        timeout: 30_000
      });
      expect(executed.stderr).toBe("");
      expect(executed.status).toBe(0);
      expect(
        fs.existsSync(path.join(vault, "Personal", "Kanban Completions", `kanban-${cardId}-g0.md`))
      ).toBe(true);
      expect(
        JSON.parse(fs.readFileSync(path.join(
          exactKanbanDir,
          "memory-outbox",
          "personal-completions",
          "status",
          `${packetId}.json`
        ), "utf8")).state
      ).toBe("captured");

      fs.rmSync(staged);
      const broken = runVerify({ GARRISON_KANBAN_DIR: exactKanbanDir });
      expect(broken.status).toBe(1);
      expect(broken.stderr).toContain("personal Kanban completion consumer missing");
    });

    it("fails setup and verify when enabled capture has Kanban but no Scheduler", () => {
      const kanbanFitting = path.join(comp, "apm_modules", "_local", "kanban-loop");
      fs.mkdirSync(kanbanFitting, { recursive: true });
      fs.rmSync(path.join(comp, "apm_modules", "_local", "scheduler"), {
        recursive: true,
        force: true
      });

      const setup = runSetup();
      expect(setup.status).toBe(1);
      expect(setup.stderr).toContain(
        "personal Kanban completion capture is enabled but the Scheduler fitting is not installed"
      );
      expect(
        fs.existsSync(path.join(claudeHome, "basic-memory", "consume-kanban-completions.mjs"))
      ).toBe(false);

      const verified = runVerify();
      expect(verified.status).toBe(1);
      expect(verified.stderr).toContain(
        "personal Kanban completion capture is enabled but the Scheduler fitting is not installed"
      );

      // The dependency is conditional: explicitly disabling personal-card
      // capture keeps Basic Memory valid without Scheduler.
      expect(runSetup({ BASIC_MEMORY_KANBAN_COMPLETION_CAPTURE_ENABLED: "false" }).status).toBe(0);
      expect(runVerify({ BASIC_MEMORY_KANBAN_COMPLETION_CAPTURE_ENABLED: "false" }).status).toBe(0);
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

    it("flipping back to local also un-stages the drain script, not just its job", () => {
      const staged = path.join(claudeHome, "basic-memory", "flush-spool.mjs");
      expect(runSetup({ BASIC_MEMORY_BACKEND: "cortex" }).status).toBe(0);
      expect(fs.existsSync(staged)).toBe(true);

      expect(runSetup().status).toBe(0);
      // A remote-shipping script left behind after the remote is turned off is
      // residue that gets found later and assumed to be running.
      expect(fs.existsSync(staged)).toBe(false);
      expect(drainJob()).toBeUndefined();
    });

    it("on a machine that never used a remote backend, local NEVER reads or writes the deployed skill", () => {
      // The real guarantee, and the one finding 3 was about: the default path is
      // gated on OUR sidecar, not on the content of the deployed file. A skill
      // that merely QUOTES the variant's marker must survive untouched.
      const quotesTheMarker =
        "---\nname: Garrison Memory\n---\n\n# House memory rules\n\n" +
        "Our remote variant is tagged `<!-- garrison-memory-backend: cortex -->`,\n" +
        "which is how setup used to recognise it:\n\n" +
        "```\n<!-- garrison-memory-backend: cortex -->\n```\n";
      fs.writeFileSync(installedSkillPath, quotesTheMarker);
      expect(runSetup().status).toBe(0);
      expect(installedSkill()).toBe(quotesTheMarker);
      expect(fs.existsSync(path.join(comp, ".garrison", "basic-memory-skill-backend"))).toBe(false);
    });

    it("an edit to the APM-OWNED deployed copy is not durable, and the code no longer pretends otherwise", () => {
      // The honest statement of finding 1. `apm install --force` re-deploys
      // <composition>/.claude/skills/** from .apm/skills on every install,
      // ignoring deployed_file_hashes, and it runs immediately before every
      // setup hook - so an edit there is lost whatever setup does. Pinning the
      // real behaviour (rather than a protection we cannot offer) keeps the
      // claim and the code in step.
      expect(runSetup({ BASIC_MEMORY_BACKEND: "cortex" }).status).toBe(0);
      const houseRules = `${installedSkill()}\n## House rules\n- always cite the permalink\n`;
      fs.writeFileSync(installedSkillPath, houseRules); // marker still present
      expect(installedSkill()).toContain("garrison-memory-backend: cortex");

      expect(runSetup().status).toBe(0);
      expect(installedSkill()).toBe(fs.readFileSync(LOCAL_SKILL_SRC, "utf8"));
      expect(installedSkill()).not.toContain("House rules");

      // …and the docs say so, in all three places an operator could look.
      const readme = fs.readFileSync(path.join(FITTING_SRC, "README.md"), "utf8");
      expect(readme).toContain("APM owns the deployed copy — edits there are not durable");
      expect(fs.readFileSync(path.join(FITTING_SRC, "apm.yml"), "utf8")).toContain(
        "owned by APM and re-deployed from .apm/skills on every install"
      );
      expect(fs.readFileSync(path.join(FITTING_SRC, "scripts", "setup.sh"), "utf8")).toContain(
        "WHO OWNS WHAT"
      );
    });

    it("warns loudly when the LOCAL skill source is edited while on a remote backend", () => {
      // The Skill view edits .apm/skills; on cortex the deployed file comes from
      // skill-variants/. Without this the edit is silently discarded.
      expect(runSetup({ BASIC_MEMORY_BACKEND: "cortex" }).status).toBe(0);
      const localSrc = path.join(fitting, ".apm", "skills", "garrison-memory", "SKILL.md");
      fs.writeFileSync(localSrc, `${fs.readFileSync(localSrc, "utf8")}\n- an edit made in the view\n`);

      const second = runSetup({ BASIC_MEMORY_BACKEND: "cortex" });
      expect(second.status).toBe(0);
      expect(second.stdout).toContain("that edit is NOT in effect");
      expect(second.stdout).toContain("skill-variants/cortex/SKILL.md");

      // Not nagging: an unchanged source is silent on the next run.
      const third = runSetup({ BASIC_MEMORY_BACKEND: "cortex" });
      expect(third.stdout).not.toContain("NOT in effect");
    });
  });

  describe("the Skill view reaches both variants", () => {
    it("SkillView roots at .apm/skills AND skill-variants, both matching perDoc subdir", () => {
      const view = fs.readFileSync(
        path.join(REPO_ROOT, "src", "components", "fitting-views", "shared", "SkillView.tsx"),
        "utf8"
      );
      expect(view).toContain('{ dir: ".apm/skills", perDoc: "subdir" }');
      expect(view).toContain('{ dir: "skill-variants", perDoc: "subdir" }');
      // perDoc: "subdir" resolves <root>/<name>/SKILL.md — the variant must
      // actually be laid out that way or the view lists nothing.
      expect(fs.existsSync(path.join(FITTING_SRC, "skill-variants", "cortex", "SKILL.md"))).toBe(
        true
      );
    });

    it("the fitting-file API can write both roots (neither is a blocked segment)", () => {
      // .apm is IN BLOCKED_SEGMENTS, but rejectBlockedSegments carves out
      // `.apm/skills/**` and `.apm/prompts/**` by skipping their first two
      // segments — so the pre-existing root is writable, and so is the new one.
      const lib = fs.readFileSync(path.join(REPO_ROOT, "src", "lib", "fitting-files.ts"), "utf8");
      expect(lib).toContain('const BLOCKED_SEGMENTS = new Set(["node_modules", "apm_modules", ".git", ".apm"]);');
      expect(lib).toMatch(/segments\[0\] === "\.apm" &&/);
      expect(lib).toMatch(/payload \? segments\.slice\(2\) : segments/);
      expect(lib).not.toMatch(/BLOCKED_SEGMENTS[\s\S]{0,200}skill-variants/);
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

  describe("known gaps are documented rather than left to be discovered", () => {
    const readme = () => fs.readFileSync(path.join(FITTING_SRC, "README.md"), "utf8");
    const manifest = () => fs.readFileSync(path.join(FITTING_SRC, "apm.yml"), "utf8");

    it("the deselect gap is stated with the steps to avoid it", () => {
      // basic-memory is not in COORD_OWNERS, so deselecting the fitting strips
      // neither the capture hook nor the drain job — and a remote backend turns
      // the drain ON by default, so a deselect can leave a job shipping local
      // captures off the machine.
      const coord = fs.readFileSync(path.join(REPO_ROOT, "src", "lib", "coord-wiring.ts"), "utf8");
      const owners = /COORD_OWNERS[^=]*=\s*([\s\S]*?)\]/.exec(coord)?.[1] ?? "";
      expect(owners).not.toContain("basic-memory"); // the gap is real
      expect(readme()).toContain("Known gap: deselecting the Fitting leaves its hook and its job behind");
      expect(readme()).toContain("basic-memory-spool-flush");
      expect(manifest()).toContain("Deselecting this fitting does NOT remove its capture hook");
    });

    it("the blank-select rendering of a legacy boolean is called out", () => {
      // ConfigForm renders <select value={String(value)}>, so a stored boolean
      // false matches no option and shows blank even though it resolves fine.
      const form = fs.readFileSync(
        path.join(REPO_ROOT, "src", "components", "fitting-views", "shared", "ConfigForm.tsx"),
        "utf8"
      );
      expect(form).toContain('value={String(value ?? "")}');
      expect(manifest()).toContain("the config form renders it BLANK");
      expect(readme()).toContain("renders it blank");
    });

    it("no shipped prose claims byte-identical BEHAVIOUR for the default path", () => {
      // The claim the code supports is "no observable delta for stock inputs".
      // The default path also gained a sidecar stat, an unknown-value log line
      // and a basename subprocess — none observable for stock inputs, but the
      // absolute phrasing was still wrong. Artifact-scoped byte-identity claims
      // (this exact command string, this exact vault note) are fine and stay:
      // they are narrow, and each has a test pinning it.
      // Pinned exhaustively: every surviving `byte-identical` in the fitting
      // must name a specific ARTIFACT. Reintroducing a sweeping one fails here.
      const occurrences: string[] = [];
      for (const file of walkFiles(FITTING_SRC)) {
        for (const line of fs.readFileSync(file, "utf8").split("\n")) {
          if (/byte-identical/i.test(line)) {
            occurrences.push(`${path.basename(file)}: ${line.trim()}`);
          }
        }
      }
      expect(occurrences.sort()).toEqual([
        // the vault write, pinned by the G2 spool tests
        "capture-session.py: is byte-identical whether the spool is on, off, or broken.",
        // the one hook command string, pinned by the default-path golden above
        "setup.sh: # is off (the default) SPOOL_ENV is empty and CAP_CMD is byte-identical to"
      ]);
      expect(fs.readFileSync(path.join(FITTING_SRC, "scripts", "setup.sh"), "utf8")).toContain(
        "NO OBSERVABLE DELTA for stock inputs"
      );
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

      const artifacts = [
        ...walkFiles(claudeHome),
        ...walkFiles(path.join(comp, ".claude")),
        ...walkFiles(path.join(comp, ".garrison"))
      ];
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
