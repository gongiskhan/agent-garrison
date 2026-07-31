// Slice G4 - the basic-memory state migration: a one-time vault import, shadow
// dual-write, and the daily comparator that makes the dated review decidable.
//
// Everything here drives the REAL scripts as subprocesses. The remote memory
// CLI is a STUB - a shell script that records its argv and then execs a small
// node implementation keeping a fake note store on disk (the same shape as
// tests/basic-memory-spool.test.ts, extended so `list` and `read` can answer).
// Nothing in this file touches the network, the developer's ~/.claude, or the
// developer's real vault.
//
// The load-bearing claims:
//   1. the import is re-runnable with ZERO duplicates (the permalink is the
//      identity), and it VERIFIES rather than assuming;
//   2. shadow ADDS the remote destination and leaves the local write alone;
//   3. the comparator reports counts, set differences and content mismatches
//      SEPARATELY, states its sample size, and carries the review deadline;
//   4. the default path is untouched, and the local vault is never mutated.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..");
const FITTING_SRC = path.join(REPO_ROOT, "fittings", "seed", "basic-memory");
const SCRIPTS = path.join(FITTING_SRC, "scripts");
const IMPORT = path.join(SCRIPTS, "import-vault.mjs");
const COMPARE = path.join(SCRIPTS, "compare-backends.mjs");
const SCHEDULER_SRC = path.join(
  REPO_ROOT,
  "fittings",
  "seed",
  "scheduler",
  "scripts",
  "scheduler.mjs"
);
const LOCAL_SKILL_SRC = path.join(FITTING_SRC, ".apm", "skills", "garrison-memory", "SKILL.md");

const FLUSH_JOB_ID = "basic-memory-spool-flush";
const COMPARE_JOB_ID = "basic-memory-backend-compare";
const SESSION_ID = "abc123def456";

/** The stub's node half: a fake remote note store keyed by permalink. */
const STUB_IMPL = `const fs = require("node:fs");
const path = require("node:path");
const store = process.env.STUB_STORE || "";
const argv = process.argv.slice(2);
const keyPath = (permalink) => path.join(store, encodeURIComponent(permalink));
const out = (doc) => { process.stdout.write(JSON.stringify(doc) + "\\n"); process.exit(0); };
const fail = (doc, code) => { process.stderr.write(JSON.stringify(doc) + "\\n"); process.exit(code); };
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

if (argv[0] === "--version") { process.stdout.write("cortex-stub 0.0.0\\n"); process.exit(0); }
if (process.env.STUB_FAIL === "1") fail({ ok: false, error: { code: "SERVER_ERROR", status: 500 } }, 1);

if (argv[0] === "memory" && argv[1] === "write") {
  const file = flag("--file");
  const permalink = flag("--permalink");
  if (!file || !permalink) fail({ ok: false, error: { code: "USAGE" } }, 2);
  fs.mkdirSync(store, { recursive: true });
  // A backend that answers 200 and stores nothing - the exact lie the import's
  // verification exists to catch.
  if (process.env.STUB_DROP_PERMALINK === permalink) {
    out({ ok: true, command: "memory write", status: 200, data: { permalink } });
  }
  let body = fs.readFileSync(file, "utf8");
  if (process.env.STUB_CORRUPT_PERMALINK === permalink) body += "\\n<!-- mangled by the stub -->\\n";
  fs.writeFileSync(keyPath(permalink), body, "utf8");
  out({ ok: true, command: "memory write", status: 200, data: { permalink } });
}

if (argv[0] === "memory" && argv[1] === "list") {
  if (process.env.STUB_BAD_LIST === "1") { process.stdout.write("<html>not json</html>\\n"); process.exit(0); }
  const folder = flag("--folder") || "";
  let names = [];
  try { names = fs.readdirSync(store); } catch { names = []; }
  const notes = names
    .map(decodeURIComponent)
    .filter((p) => p.startsWith(folder + "/"))
    .sort()
    .map((p) => ({ permalink: p, title: p.split("/").pop() }));
  out({ ok: true, command: "memory list", status: 200, data: { notes } });
}

if (argv[0] === "memory" && argv[1] === "read") {
  const permalink = argv[2];
  let body;
  try { body = fs.readFileSync(keyPath(permalink), "utf8"); }
  catch { fail({ ok: false, command: "memory read", error: { code: "NOT_FOUND", status: 404 } }, 1); }
  out({ ok: true, command: "memory read", status: 200, data: { permalink, content: body } });
}

fail({ ok: false, error: { code: "USAGE" } }, 2);
`;

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function run(
  cmd: string,
  args: string[],
  env: Record<string, string | undefined>,
  stdin?: string
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } as NodeJS.ProcessEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code }));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

