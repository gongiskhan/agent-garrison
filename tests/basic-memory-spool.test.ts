// Slice G2 - basic-memory capture spool + CLI flush (backend-agnostic).
//
// Drives the real scripts as subprocesses, exactly as Claude Code / the
// scheduler would: capture-session.py gets a fake hook payload on stdin with
// env pointed at tmp dirs; flush-spool.mjs gets a STUB CLI binary (a shell
// script recording its argv, with a failing mode). No such CLI exists in this repo -
// the contract under test is the one the later CLI slice must honor:
//
//   <bin> memory write --file <spoolfile> --permalink <key> --json
//
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..");
const SCRIPTS = path.join(REPO_ROOT, "fittings", "seed", "basic-memory", "scripts");
const CAPTURE = path.join(SCRIPTS, "capture-session.py");
const FLUSH = path.join(SCRIPTS, "flush-spool.mjs");

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  elapsedMs: number;
}

function run(
  cmd: string,
  args: string[],
  env: Record<string, string | undefined>,
  stdin?: string
): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("close", (code) =>
      resolve({ stdout, stderr, exitCode: code, elapsedMs: Date.now() - started })
    );
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

const SESSION_ID = "abc123def456";

describe("basic-memory capture spool + flush", () => {
  let tmp: string;
  let home: string;
  let vault: string;
  let spool: string;
  let project: string;

  /** Env every capture run shares: sandbox HOME + vault, autoflush off unless a test opts in. */
  function captureEnv(extra: Record<string, string | undefined> = {}) {
    return {
      HOME: home,
      BASIC_MEMORY_VAULT_DIR: vault,
      BASIC_MEMORY_MEMORY_DIR: "Memory",
      BASIC_MEMORY_SPOOL_ENABLED: undefined,
      BASIC_MEMORY_SPOOL_DIR: undefined,
      BASIC_MEMORY_SPOOL_CAP_BYTES: undefined,
      BASIC_MEMORY_SPOOL_AUTOFLUSH: "0",
      ...extra
    };
  }

  function hookPayload(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      session_id: SESSION_ID,
      cwd: project,
      hook_event_name: "SessionEnd",
      transcript_path: "",
      ...overrides
    });
  }

  async function vaultNotes(): Promise<string[]> {
    try {
      return (await fs.readdir(path.join(vault, "Memory"))).filter((n) =>
        n.startsWith("session-")
      );
    } catch {
      return [];
    }
  }

  async function spoolFiles(dir = spool): Promise<string[]> {
    try {
      return (await fs.readdir(dir)).filter((n) => /^capture-.*\.md$/.test(n)).sort();
    } catch {
      return [];
    }
  }

  /** The recording stub the flush tests use in place of the remote memory CLI. */
  async function writeStub(dir: string): Promise<{ bin: string; log: string }> {
    const bin = path.join(dir, "cortex-stub");
    const log = path.join(dir, "stub-args.log");
    await fs.writeFile(
      bin,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$STUB_LOG"\nif [ "\${STUB_FAIL:-}" = "1" ]; then exit 3; fi\necho '{"status":"ok"}'\n`,
      { mode: 0o755 }
    );
    return { bin, log };
  }

  async function seedSpoolFile(name: string, content: string, ageSeconds: number): Promise<string> {
    await fs.mkdir(spool, { recursive: true });
    const full = path.join(spool, name);
    await fs.writeFile(full, content, "utf8");
    const when = Math.floor(Date.now() / 1000) - ageSeconds;
    await fs.utimes(full, when, when);
    return full;
  }

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "garrison-bm-spool-"));
    home = path.join(tmp, "home");
    vault = path.join(tmp, "vault");
    spool = path.join(tmp, "spool");
    project = path.join(tmp, "proj");
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(project, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  describe("capture-session.py", () => {
    it("default run (spool absent) writes the vault note only - no spool anywhere, exit 0", async () => {
      const result = await run(
        "python3",
        [CAPTURE],
        captureEnv({ BASIC_MEMORY_SPOOL_AUTOFLUSH: undefined }),
        hookPayload()
      );
      expect(result.exitCode).toBe(0);
      const notes = await vaultNotes();
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatch(/^session-\d{8}-\d{6}-abc123de\.md$/);
      // Stock behavior stays byte-identical: nothing may touch the built-in
      // spool location (~/.garrison lives under the sandboxed HOME here).
      await expect(fs.stat(path.join(home, ".garrison"))).rejects.toMatchObject({
        code: "ENOENT"
      });
      expect(await spoolFiles()).toHaveLength(0);
    });

    it("spool enabled writes the same markdown under a stable idempotency key AND keeps the vault write", async () => {
      const result = await run(
        "python3",
        [CAPTURE],
        captureEnv({
          BASIC_MEMORY_SPOOL_ENABLED: "1",
          BASIC_MEMORY_SPOOL_DIR: spool,
          // Autoflush stays ON to prove the guarded detached spawn never
          // breaks the hook; the missing binary makes the flush a safe no-op.
          BASIC_MEMORY_SPOOL_AUTOFLUSH: undefined,
          REMOTE_MEMORY_CLI_BIN: path.join(tmp, "no-such-cortex")
        }),
        hookPayload()
      );
      expect(result.exitCode).toBe(0);

      const notes = await vaultNotes();
      expect(notes).toHaveLength(1);
      const spooled = await spoolFiles();
      expect(spooled).toHaveLength(1);
      // key = capture-<sid>-<ts>-<pid>; the pid keeps same-second SessionEnd
      // + PreCompact (distinct hook processes) from overwriting each other.
      expect(spooled[0]).toMatch(new RegExp(`^capture-${SESSION_ID}-\\d{8}-\\d{6}-\\d+\\.md$`));
      // No partial files left behind (write-then-rename).
      expect((await fs.readdir(spool)).filter((n) => n.endsWith(".tmp"))).toHaveLength(0);

      const vaultBody = await fs.readFile(path.join(vault, "Memory", notes[0]), "utf8");
      const spoolBody = await fs.readFile(path.join(spool, spooled[0]), "utf8");
      expect(spoolBody).toBe(vaultBody);
      expect(spoolBody).toContain(`- **session**: ${SESSION_ID}`);
    });

    it("swallows a read-only spool path: vault still written, exit 0, under 1s", async () => {
      const roParent = path.join(tmp, "ro");
      await fs.mkdir(roParent, { recursive: true });
      await fs.chmod(roParent, 0o555);
      try {
        const result = await run(
          "python3",
          [CAPTURE],
          captureEnv({
            BASIC_MEMORY_SPOOL_ENABLED: "1",
            BASIC_MEMORY_SPOOL_DIR: path.join(roParent, "spool")
          }),
          hookPayload()
        );
        expect(result.exitCode).toBe(0);
        expect(result.elapsedMs).toBeLessThan(1000);
        expect(await vaultNotes()).toHaveLength(1);
      } finally {
        await fs.chmod(roParent, 0o755);
      }
    });

    it("caps the spool: evicts oldest-first and prints ONE loud stderr line", async () => {
      const filler = "x".repeat(500);
      await seedSpoolFile("capture-old1-20260101-000001.md", filler, 300);
      await seedSpoolFile("capture-old2-20260101-000002.md", filler, 200);
      await seedSpoolFile("capture-old3-20260101-000003.md", filler, 100);

      const result = await run(
        "python3",
        [CAPTURE],
        captureEnv({
          BASIC_MEMORY_SPOOL_ENABLED: "1",
          BASIC_MEMORY_SPOOL_DIR: spool,
          BASIC_MEMORY_SPOOL_CAP_BYTES: "600"
        }),
        hookPayload()
      );
      expect(result.exitCode).toBe(0);

      const loud = result.stderr
        .split("\n")
        .filter((l) => l.includes("[basic-memory] spool cap:"));
      expect(loud).toHaveLength(1);
      expect(loud[0]).toMatch(/^\[basic-memory\] spool cap: evicted 3 oldest captures$/);

      const remaining = await spoolFiles();
      expect(remaining).toHaveLength(1); // the 3 old ones evicted, the new capture written
      expect(remaining[0]).toMatch(new RegExp(`^capture-${SESSION_ID}-`));
    });

    it("eviction never touches foreign files: spool_dir is user config", async () => {
      // Review finding: a mispointed spool_dir must not have its files
      // silently deleted by a session-end hook. Only capture-*.md (and this
      // script's own .tmp leftovers) are eviction candidates or counted.
      const filler = "x".repeat(500);
      const foreign = path.join(spool, "IMPORTANT-notes.txt");
      await fs.mkdir(spool, { recursive: true });
      await fs.writeFile(foreign, filler, "utf8");
      const old = Math.floor(Date.now() / 1000) - 400; // oldest file in the dir
      await fs.utimes(foreign, old, old);
      await seedSpoolFile("capture-old1-20260101-000001.md", filler, 300);
      await seedSpoolFile("capture-old2-20260101-000002.md", filler, 200);

      const result = await run(
        "python3",
        [CAPTURE],
        captureEnv({
          BASIC_MEMORY_SPOOL_ENABLED: "1",
          BASIC_MEMORY_SPOOL_DIR: spool,
          BASIC_MEMORY_SPOOL_CAP_BYTES: "600"
        }),
        hookPayload()
      );
      expect(result.exitCode).toBe(0);
      // Both captures evicted (counted against the cap), the foreign file
      // never counted and never deleted.
      expect(result.stderr).toContain("spool cap: evicted 2 oldest captures");
      expect(await fs.readFile(foreign, "utf8")).toBe(filler);
      const remaining = await spoolFiles();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toMatch(new RegExp(`^capture-${SESSION_ID}-`));
    });

    it("a capture larger than the cap is refused loudly instead of evicting everything", async () => {
      await seedSpoolFile("capture-old1-20260101-000001.md", "keep-me", 100);

      const result = await run(
        "python3",
        [CAPTURE],
        captureEnv({
          BASIC_MEMORY_SPOOL_ENABLED: "1",
          BASIC_MEMORY_SPOOL_DIR: spool,
          BASIC_MEMORY_SPOOL_CAP_BYTES: "100" // any real capture exceeds this
        }),
        hookPayload()
      );
      expect(result.exitCode).toBe(0);
      expect(await vaultNotes()).toHaveLength(1); // local write unaffected

      const loud = result.stderr
        .split("\n")
        .filter((l) => l.includes("[basic-memory] spool cap:"));
      expect(loud).toHaveLength(1);
      expect(loud[0]).toMatch(/capture exceeds the cap; skipped spool write$/);
      // Nothing written, nothing evicted for a doomed write.
      expect(await spoolFiles()).toEqual(["capture-old1-20260101-000001.md"]);
    });

    it("two captures in the same second land as two spool files (pid disambiguator)", async () => {
      const env = captureEnv({
        BASIC_MEMORY_SPOOL_ENABLED: "1",
        BASIC_MEMORY_SPOOL_DIR: spool
      });
      const [first, second] = await Promise.all([
        run("python3", [CAPTURE], env, hookPayload()),
        run("python3", [CAPTURE], env, hookPayload({ hook_event_name: "PreCompact" }))
      ]);
      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      expect(await spoolFiles()).toHaveLength(2); // same sid + second, distinct pids
    });
  });

  describe("flush-spool.mjs", () => {
    it("drains oldest-first via the CLI contract and deletes each flushed file", async () => {
      const older = await seedSpoolFile(`capture-${SESSION_ID}-20260101-000000.md`, "one", 200);
      const newer = await seedSpoolFile(`capture-${SESSION_ID}-20260102-000000.md`, "two", 100);
      const { bin, log } = await writeStub(tmp);

      const result = await run("node", [FLUSH], {
        BASIC_MEMORY_SPOOL_DIR: spool,
        REMOTE_MEMORY_CLI_BIN: bin,
        STUB_LOG: log
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("flushed 2 capture(s)");
      expect(await spoolFiles()).toHaveLength(0);

      const calls = (await fs.readFile(log, "utf8")).trim().split("\n");
      expect(calls).toEqual([
        `memory write --file ${older} --permalink capture-${SESSION_ID}-20260101-000000 --json`,
        `memory write --file ${newer} --permalink capture-${SESSION_ID}-20260102-000000 --json`
      ]);
    });

    it("stops at the first failure: file left in place, only one attempt, nonzero exit", async () => {
      await seedSpoolFile(`capture-${SESSION_ID}-20260101-000000.md`, "one", 200);
      await seedSpoolFile(`capture-${SESSION_ID}-20260102-000000.md`, "two", 100);
      const { bin, log } = await writeStub(tmp);

      const result = await run("node", [FLUSH], {
        BASIC_MEMORY_SPOOL_DIR: spool,
        REMOTE_MEMORY_CLI_BIN: bin,
        STUB_LOG: log,
        STUB_FAIL: "1"
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("write failed");
      expect(await spoolFiles()).toHaveLength(2);
      const calls = (await fs.readFile(log, "utf8")).trim().split("\n");
      expect(calls).toHaveLength(1); // stopped after the first failure
    });

    it("missing binary is the safe OSS-default path: spool intact, exit 0", async () => {
      await seedSpoolFile(`capture-${SESSION_ID}-20260101-000000.md`, "one", 100);
      const result = await run("node", [FLUSH], {
        BASIC_MEMORY_SPOOL_DIR: spool,
        REMOTE_MEMORY_CLI_BIN: path.join(tmp, "no-such-cortex")
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("remote memory CLI not found");
      expect(await spoolFiles()).toHaveLength(1);
    });

    it("presents the SAME permalink key across two flush attempts of the same file", async () => {
      const name = `capture-${SESSION_ID}-20260101-000000.md`;
      await seedSpoolFile(name, "one", 100);
      const { bin, log } = await writeStub(tmp);
      const env = {
        BASIC_MEMORY_SPOOL_DIR: spool,
        REMOTE_MEMORY_CLI_BIN: bin,
        STUB_LOG: log,
        STUB_FAIL: "1"
      };

      const first = await run("node", [FLUSH], env);
      const second = await run("node", [FLUSH], env);
      expect(first.exitCode).toBe(1);
      expect(second.exitCode).toBe(1);
      expect(await spoolFiles()).toEqual([name]);

      const keys = (await fs.readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((l) => /--permalink (\S+)/.exec(l)?.[1]);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(`capture-${SESSION_ID}-20260101-000000`);
      expect(keys[1]).toBe(keys[0]);
    });

    it("--dry-run lists pending captures without invoking the CLI or deleting anything", async () => {
      const name = `capture-${SESSION_ID}-20260101-000000.md`;
      await seedSpoolFile(name, "one", 100);
      const { bin, log } = await writeStub(tmp);

      const result = await run("node", [FLUSH, "--dry-run"], {
        BASIC_MEMORY_SPOOL_DIR: spool,
        REMOTE_MEMORY_CLI_BIN: bin,
        STUB_LOG: log
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`would flush ${name}`);
      expect(await spoolFiles()).toEqual([name]);
      await expect(fs.stat(log)).rejects.toMatchObject({ code: "ENOENT" }); // stub never ran
    });

    it("timeout SIGKILLs a CLI that ignores SIGTERM: drain never blocks past the budget", async () => {
      const name = `capture-${SESSION_ID}-20260101-000000.md`;
      await seedSpoolFile(name, "one", 100);
      // A hostile/hung CLI: ignores SIGTERM (spawnSync's default kill signal)
      // and sleeps well past the timeout budget.
      const bin = path.join(tmp, "cortex-hang");
      await fs.writeFile(bin, `#!/bin/sh\ntrap '' TERM\nsleep 8\n`, { mode: 0o755 });

      const result = await run("node", [FLUSH], {
        BASIC_MEMORY_SPOOL_DIR: spool,
        REMOTE_MEMORY_CLI_BIN: bin,
        BASIC_MEMORY_FLUSH_TIMEOUT_MS: "1000"
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("timeout after 1000ms");
      expect(result.elapsedMs).toBeLessThan(5000); // SIGKILL, not the 8s sleep
      expect(await spoolFiles()).toEqual([name]); // failure leaves the file
    });

    it("empty or missing spool exits 0 quietly", async () => {
      const result = await run("node", [FLUSH], {
        BASIC_MEMORY_SPOOL_DIR: path.join(tmp, "never-created")
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("nothing to do");
    });
  });
});
