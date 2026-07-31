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
const CAPTURE = path.join(SCRIPTS, "capture-session.py");
const FLUSH = path.join(SCRIPTS, "flush-spool.mjs");
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

  /**
   * A dual-write marker `daysAgo` days old. Relative to the clock on purpose:
   * a fixed date would silently become OVERDUE as the calendar moved, and an
   * overdue review is now a non-zero exit (F7), so the fixture has to say which
   * side of the deadline it is testing.
   */
  async function writeMarker(daysAgo: number, overrides: Record<string, unknown> = {}) {
    const dir = path.join(garrisonHome, "basic-memory");
    await fsp.mkdir(dir, { recursive: true });
    const started = new Date(Date.now() - daysAgo * 86_400_000);
    const due = new Date(started.getTime() + 14 * 86_400_000);
    await fsp.writeFile(
      path.join(dir, "shadow-write.json"),
      JSON.stringify(
        {
          first_dual_write_at: started.toISOString(),
          review_window_days: 14,
          review_due_at: due.toISOString(),
          ...overrides
        },
        null,
        2
      )
    );
    return { started, due };
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

    // F3 - a chmod-000 subtree used to be reported as "complete", exit 0.
    it("an unreadable directory is a LOUD nonzero outcome, never a silent drop", async () => {
      await seedNote("Memory/alpha.md", note("Alpha", "SENTINEL-BODY-ALPHA"));
      await seedNote("Memory/private/one.md", note("One", "SENTINEL-BODY-ONE"));
      await seedNote("Memory/private/two.md", note("Two", "SENTINEL-BODY-TWO"));
      const locked = path.join(vault, "Memory", "private");
      await fsp.chmod(locked, 0o000);
      try {
        const result = await run("node", [IMPORT], cliEnv());
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          "cannot read Memory/private/ - an unknown number of notes under it were NEITHER scanned NOR imported"
        );
        expect(result.stdout).not.toContain("import complete and verified");
        expect(result.stderr).toContain("unreadable director(ies)");
        // The one readable note still went across - the run is loud, not aborted.
        expect(remoteKeys()).toEqual(["vault/memory-alpha"]);
      } finally {
        await fsp.chmod(locked, 0o755);
      }
    });

    // F4 - `--folder "My Vault"` used to list one namespace and write another.
    it("normalises a non-slug remote folder ONCE, so the write and the listing agree", async () => {
      await seedNote("Memory/alpha.md", note("Alpha", "SENTINEL-BODY-ALPHA"));
      const result = await run("node", [IMPORT, "--folder", "My Vault"], cliEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("normalised to 'my-vault'");
      expect(remoteKeys()).toEqual(["my-vault/memory-alpha"]);
      expect(result.stderr).not.toContain("missing:");
      // And the comparator agrees with it, rather than hunting in `My Vault`.
      await writeMarker(2);
      const compared = await run(
        "node",
        [COMPARE, "--folder", "My Vault", "--out-dir", reports],
        cliEnv()
      );
      expect(compared.exitCode).toBe(0);
      expect(compared.stdout).toContain("status parity-on-sample");
      const report = await fsp.readFile(todaysReport(), "utf8");
      expect(report).toContain("| remote folder | `my-vault` (normalised from `My Vault`) |");
    });

    // F6 - "import complete and verified" used to print for runs that verified nothing.
    it("the LAST line never says verified for a run that verified nothing", async () => {
      await seedThree();

      const skipped = await run("node", [IMPORT, "--no-verify"], cliEnv());
      expect(skipped.exitCode).toBe(0);
      expect(skipped.stdout).not.toContain("import complete and verified");
      expect(skipped.stdout.trim().split("\n").pop()).toContain(
        "import complete; NOT verified (--no-verify)"
      );

      const unsampled = await run("node", [IMPORT, "--sample", "0"], cliEnv());
      expect(unsampled.exitCode).toBe(0);
      expect(unsampled.stdout).not.toContain("import complete and verified");
      expect(unsampled.stdout).toContain("content was compared on ZERO notes");

      const full = await run("node", [IMPORT], cliEnv());
      expect(full.stdout).toContain("import complete and verified (set + content on 3 sampled note(s))");
    });

    // F11 - a listing at the cap used to produce a false "missing" list.
    it("a verification listing at the --limit is INCONCLUSIVE, not a data-loss report", async () => {
      await seedThree();
      const result = await run("node", [IMPORT, "--limit", "3"], cliEnv());

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("verification INCONCLUSIVE");
      expect(result.stderr).toContain("at or above the --limit of 3, so it may be truncated");
      expect(result.stderr).not.toContain("missing:"); // no false alarm from a cut listing
      expect(remoteKeys()).toHaveLength(3); // the notes really did go across
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

      const review = await writeMarker(2);

      const result = await run(
        "node",
        [COMPARE, "--sample", "10", "--out-dir", reports],
        cliEnv()
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("status diverged");

      const report = await fsp.readFile(todaysReport(), "utf8");

      // The three header fields rule 10 turns on.
      expect(report).toContain(`| first dual-write | ${review.started.toISOString()} |`);
      expect(report).toContain(
        `| review due (first dual-write + 14 days) | ${review.due.toISOString()} |`
      );
      expect(report).toContain("| days remaining | 11 |");
      expect(report).toContain("**Cut reads over**");
      expect(report).toContain("**Extend ONCE**");
      expect(report).toContain("**Remove**");
      expect(report).toContain("| status | **diverged** |");

      // Counts, set differences and content mismatches reported SEPARATELY.
      expect(report).toContain("| local notes found | 4 |");
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
      await writeMarker(2);

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
      await writeMarker(2);

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
      expect(report).toContain("| local notes found | 1 |");
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
      await writeMarker(2);

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

    // F2 - `parity-on-sample` used to be reachable with NOTHING compared.
    it("a missing vault root is INCONCLUSIVE and nonzero, never a clean parity report", async () => {
      await writeMarker(2);
      const result = await run(
        "node",
        [COMPARE, "--out-dir", reports],
        cliEnv({ BASIC_MEMORY_VAULT_DIR: path.join(tmp, "not-mounted") })
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout).not.toContain("parity-on-sample");
      expect(result.stderr).toContain("does not exist; comparison INCONCLUSIVE");
      const report = await fsp.readFile(todaysReport(), "utf8");
      expect(report).toContain("| status | **inconclusive** |");
      expect(report).toContain("**MISSING**");
      expect(report).toContain("this is NOT a report that the two agree");
    });

    it("a sample of zero is INCONCLUSIVE: a comparison that compared nothing found nothing", async () => {
      const body = note("Alpha", "SENTINEL-BODY-ALPHA");
      await seedNote("Memory/alpha.md", body);
      await seedRemote("vault/memory-alpha", body);
      await writeMarker(2);

      const result = await run("node", [COMPARE, "--sample", "0", "--out-dir", reports], cliEnv());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("status inconclusive");
      expect(result.stderr).toContain("not parity: the sample size is 0");
      const report = await fsp.readFile(todaysReport(), "utf8");
      expect(report).toContain("| status | **inconclusive** |");
      expect(report).toContain("no difference was found, but this is NOT parity");
    });

    it("an empty vault against an empty store is INCONCLUSIVE, not parity", async () => {
      await fsp.mkdir(path.join(vault, "Memory"), { recursive: true });
      await writeMarker(2);
      const result = await run("node", [COMPARE, "--out-dir", reports], cliEnv());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("status inconclusive");
      expect(result.stderr).toContain("no note was present on both sides");
    });

    // F3 - an unreadable directory used to vanish from both tools.
    it("refuses to claim parity while part of the vault cannot be read", async () => {
      const body = note("Alpha", "SENTINEL-BODY-ALPHA");
      await seedNote("Memory/alpha.md", body);
      await seedRemote("vault/memory-alpha", body);
      await seedNote("Memory/private/secret.md", note("Secret", "SENTINEL-BODY-SECRET"));
      const locked = path.join(vault, "Memory", "private");
      await fsp.chmod(locked, 0o000);
      await writeMarker(2);
      try {
        const result = await run("node", [COMPARE, "--sample", "5", "--out-dir", reports], cliEnv());
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("status inconclusive");
        expect(result.stderr).toContain("cannot read Memory/private/");
        const report = await fsp.readFile(todaysReport(), "utf8");
        expect(report).toContain("| local directories unreadable | 1 |");
        expect(report).toContain("Part of the vault could not be read");
      } finally {
        await fsp.chmod(locked, 0o755);
      }
    });

    // F5 - the truncation warning used to name the column that is fine.
    it("a truncated listing is INCONCLUSIVE and names the column truncation actually poisons", async () => {
      for (const name of ["one", "two", "three", "four", "five", "six"]) {
        const body = note(name, `SENTINEL-BODY-${name.toUpperCase()}`);
        await seedNote(`Memory/${name}.md`, body);
        await seedRemote(`vault/memory-${name}`, body);
      }
      await writeMarker(2);

      const result = await run(
        "node",
        [COMPARE, "--limit", "3", "--sample", "5", "--out-dir", reports],
        cliEnv()
      );
      expect(result.exitCode).toBe(0);
      // Every note IS present remotely; the cut is what makes three look absent.
      expect(result.stdout).toContain("status inconclusive");
      expect(result.stdout).not.toContain("status diverged");
      const report = await fsp.readFile(todaysReport(), "utf8");
      expect(report).toContain("| status | **inconclusive** |");
      expect(report).toContain("at or above the `--limit` of 3");
      expect(report).toContain("inflate **missing on the remote**");
      expect(report).toContain('it can only ever SHRINK "missing locally"');
    });

    // F7 - the deadline used to go red only inside the markdown file.
    it("an overdue review is LOUD on stderr and exits nonzero, even with the two sides in parity", async () => {
      const body = note("Alpha", "SENTINEL-BODY-ALPHA");
      await seedNote("Memory/alpha.md", body);
      await seedRemote("vault/memory-alpha", body);
      await writeMarker(20); // started 20 days ago; the 14-day review is 6 days past

      const result = await run("node", [COMPARE, "--out-dir", reports], cliEnv());
      expect(result.stdout).toContain("status parity-on-sample"); // the data is fine...
      expect(result.exitCode).toBe(1); // ...and the run still fails, because the review is late
      expect(result.stderr).toMatch(/REVIEW OVERDUE by 6 day\(s\)/);
      expect(result.stderr).toContain("cut reads over, extend ONCE with a written reason, or remove");
      const report = await fsp.readFile(todaysReport(), "utf8");
      expect(report).toContain("**OVERDUE**");
    });

    // N1 - the overdue gate used to FAIL OPEN on every early return, and the
    // worst of those returned 0: "the remote CLI is not installed", which is
    // exactly the furniture configuration (shadow on, CLI never installed,
    // nothing has ever worked).
    it("an overdue review still exits nonzero with NO remote CLI installed", async () => {
      await seedNote("Memory/alpha.md", note("Alpha", "SENTINEL-BODY-ALPHA"));
      await writeMarker(60); // 46 days past the 14-day review

      const result = await run(
        "node",
        [COMPARE, "--out-dir", reports, "--fail-on-diff"],
        cliEnv({ REMOTE_MEMORY_CLI_BIN: path.join(tmp, "no-such-cortex") })
      );
      expect(result.stdout).toContain("remote memory CLI not found");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/REVIEW OVERDUE by 46 day\(s\)/);
      const report = await fsp.readFile(todaysReport(), "utf8");
      expect(report).toContain("**OVERDUE**");
    });

    it("the review gate is evaluated on EVERY early exit, not just the happy path", async () => {
      await seedNote("Memory/alpha.md", note("Alpha", "SENTINEL-BODY-ALPHA"));
      await writeMarker(60);

      // Four different ways for the comparison to stop short; the deadline is
      // announced and enforced on all of them.
      const branches: Array<[string, Record<string, string | undefined>]> = [
        ["no CLI", { REMOTE_MEMORY_CLI_BIN: path.join(tmp, "no-such-cortex") }],
        ["unparseable listing", { STUB_BAD_LIST: "1" }],
        ["listing failed", { STUB_FAIL: "1" }],
        ["missing vault root", { BASIC_MEMORY_VAULT_DIR: path.join(tmp, "not-mounted") }]
      ];
      for (const [label, env] of branches) {
        const result = await run("node", [COMPARE, "--out-dir", reports], cliEnv(env));
        expect(result.exitCode, `${label}: exit code`).toBe(1);
        expect(result.stderr, `${label}: overdue line`).toContain("REVIEW OVERDUE");
      }
    });

    // F8 - the comparator used to keep the first of a colliding pair.
    it("excludes BOTH members of a colliding pair and keeps the counts adding up", async () => {
      await seedNote("Memory/a-b.md", note("Flat", "SENTINEL-BODY-FLAT"));
      await seedNote("Memory/a/b.md", note("Deep", "SENTINEL-BODY-DEEP"));
      const body = note("Alpha", "SENTINEL-BODY-ALPHA");
      await seedNote("Memory/alpha.md", body);
      await seedRemote("vault/memory-alpha", body);
      await writeMarker(2);

      const result = await run("node", [COMPARE, "--sample", "5", "--out-dir", reports], cliEnv());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("status inconclusive");
      const report = await fsp.readFile(todaysReport(), "utf8");
      expect(report).toContain("| local notes found | 3 |");
      expect(report).toContain("| local notes compared | 1 |");
      expect(report).toContain("| local notes excluded (permalink collision) | 2 |");
      expect(report).toContain("_The first three rows add up: 1 compared + 2 excluded = 3 found._");
      // The colliding permalink is NOT reported as missing on the remote: it was
      // never comparable in the first place.
      expect(report).toMatch(/## Missing on the remote\n\n[\s\S]*?\n\n_none_/);
      expect(report).toContain("ALL members are excluded");
    });

    // F10 - the marker's own numbers used to be taken at face value.
    it("a hand-extended review window is flagged and the standing deadline still applies", async () => {
      const body = note("Alpha", "SENTINEL-BODY-ALPHA");
      await seedNote("Memory/alpha.md", body);
      await seedRemote("vault/memory-alpha", body);
      // Started 20 days ago, but someone rewrote the marker to give themselves 90.
      const started = new Date(Date.now() - 20 * 86_400_000);
      await writeMarker(20, {
        review_window_days: 90,
        review_due_at: new Date(started.getTime() + 90 * 86_400_000).toISOString()
      });

      const result = await run("node", [COMPARE, "--out-dir", reports], cliEnv());
      expect(result.exitCode).toBe(1); // the standing 14-day deadline is 6 days past
      expect(result.stderr).toContain("REVIEW OVERDUE");
      expect(result.stderr).toContain("records a LONGER window than the standing 14 days");
      const report = await fsp.readFile(todaysReport(), "utf8");
      expect(report).toContain("| marker window | **HAND-EXTENDED**");
      expect(report).toContain("**OVERDUE**");
    });
  });

  // ── F1: the shadow and the comparator must agree on what a note IS ──────
  describe("the round trip: hook -> spool -> drain -> compare", () => {
    it("the comparator SEES a capture the shadow actually shipped", async () => {
      const spool = path.join(tmp, "roundtrip-spool");
      const payload = JSON.stringify({
        session_id: SESSION_ID,
        cwd: path.join(tmp, "proj"),
        hook_event_name: "SessionEnd",
        transcript_path: ""
      });

      // 1. The hook writes the vault note AND spools a copy.
      const captured = await run(
        "python3",
        [CAPTURE],
        cliEnv({
          BASIC_MEMORY_SPOOL_ENABLED: "1",
          BASIC_MEMORY_SPOOL_DIR: spool,
          BASIC_MEMORY_SPOOL_AUTOFLUSH: "0"
        }),
        payload
      );
      expect(captured.exitCode).toBe(0);
      const vaultNotes = (await fsp.readdir(path.join(vault, "Memory"))).filter((n) =>
        n.startsWith("session-")
      );
      expect(vaultNotes).toHaveLength(1);

      // 2. The drain ships it.
      const drained = await run("node", [FLUSH], cliEnv({ BASIC_MEMORY_SPOOL_DIR: spool }));
      expect(drained.exitCode).toBe(0);
      expect(drained.stdout).toContain("flushed 1 capture(s)");
      expect(drained.stdout).not.toContain("no usable identity sidecar");
      expect((await fsp.readdir(spool)).sort()).toEqual([]); // capture + sidecar both gone

      // 3. The remote note carries the SAME identity the comparator derives
      // from the vault path - one note, not two.
      const expectedPermalink = `vault/memory-session-${vaultNotes[0]
        .replace(/^session-/, "")
        .replace(/\.md$/, "")}`;
      expect(remoteKeys()).toEqual([expectedPermalink]);
      expect(
        stubCalls().filter((line) => line.startsWith("memory write "))[0]
      ).toContain(`--permalink ${expectedPermalink} `);

      // 4. So the comparator finds it. This is the whole point: with a working
      // shadow, parity is REACHABLE.
      await writeMarker(2);
      const compared = await run("node", [COMPARE, "--sample", "5", "--out-dir", reports], cliEnv());
      expect(compared.exitCode).toBe(0);
      expect(compared.stdout).toContain("on both 1 | missing on remote 0 | missing locally 0");
      expect(compared.stdout).toContain("status parity-on-sample");

      const report = await fsp.readFile(todaysReport(), "utf8");
      expect(report).toContain("| status | **parity-on-sample** |");
      expect(report).toMatch(/## Missing on the remote\n\n[\s\S]*?\n\n_none_/);
    });

    it("a re-import after the drain overwrites that same note instead of storing it twice", async () => {
      const spool = path.join(tmp, "roundtrip-spool");
      await run(
        "python3",
        [CAPTURE],
        cliEnv({
          BASIC_MEMORY_SPOOL_ENABLED: "1",
          BASIC_MEMORY_SPOOL_DIR: spool,
          BASIC_MEMORY_SPOOL_AUTOFLUSH: "0"
        }),
        JSON.stringify({ session_id: SESSION_ID, cwd: tmp, hook_event_name: "SessionEnd" })
      );
      expect((await run("node", [FLUSH], cliEnv({ BASIC_MEMORY_SPOOL_DIR: spool }))).exitCode).toBe(0);
      expect(remoteKeys()).toHaveLength(1);

      const imported = await run("node", [IMPORT], cliEnv());
      expect(imported.exitCode).toBe(0);
      // ONE note on the remote store, not the same bytes under two identities.
      expect(remoteKeys()).toHaveLength(1);
      expect(imported.stdout).toContain("scanned 1 | sent 1 | skipped 0 | failed 0");
    });

    // N3: the mapping used to exist twice - JS for the import/comparator,
    // Python for the hook - and two implementations of one mapping is one
    // mapping with two answers. The hook now records the note's PATH and only
    // the shared JS module derives permalinks, so THAT is what is pinned: the
    // sidecar holds a path, and no Python file computes a permalink.
    it("the sidecar holds the note PATH and the drain does the deriving", async () => {
      const spool = path.join(tmp, "sidecar-spool");
      const captured = await run(
        "python3",
        [CAPTURE],
        cliEnv({
          BASIC_MEMORY_SPOOL_ENABLED: "1",
          BASIC_MEMORY_SPOOL_DIR: spool,
          BASIC_MEMORY_SPOOL_AUTOFLUSH: "0"
        }),
        JSON.stringify({ session_id: SESSION_ID, cwd: tmp, hook_event_name: "SessionEnd" })
      );
      expect(captured.exitCode).toBe(0);

      const sidecars = (await fsp.readdir(spool)).filter((n) => n.endsWith(".notepath"));
      expect(sidecars).toHaveLength(1);
      const held = (await fsp.readFile(path.join(spool, sidecars[0]), "utf8")).trim();
      // A vault-relative PATH, not a permalink: no folder prefix, keeps `.md`.
      expect(held).toMatch(/^Memory\/session-\d{8}-\d{6}-abc123de\.md$/);
      expect(held).not.toContain("vault/");

      // The permalink appears for the first time at drain, from the shared lib.
      const drained = await run("node", [FLUSH], cliEnv({ BASIC_MEMORY_SPOOL_DIR: spool }));
      expect(drained.exitCode).toBe(0);
      const expected = `vault/${held.replace(/\.md$/, "").replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}`;
      expect(remoteKeys()).toEqual([expected]);

      // And the mapping has exactly one home: no Python file derives a permalink.
      const py = await fsp.readFile(CAPTURE, "utf8");
      expect(py).not.toContain("_remote_permalink");
      expect(py).not.toContain("_slug_segment");
      expect(py).not.toContain("unicodedata");
    });

    // N3 corollary: the folder is resolved at DRAIN time from the same shared
    // helper the comparator uses, so the two cannot drift apart.
    it("the drain honours a non-default remote folder, slugified the same way", async () => {
      const spool = path.join(tmp, "folder-spool");
      await run(
        "python3",
        [CAPTURE],
        cliEnv({
          BASIC_MEMORY_SPOOL_ENABLED: "1",
          BASIC_MEMORY_SPOOL_DIR: spool,
          BASIC_MEMORY_SPOOL_AUTOFLUSH: "0"
        }),
        JSON.stringify({ session_id: SESSION_ID, cwd: tmp, hook_event_name: "SessionEnd" })
      );
      const drained = await run(
        "node",
        [FLUSH],
        cliEnv({ BASIC_MEMORY_SPOOL_DIR: spool, BASIC_MEMORY_REMOTE_FOLDER: "My Vault" })
      );
      expect(drained.exitCode).toBe(0);
      expect(remoteKeys()[0]).toMatch(/^my-vault\/memory-session-/);
    });

    // N2: the hook writes the sidecar and THEN the capture. A drain firing in
    // that window used to sweep the in-flight sidecar as an orphan, and the
    // capture then shipped under the bare queue key - permanently
    // unreconcilable, and a permanently red daily gate.
    it("the orphan sweep leaves an IN-FLIGHT sidecar alone", async () => {
      const spool = path.join(tmp, "race-spool");
      await fsp.mkdir(spool, { recursive: true });
      // A backlog, so the drain has work to do and reaches its sweep...
      await fsp.writeFile(path.join(spool, "capture-old-20260101-000000-1.md"), "backlog\n");
      // ...and a sidecar whose capture has not landed yet: exactly the state
      // the hook is in between its two renames.
      const inFlight = path.join(spool, "capture-inflight-20260101-000001-2.notepath");
      await fsp.writeFile(inFlight, "Memory/session-20260101-000001-abc123de.md\n");

      const drained = await run("node", [FLUSH], cliEnv({ BASIC_MEMORY_SPOOL_DIR: spool }));
      expect(drained.exitCode).toBe(0);
      expect(drained.stdout).toContain("flushed 1 capture(s)");
      expect(drained.stdout).not.toContain("orphan sidecar");
      // Still there, so the capture that follows it ships under its real identity.
      expect(fs.existsSync(inFlight)).toBe(true);

      // Now let the hook finish: the capture lands, and the next drain uses the
      // sidecar rather than the queue key.
      await fsp.writeFile(
        path.join(spool, "capture-inflight-20260101-000001-2.md"),
        "the capture\n"
      );
      const second = await run("node", [FLUSH], cliEnv({ BASIC_MEMORY_SPOOL_DIR: spool }));
      expect(second.exitCode).toBe(0);
      expect(second.stdout).not.toContain("no usable identity sidecar");
      expect(remoteKeys()).toContain("vault/memory-session-20260101-000001-abc123de");
    });

    it("a genuinely stale orphan sidecar is still swept once it is past the grace window", async () => {
      const spool = path.join(tmp, "stale-spool");
      await fsp.mkdir(spool, { recursive: true });
      await fsp.writeFile(path.join(spool, "capture-old-20260101-000000-1.md"), "backlog\n");
      const stale = path.join(spool, "capture-gone-20260101-000001-2.notepath");
      await fsp.writeFile(stale, "Memory/session-20260101-000001-abc123de.md\n");
      const longAgo = Math.floor(Date.now() / 1000) - 3600;
      await fsp.utimes(stale, longAgo, longAgo);

      const drained = await run("node", [FLUSH], cliEnv({ BASIC_MEMORY_SPOOL_DIR: spool }));
      expect(drained.exitCode).toBe(0);
      expect(drained.stdout).toContain("swept 1 orphan sidecar(s)");
      expect(fs.existsSync(stale)).toBe(false);
    });

    // N4: nothing binds a sidecar to its capture, so the log is the trail.
    it("logs the permalink for EVERY flush, not only the odd ones", async () => {
      const spool = path.join(tmp, "trail-spool");
      await run(
        "python3",
        [CAPTURE],
        cliEnv({
          BASIC_MEMORY_SPOOL_ENABLED: "1",
          BASIC_MEMORY_SPOOL_DIR: spool,
          BASIC_MEMORY_SPOOL_AUTOFLUSH: "0"
        }),
        JSON.stringify({ session_id: SESSION_ID, cwd: tmp, hook_event_name: "SessionEnd" })
      );
      const drained = await run("node", [FLUSH], cliEnv({ BASIC_MEMORY_SPOOL_DIR: spool }));
      expect(drained.exitCode).toBe(0);
      // The happy path - no fallback, no warning - still records where it went.
      expect(drained.stdout).not.toContain("no usable identity sidecar");
      expect(drained.stdout).toMatch(/capture-\S+\.md -> vault\/memory-session-\S+/);
    });

    it("a capture spooled without a sidecar still drains, under the queue key, and says so", async () => {
      const spool = path.join(tmp, "legacy-spool");
      await fsp.mkdir(spool, { recursive: true });
      await fsp.writeFile(path.join(spool, "capture-legacy-20260101-000000-42.md"), "old capture\n");

      const drained = await run("node", [FLUSH], cliEnv({ BASIC_MEMORY_SPOOL_DIR: spool }));
      expect(drained.exitCode).toBe(0);
      expect(drained.stdout).toContain("no usable identity sidecar (queue-key)");
      expect(drained.stdout).toContain("will NOT be reconciled by compare-backends.mjs");
      expect(remoteKeys()).toEqual(["capture-legacy-20260101-000000-42"]);
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
      // F7: the daily job goes RED on a divergence instead of filing another
      // quiet report - the deadline cannot live only inside the artifact.
      expect(compare!.command).toContain("--fail-on-diff");
      // F1: the hook needs the folder to stamp each capture's identity sidecar,
      // or the shadow ships notes under an identity the comparator never looks
      // for.
      expect(hookCommand()).toContain("BASIC_MEMORY_REMOTE_FOLDER=vault");
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