/** The clock is the only thing that legitimately differs between two captures. */
function withoutTimestamps(body: string): string {
  return body
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, "<ISO>")
    .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, "<WHEN>");
}

describe("basic-memory: import, shadow dual-write, and the comparator", () => {
  let tmp: string;
  let home: string;
  let vault: string;
  let store: string;
  let stubBin: string;
  let stubLog: string;
  let garrisonHome: string;
  let reports: string;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-bm-shadow-"));
    home = path.join(tmp, "home");
    vault = path.join(tmp, "vault");
    store = path.join(tmp, "remote-store");
    stubBin = path.join(tmp, "cortex-stub");
    stubLog = path.join(tmp, "stub-args.log");
    garrisonHome = path.join(tmp, "garrison-home");
    reports = path.join(tmp, "reports");
    await fsp.mkdir(home, { recursive: true });
    const impl = path.join(tmp, "stub-impl.cjs");
    await fsp.writeFile(impl, STUB_IMPL, "utf8");
    await fsp.writeFile(
      stubBin,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$STUB_LOG"\nexec node ${JSON.stringify(impl)} "$@"\n`,
      { mode: 0o755 }
    );
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  async function seedNote(rel: string, body: string): Promise<string> {
    const full = path.join(vault, rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, body, "utf8");
    return full;
  }

  function note(name: string, sentinel: string): string {
    return `---\ntitle: ${name}\ntype: note\n---\n# ${name}\n\n${sentinel}\n`;
  }

  async function seedRemote(permalink: string, body: string): Promise<void> {
    await fsp.mkdir(store, { recursive: true });
    await fsp.writeFile(path.join(store, encodeURIComponent(permalink)), body, "utf8");
  }

  function remoteKeys(): string[] {
    try {
      return fs.readdirSync(store).map(decodeURIComponent).sort();
    } catch {
      return [];
    }
  }

  function stubCalls(): string[] {
    if (!fs.existsSync(stubLog)) return [];
    return fs.readFileSync(stubLog, "utf8").trim().split("\n").filter(Boolean);
  }

  function cliEnv(extra: Record<string, string | undefined> = {}) {
    return {
      HOME: home,
      GARRISON_HOME: garrisonHome,
      BASIC_MEMORY_VAULT_DIR: vault,
      BASIC_MEMORY_MEMORY_DIR: "Memory",
      BASIC_MEMORY_REMOTE_FOLDER: "vault",
      REMOTE_MEMORY_CLI_BIN: stubBin,
      STUB_LOG: stubLog,
      STUB_STORE: store,
      ...extra
    };
  }

  /** Every file under the vault, by content hash - the immutability witness. */
  function vaultSnapshot(dir = vault, base = vault): Record<string, string> {
    const out: Record<string, string> = {};
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) Object.assign(out, vaultSnapshot(full, base));
      else if (entry.isFile()) out[path.relative(base, full)] = sha(fs.readFileSync(full, "utf8"));
    }
    return out;
  }

  async function writeMarker(firstAt: string, dueAt: string): Promise<void> {
    const dir = path.join(garrisonHome, "basic-memory");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, "shadow-write.json"),
      JSON.stringify({ first_dual_write_at: firstAt, review_window_days: 14, review_due_at: dueAt }, null, 2)
    );
  }

  function todaysReport(): string {
    const day = new Date().toISOString().slice(0, 10);
    return path.join(reports, `${day}-memory-backend-compare.md`);
  }

  // ── the one-time import ────────────────────────────────────────────────
  describe("import-vault.mjs (one-time, re-runnable, verified)", () => {
    async function seedThree(): Promise<void> {
      await seedNote("Memory/alpha.md", note("Alpha", "SENTINEL-BODY-ALPHA"));
      await seedNote("Memory/beta.md", note("Beta", "SENTINEL-BODY-BETA"));
      await seedNote("Memory/2026/Nested Note.md", note("Nested", "SENTINEL-BODY-NESTED"));
    }

    it("maps every note to a path-derived permalink and verifies the result", async () => {
      await seedThree();
      const result = await run("node", [IMPORT], cliEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("scanned 3 | sent 3 | skipped 0 | failed 0");
      expect(result.stdout).toContain("import complete and verified");
      expect(result.stdout).toContain("verify counts: expected 3 in 'vault' | remote listed 3");
      // The documented mapping: <path relative to the vault, minus .md>
      // slugified whole into ONE slug under ONE folder segment.
      expect(remoteKeys()).toEqual([
        "vault/memory-2026-nested-note",
        "vault/memory-alpha",
        "vault/memory-beta"
      ]);
      const writes = stubCalls().filter((line) => line.startsWith("memory write "));
      expect(writes).toHaveLength(3);
      // The exact CLI contract, argv for argv (the nested note's path carries a
      // space, so the file argument is passed as one argument, not quoted prose).
      expect(writes[0]).toBe(
        `memory write --file ${path.join(vault, "Memory", "2026", "Nested Note.md")} --permalink vault/memory-2026-nested-note --json`
      );
    });

    it("is re-runnable with ZERO duplicates: the permalink is the identity", async () => {
      await seedThree();
      const first = await run("node", [IMPORT], cliEnv());
      const second = await run("node", [IMPORT], cliEnv());

      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("scanned 3 | sent 3 | skipped 0 | failed 0");
      // Six writes, three notes: the second run overwrote rather than added.
      const writes = stubCalls().filter((line) => line.startsWith("memory write "));
      expect(writes).toHaveLength(6);
      expect(remoteKeys()).toHaveLength(3);
      const permalinks = writes.map((line) => /--permalink (\S+)/.exec(line)?.[1]);
      expect(new Set(permalinks).size).toBe(3);
    });

    it("skips everything that is not a note, and says how many of what", async () => {
      await seedNote("Memory/real.md", note("Real", "SENTINEL-BODY-REAL"));
      await seedNote("Memory/notes.txt", "not markdown");
      await seedNote("Memory/.hidden.md", note("Hidden", "SENTINEL-BODY-HIDDEN"));
      await seedNote("Memory/blank.md", "   \n\n");

      const result = await run("node", [IMPORT], cliEnv());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("scanned 4 | sent 1 | skipped 3 | failed 0");
      expect(result.stdout).toMatch(/skipped breakdown: .*not-markdown=1/);
      expect(result.stdout).toMatch(/skipped breakdown: .*hidden=1/);
      expect(result.stdout).toMatch(/skipped breakdown: .*empty=1/);
      expect(remoteKeys()).toEqual(["vault/memory-real"]);
    });

    it("--dry-run prints the whole mapping and invokes the CLI zero times", async () => {
      await seedThree();
      const result = await run("node", [IMPORT, "--dry-run"], cliEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("would import Memory/alpha.md -> vault/memory-alpha");
      expect(result.stdout).toContain(
        "would import Memory/2026/Nested Note.md -> vault/memory-2026-nested-note"
      );
      expect(result.stdout).toContain("dry run: scanned 3 | would send 3 | skipped 0 | failed 0");
      expect(result.stdout).toContain("the remote CLI was not invoked and nothing was sent");
      expect(remoteKeys()).toEqual([]);
      await expect(fsp.stat(stubLog)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("verification catches a note the backend claimed to accept but never stored", async () => {
      await seedThree();
      const result = await run(
        "node",
        [IMPORT],
        cliEnv({ STUB_DROP_PERMALINK: "vault/memory-beta" })
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("verify counts: expected 3 in 'vault' | remote listed 2");
      expect(result.stderr).toContain("missing: vault/memory-beta");
      expect(result.stderr).toContain("import did NOT complete cleanly");
    });

    it("verification catches a content mismatch, naming the note and never quoting it", async () => {
      await seedThree();
      const result = await run(
        "node",
        [IMPORT],
        cliEnv({ STUB_CORRUPT_PERMALINK: "vault/memory-beta" })
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("CONTENT MISMATCH vault/memory-beta");
      expect(result.stderr).toMatch(/local sha256 [0-9a-f]{12} \(\d+ chars\) != remote sha256|local sha256 [0-9a-f]{12}/);
      // A note body is confidential: identities and digests only.
      for (const sentinel of ["SENTINEL-BODY-ALPHA", "SENTINEL-BODY-BETA", "SENTINEL-BODY-NESTED"]) {
        expect(result.stdout).not.toContain(sentinel);
        expect(result.stderr).not.toContain(sentinel);
      }
    });

    it("refuses two paths that map to the same permalink instead of overwriting one with the other", async () => {
      await seedNote("Memory/a-b.md", note("Flat", "SENTINEL-BODY-FLAT"));
      await seedNote("Memory/a/b.md", note("Nested", "SENTINEL-BODY-DEEP"));

      const result = await run("node", [IMPORT], cliEnv());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("permalink collision: 2 notes map to vault/memory-a-b");
      expect(result.stderr).toContain("collides: Memory/a-b.md");
      expect(result.stderr).toContain("collides: Memory/a/b.md");
      expect(result.stdout).toContain("scanned 2 | sent 0 | skipped 0 | failed 2");
      expect(remoteKeys()).toEqual([]);
    });

    it("a missing remote CLI is the safe no-op path: nothing sent, exit 0", async () => {
      await seedThree();
      const result = await run(
        "node",
        [IMPORT],
        cliEnv({ REMOTE_MEMORY_CLI_BIN: path.join(tmp, "no-such-cortex") })
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("remote memory CLI not found");
      expect(result.stdout).toContain("vault untouched");
      expect(remoteKeys()).toEqual([]);
    });
  });

  // ── the comparator ────────────────────────────────────────────────────
  describe("compare-backends.mjs (the dated diff report)", () => {
    it("reports a seeded difference and carries the dated review in its header", async () => {
      await seedNote("Memory/alpha.md", note("Alpha", "SENTINEL-BODY-ALPHA"));
      await seedNote("Memory/beta.md", note("Beta", "SENTINEL-BODY-BETA"));
      await seedNote("Memory/gamma.md", note("Gamma", "SENTINEL-BODY-GAMMA"));
      await seedNote("Memory/delta.md", note("Delta", "SENTINEL-BODY-DELTA"));

      // alpha + gamma agree; beta diverges; delta never made it across; and an
      // orphan lives on the remote with no local file.
      await seedRemote("vault/memory-alpha", note("Alpha", "SENTINEL-BODY-ALPHA"));
      await seedRemote("vault/memory-gamma", note("Gamma", "SENTINEL-BODY-GAMMA"));
      await seedRemote("vault/memory-beta", note("Beta", "SENTINEL-BODY-BETA-DRIFTED"));
      await seedRemote("vault/orphan-note", note("Orphan", "SENTINEL-BODY-ORPHAN"));

      await writeMarker("2026-07-01T09:00:00Z", "2026-07-15T09:00:00Z");

      const result = await run(
        "node",
        [COMPARE, "--sample", "10", "--out-dir", reports],
        cliEnv()
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("status diverged");

      const report = await fsp.readFile(todaysReport(), "utf8");

      // The three header fields rule 10 turns on.
      expect(report).toContain("| first dual-write | 2026-07-01T09:00:00.000Z |");
      expect(report).toContain("| review due (first dual-write + 14 days) | 2026-07-15T09:00:00.000Z |");
      expect(report).toContain("**Cut reads over**");
      expect(report).toContain("**Extend ONCE**");
      expect(report).toContain("**Remove**");
      expect(report).toContain("| status | **diverged** |");

      // Counts, set differences and content mismatches reported SEPARATELY.
      expect(report).toContain("| local (vault) | 4 |");
      expect(report).toContain("| remote (folder `vault`) | 4 |");
      expect(report).toContain("| present on both | 3 |");
      expect(report).toContain("| missing on the remote | 1 |");
      expect(report).toContain("| missing locally | 1 |");
      expect(report).toMatch(/## Missing on the remote[\s\S]*?- `vault\/memory-delta`/);
      expect(report).toMatch(/## Missing locally[\s\S]*?- `vault\/orphan-note`/);
      expect(report).toMatch(/\| `vault\/memory-beta` \|[^\n]*\*\*mismatch\*\*/);
      expect(report).toMatch(/\| `vault\/memory-alpha` \|[^\n]*\*\*match\*\*/);
      expect(report).toContain("| sample size | 3 of 3 note(s) present on both sides |");
      expect(report).toContain("## What this report does NOT check");

      // A note body never reaches a report or a log.
      for (const sentinel of [
        "SENTINEL-BODY-ALPHA",
        "SENTINEL-BODY-BETA",
        "SENTINEL-BODY-BETA-DRIFTED",
        "SENTINEL-BODY-ORPHAN"
      ]) {
        expect(report).not.toContain(sentinel);
        expect(result.stdout).not.toContain(sentinel);
        expect(result.stderr).not.toContain(sentinel);
      }
    });

    it("states its own sample size and never claims parity beyond it", async () => {
      for (const name of ["one", "two", "three", "four", "five", "six"]) {
        const body = note(name, `SENTINEL-BODY-${name.toUpperCase()}`);
        await seedNote(`Memory/${name}.md`, body);
        await seedRemote(`vault/memory-${name}`, body);
      }
      await writeMarker("2026-07-01T09:00:00Z", "2026-07-15T09:00:00Z");

      const result = await run("node", [COMPARE, "--sample", "2", "--out-dir", reports], cliEnv());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("status parity-on-sample");

      const report = await fsp.readFile(todaysReport(), "utf8");
      expect(report).toContain("| sample size | 2 of 6 note(s) present on both sides |");
      expect(report).toContain("| status | **parity-on-sample** |");
      expect(report).toContain("## Content sample (2 of 6)");
      expect(report).toContain("**The content of the 4 shared note(s) outside the sample.**");
      expect(report).toContain("never about the store as a whole");
      // Only two reads, not six: the report's claim matches the work it did.
      expect(stubCalls().filter((line) => line.startsWith("memory read "))).toHaveLength(2);
    });

    it("an unreadable remote listing is INCONCLUSIVE, never an empty remote store", async () => {
      await seedNote("Memory/alpha.md", note("Alpha", "SENTINEL-BODY-ALPHA"));
      await writeMarker("2026-07-01T09:00:00Z", "2026-07-15T09:00:00Z");

      const result = await run(
        "node",
        [COMPARE, "--out-dir", reports],
        cliEnv({ STUB_BAD_LIST: "1" })
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("comparison INCONCLUSIVE");

      const report = await fsp.readFile(todaysReport(), "utf8");
      expect(report).toContain("| status | **inconclusive** |");
      expect(report).toContain("| missing on the remote | not determined |");
      expect(report).toContain("NOT DETERMINED - the remote side was never listed");
    });

    it("no remote CLI: files an inconclusive report and exits 0 rather than erroring", async () => {
      await seedNote("Memory/alpha.md", note("Alpha", "SENTINEL-BODY-ALPHA"));
      const result = await run(
        "node",
        [COMPARE, "--out-dir", reports],
        cliEnv({ REMOTE_MEMORY_CLI_BIN: path.join(tmp, "no-such-cortex") })
      );
      expect(result.exitCode).toBe(0);
      const report = await fsp.readFile(todaysReport(), "utf8");
      expect(report).toContain("| status | **inconclusive** |");
      expect(report).toContain("is not installed on this machine");
      expect(report).toContain("| local (vault) | 1 |");
    });

    it("a missing dual-write marker is reported UNKNOWN, never invented", async () => {
      await seedNote("Memory/alpha.md", note("Alpha", "SENTINEL-BODY-ALPHA"));
      await seedRemote("vault/memory-alpha", note("Alpha", "SENTINEL-BODY-ALPHA"));

      const result = await run("node", [COMPARE, "--out-dir", reports], cliEnv());
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("the review date is UNKNOWN");
      const report = await fsp.readFile(todaysReport(), "utf8");
      expect(report).toContain("UNKNOWN - no dual-write marker on this machine");
    });

    it("--fail-on-diff turns a reported divergence into a nonzero exit", async () => {
      await seedNote("Memory/alpha.md", note("Alpha", "SENTINEL-BODY-ALPHA"));
      await writeMarker("2026-07-01T09:00:00Z", "2026-07-15T09:00:00Z");

      const reported = await run("node", [COMPARE, "--out-dir", reports], cliEnv());
      expect(reported.exitCode).toBe(0); // a difference is REPORTED, not an error

      const gated = await run("node", [COMPARE, "--out-dir", reports, "--fail-on-diff"], cliEnv());
      expect(gated.exitCode).toBe(1);
    });

    it("never mutates the local vault - import and compare are read-only over it", async () => {
      await seedNote("Memory/alpha.md", note("Alpha", "SENTINEL-BODY-ALPHA"));
      await seedNote("Memory/2026/Nested Note.md", note("Nested", "SENTINEL-BODY-NESTED"));
      await seedNote("Memory/notes.txt", "not markdown");
      const before = vaultSnapshot();
      expect(Object.keys(before)).toHaveLength(3);

      expect((await run("node", [IMPORT], cliEnv())).exitCode).toBe(0);
      expect((await run("node", [COMPARE, "--out-dir", reports], cliEnv())).exitCode).toBe(0);

      expect(vaultSnapshot()).toEqual(before);
    });
  });

  // ── setup.sh: shadow dual-write ────────────────────────────────────────
  describe("setup.sh: shadow dual-write", () => {
    let claudeHome: string;
    let comp: string;
    let setupPath: string;
    let binDir: string;
    let setupLog: string;
    let stubState: string;
    let jobsFile: string;
    let spoolDir: string;
    let installedSkillPath: string;

    /** A stub CLI: logs its argv, then answers the state questions setup.sh asks. */
    const stub = (name: string, body: string) =>
      `#!/bin/sh\nprintf '${name} %s\\n' "$*" >> "$STUB_LOG"\n${body}\nexit 0\n`;

    const SETUP_STUBS: Record<string, string> = {
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

    beforeEach(async () => {
      claudeHome = path.join(home, ".claude");
      comp = path.join(tmp, "comp");
      const fitting = path.join(comp, "apm_modules", "_local", "basic-memory");
      setupPath = path.join(fitting, "scripts", "setup.sh");
      binDir = path.join(tmp, "setup-bin");
      setupLog = path.join(tmp, "setup-calls.log");
      stubState = path.join(tmp, "setup-stub-state");
      jobsFile = path.join(tmp, "scheduler-jobs.json");
      spoolDir = path.join(tmp, "spool");
      installedSkillPath = path.join(comp, ".claude", "skills", "garrison-memory", "SKILL.md");

      await fsp.mkdir(stubState, { recursive: true });
      await fsp.mkdir(binDir, { recursive: true });
      for (const [name, body] of Object.entries(SETUP_STUBS)) {
        await fsp.writeFile(path.join(binDir, name), body, { mode: 0o755 });
      }
      await fsp.mkdir(path.dirname(fitting), { recursive: true });
      await fsp.cp(FITTING_SRC, fitting, { recursive: true });
      const schedulerDir = path.join(comp, "apm_modules", "_local", "scheduler", "scripts");
      await fsp.mkdir(schedulerDir, { recursive: true });
      await fsp.cp(SCHEDULER_SRC, path.join(schedulerDir, "scheduler.mjs"));
      await fsp.mkdir(path.dirname(installedSkillPath), { recursive: true });
      await fsp.cp(LOCAL_SKILL_SRC, installedSkillPath);
    });

    function runSetup(overrides: Record<string, string | undefined> = {}) {
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
        GARRISON_HOME: garrisonHome,
        GARRISON_SCHEDULER_JOBS: jobsFile,
        GARRISON_SCHEDULER_LOG: path.join(tmp, "scheduler.log"),
        BASIC_MEMORY_VAULT_DIR: vault,
        BASIC_MEMORY_SPOOL_DIR: spoolDir,
        STUB_LOG: setupLog,
        STUB_STATE: stubState
      });
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
      return spawnSync("bash", [setupPath], {
        env: env as NodeJS.ProcessEnv,
        encoding: "utf8",
        timeout: 120_000
      });
    }

    const bmBin = () => path.join(binDir, "basic-memory");
    function setupCalls(): string[] {
      if (!fs.existsSync(setupLog)) return [];
      return fs.readFileSync(setupLog, "utf8").trim().split("\n").filter(Boolean);
    }
    /** The exact CLI conversation the local backend has on a first run. */
    const stockCalls = () => [
      "basic-memory --version",
      "basic-memory project info main",
      `basic-memory project add main ${vault}`,
      "basic-memory project default main",
      "claude mcp get basic-memory",
      `claude mcp add -s user basic-memory -- ${bmBin()} mcp`,
      "codex mcp get basic-memory",
      `codex mcp add basic-memory -- ${bmBin()} mcp`,
      "gemini mcp list",
      `gemini mcp add -s user basic-memory ${bmBin()} mcp`
    ];
    function hookCommand(): string {
      const settings = JSON.parse(
        fs.readFileSync(path.join(claudeHome, "settings.json"), "utf8")
      ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
      return settings.hooks.SessionEnd[0].hooks[0].command;
    }
    function jobs(): Array<{ id: string; cron: string; command: string }> {
      if (!fs.existsSync(jobsFile)) return [];
      return JSON.parse(fs.readFileSync(jobsFile, "utf8"));
    }
    const job = (id: string) => jobs().find((entry) => entry.id === id);
    const markerPath = () => path.join(garrisonHome, "basic-memory", "shadow-write.json");
    const marker = () => JSON.parse(fs.readFileSync(markerPath(), "utf8"));

    it("shadow OFF (the default) changes nothing at all", () => {
      const result = runSetup();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);

      expect(setupCalls()).toEqual(stockCalls());
      expect(hookCommand()).not.toContain("BASIC_MEMORY_SPOOL_ENABLED");
      expect(fs.existsSync(jobsFile)).toBe(false);
      expect(fs.existsSync(markerPath())).toBe(false);
      expect(fs.existsSync(path.join(claudeHome, "basic-memory", "compare-backends.mjs"))).toBe(false);
      expect(fs.existsSync(path.join(claudeHome, "basic-memory", "import-vault.mjs"))).toBe(false);
      expect(fs.existsSync(path.join(claudeHome, "basic-memory", "lib"))).toBe(false);
      expect(fs.existsSync(path.join(claudeHome, "basic-memory", "flush-spool.mjs"))).toBe(false);
      expect(fs.readFileSync(installedSkillPath, "utf8")).toBe(
        fs.readFileSync(LOCAL_SKILL_SRC, "utf8")
      );
    });

    it("shadow ON keeps the local backend exactly as it was and only ADDS the remote path", () => {
      const result = runSetup({ BASIC_MEMORY_SHADOW_WRITE: "true" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);

      // Local side untouched: same MCP conversation, same local skill variant.
      expect(setupCalls()).toEqual(stockCalls());
      expect(fs.readFileSync(installedSkillPath, "utf8")).toBe(
        fs.readFileSync(LOCAL_SKILL_SRC, "utf8")
      );

      // Remote side added: the capture is spooled, the drain and the daily
      // comparator are registered, and the scripts are staged.
      expect(hookCommand()).toContain("BASIC_MEMORY_SPOOL_ENABLED=1");
      expect(job(FLUSH_JOB_ID)).toBeDefined();
      const compare = job(COMPARE_JOB_ID);
      expect(compare).toBeDefined();
      expect(compare!.cron).toBe("27 4 * * *");
      expect(compare!.command).toContain("compare-backends.mjs");
      expect(compare!.command).toContain(`BASIC_MEMORY_COMPARE_REPORT_DIR=${comp}/data/memory-backend-compare`);
      expect(compare!.command).toContain("BASIC_MEMORY_REMOTE_FOLDER=vault");
      expect(compare!.command).toContain(`GARRISON_HOME=${garrisonHome}`);
      for (const rel of ["compare-backends.mjs", "import-vault.mjs", "lib/memory-vault.mjs"]) {
        expect(fs.existsSync(path.join(claudeHome, "basic-memory", rel))).toBe(true);
      }
    });

    it("stamps the dual-write marker with a review date 14 days out, and never resets it", () => {
      expect(runSetup({ BASIC_MEMORY_SHADOW_WRITE: "true" }).status).toBe(0);
      const first = marker();
      expect(first.review_window_days).toBe(14);
      const started = new Date(first.first_dual_write_at).getTime();
      const due = new Date(first.review_due_at).getTime();
      expect(due - started).toBe(14 * 86_400_000);

      // Re-running, and even toggling shadow off and on again, must not move
      // the deadline - the review date is fixed at the FIRST dual-write.
      expect(runSetup({ BASIC_MEMORY_SHADOW_WRITE: "true" }).status).toBe(0);
      expect(runSetup().status).toBe(0);
      expect(fs.existsSync(markerPath())).toBe(true);
      expect(runSetup({ BASIC_MEMORY_SHADOW_WRITE: "true" }).status).toBe(0);
      expect(marker()).toEqual(first);
    });

    it("registers the daily comparison job only while shadow is on, and retires it when off", () => {
      expect(runSetup().status).toBe(0);
      expect(job(COMPARE_JOB_ID)).toBeUndefined();
      expect(fs.existsSync(jobsFile)).toBe(false); // default-off touches nothing

      expect(runSetup({ BASIC_MEMORY_SHADOW_WRITE: "true" }).status).toBe(0);
      expect(job(COMPARE_JOB_ID)).toBeDefined();

      expect(runSetup().status).toBe(0);
      expect(job(COMPARE_JOB_ID)).toBeUndefined();
      expect(job(FLUSH_JOB_ID)).toBeUndefined();
      expect(hookCommand()).not.toContain("BASIC_MEMORY_SPOOL_ENABLED");
    });

    it("shadow_write with spool_enabled=never is INERT, and setup says so every run", () => {
      const result = runSetup({
        BASIC_MEMORY_SHADOW_WRITE: "true",
        BASIC_MEMORY_SPOOL_ENABLED: "never"
      });
      expect(result.status).toBe(0);
      // Precedence: the explicit opt-out still wins over the implicit switch...
      expect(result.stdout).toContain("the shadow is INERT until spool_enabled is auto or always");
      expect(hookCommand()).not.toContain("BASIC_MEMORY_SPOOL_ENABLED");
      expect(job(FLUSH_JOB_ID)).toBeUndefined();
      // ...but the comparator is gated on SHADOW, so it still runs and will
      // report every note as missing on the remote - which is the truth.
      expect(job(COMPARE_JOB_ID)).toBeDefined();
    });

    it("writes BOTH sides, with the local write byte-identical to the no-shadow one", async () => {
      const payload = JSON.stringify({
        session_id: SESSION_ID,
        cwd: path.join(tmp, "proj"),
        hook_event_name: "SessionEnd",
        transcript_path: ""
      });
      const hookEnv = {
        HOME: home,
        BASIC_MEMORY_SPOOL_AUTOFLUSH: "0",
        BASIC_MEMORY_SPOOL_CAP_BYTES: undefined,
        STUB_LOG: undefined,
        STUB_STATE: undefined
      };

      expect(runSetup({ BASIC_MEMORY_SHADOW_WRITE: "true" }).status).toBe(0);
      const shadowRun = await run("bash", ["-c", hookCommand()], hookEnv, payload);
      expect(shadowRun.exitCode).toBe(0);

      const shadowNotes = (await fsp.readdir(path.join(vault, "Memory"))).filter((n) =>
        n.startsWith("session-")
      );
      const spooled = (await fsp.readdir(spoolDir)).filter((n) => /^capture-.*\.md$/.test(n));
      expect(shadowNotes).toHaveLength(1);
      expect(spooled).toHaveLength(1);
      const localBody = await fsp.readFile(path.join(vault, "Memory", shadowNotes[0]), "utf8");
      const spoolBody = await fsp.readFile(path.join(spoolDir, spooled[0]), "utf8");
      // Shadow ADDS a destination: the enqueued capture is the same markdown.
      expect(spoolBody).toBe(localBody);

      // Now the control: the same hook with shadow OFF, into its own vault so
      // the two captures cannot land on the same filename in the same second.
      const controlVault = path.join(tmp, "control-vault");
      expect(runSetup({ BASIC_MEMORY_VAULT_DIR: controlVault }).status).toBe(0);
      const stockRun = await run("bash", ["-c", hookCommand()], hookEnv, payload);
      expect(stockRun.exitCode).toBe(0);
      const controlNotes = (await fsp.readdir(path.join(controlVault, "Memory"))).filter((n) =>
        n.startsWith("session-")
      );
      expect(controlNotes).toHaveLength(1);
      const stockBody = await fsp.readFile(
        path.join(controlVault, "Memory", controlNotes[0]),
        "utf8"
      );
      // The clock is the only difference: shadow adds a destination, it does
      // not touch a single byte of what the local vault receives.
      expect(withoutTimestamps(localBody)).toBe(withoutTimestamps(stockBody));
      // And no second spool file appeared once the shadow was off.
      expect((await fsp.readdir(spoolDir)).filter((n) => /^capture-.*\.md$/.test(n))).toHaveLength(1);
    });
  });
});
