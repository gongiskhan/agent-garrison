// Slice G1 — the cortex-client Fitting: a PINNED, license-isolated CLI install
// exposed as ONE stable binary path.
//
// Drives the real scripts/setup.sh + scripts/verify.sh as subprocesses, exactly as
// the runner does (setup gets the projected CORTEX_CLIENT_* config env; verify gets
// none of it and has to read the install receipt). Everything runs against a FAKE
// local git repository built in a tmp dir that mimics the shipped client's layout —
// an npm workspace monorepo whose CLI package declares a `bin` shim that refuses to
// run until it is built. No network, no provider, no credential.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shippedCompositionIds } from "./helpers/shipped-compositions";
import { selectedLibraryEntries } from "@/lib/compositions";
import type { FittingSelectionMap } from "@/lib/types";

const REPO_ROOT = path.resolve(__dirname, "..");
const SCRIPTS = path.join(REPO_ROOT, "fittings", "seed", "cortex-client", "scripts");
const SETUP = path.join(SCRIPTS, "setup.sh");
const VERIFY = path.join(SCRIPTS, "verify.sh");

// npm install + a build of the fixture workspace; generous like the fitting's own
// budgets, because a lost race here would look like a broken script.
const SLOW = 180_000;

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function run(
  cmd: string,
  args: string[],
  env: Record<string, string | undefined> = {},
  cwd = REPO_ROOT
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code }));
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await run("git", args, {}, cwd);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function write(file: string, content: string, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, mode === undefined ? "utf8" : { encoding: "utf8", mode });
}

/**
 * The fake provider repo: an npm workspace monorepo shaped like the real one.
 *
 *   package.json            workspaces: shared + clients/*
 *   shared/                 a workspace package the CLI imports AT RUNTIME, so a
 *                           clone without node_modules cannot run — the same
 *                           constraint the shipped client has.
 *   clients/fake-cli/       the CLI package: `bin` shim + a build script.
 *
 * Two commits: v1.0.0 (the PIN under test) and v2.0.0 (the branch tip). A setup that
 * silently followed the tip would print 2.0.0.
 *
 * `opts` turns the fixture HOSTILE in the specific ways a real repository could be:
 * lifecycle scripts that execute during install, a bin entry that points outside the
 * package, a bin shim with no interpreter line. None of these need a malicious author —
 * the last one is an ordinary authoring mistake — and all three reach this Fitting.
 */
interface FixtureOptions {
  /** absolute paths a `postinstall` writes to; they must never appear. */
  postinstallMarkers?: { root: string; cli: string };
  /** replaces the package.json `bin` path (traversal / symlink escape). */
  binPath?: string;
  /** commits a symlink `outbound` -> this absolute path, inside the CLI package. */
  outboundSymlink?: string;
  /** false ships the bin shim without a `#!` line. */
  shebang?: boolean;
}

async function buildFixtureRepo(
  root: string,
  opts: FixtureOptions = {}
): Promise<{ pin: string; tip: string }> {
  const cliDir = path.join(root, "clients", "fake-cli");
  await fs.mkdir(root, { recursive: true });
  await git(root, ["init", "--quiet", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.invalid"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await git(root, ["config", "commit.gpgsign", "false"]);

  await write(path.join(root, ".gitignore"), "node_modules/\ndist/\npackage-lock.json\n");
  await write(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "fixture-monorepo",
        private: true,
        version: "0.0.0",
        workspaces: ["shared", "clients/*"],
        ...(opts.postinstallMarkers
          ? { scripts: { preinstall: "node scripts/pwn.mjs", postinstall: "node scripts/pwn.mjs" } }
          : {})
      },
      null,
      2
    )}\n`
  );
  if (opts.postinstallMarkers) {
    // Writes OUTSIDE the clone and records what it could read out of the
    // environment — the exact shape of the finding this guards against.
    const pwn = (marker: string) =>
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(marker)}, JSON.stringify(`,
        "  Object.keys(process.env).filter((k) => /_API_KEY$|_TOKEN$/.test(k))",
        "));",
        ""
      ].join("\n");
    await write(path.join(root, "scripts", "pwn.mjs"), pwn(opts.postinstallMarkers.root));
    await write(path.join(cliDir, "scripts", "pwn.mjs"), pwn(opts.postinstallMarkers.cli));
  }
  await write(
    path.join(root, "shared", "package.json"),
    `${JSON.stringify({ name: "@fixture/shared", version: "1.0.0", private: true, main: "index.js" }, null, 2)}\n`
  );
  await write(path.join(root, "shared", "index.js"), 'module.exports = { brand: "fixture-shared" };\n');

  const cliPackage = (version: string) =>
    `${JSON.stringify(
      {
        name: "@fixture/cortex-cli",
        version,
        private: true,
        type: "module",
        bin: { cortex: opts.binPath ?? "./bin/cortex.mjs" },
        scripts: {
          build: "node scripts/build.mjs",
          ...(opts.postinstallMarkers ? { postinstall: "node scripts/pwn.mjs" } : {})
        },
        dependencies: { "@fixture/shared": "*" }
      },
      null,
      2
    )}\n`;

  if (opts.outboundSymlink) {
    await fs.mkdir(cliDir, { recursive: true });
    await fs.symlink(opts.outboundSymlink, path.join(cliDir, "outbound"));
  }

  // The bin shim: resolves ../dist/cli.js from import.meta.url (so a symlink from
  // anywhere works) and exits 2 when the package is not built. Without the `#!`
  // line it is not executable at all — the caller's shell would interpret it.
  await write(
    path.join(cliDir, "bin", "cortex.mjs"),
    [
      ...(opts.shebang === false ? [] : ["#!/usr/bin/env node"]),
      "import { existsSync } from 'node:fs';",
      "import { fileURLToPath } from 'node:url';",
      "const dist = new URL('../dist/cli.js', import.meta.url);",
      "if (!existsSync(fileURLToPath(dist))) {",
      "  process.stderr.write('cortex: not built. Run: npm run build --workspace @fixture/cortex-cli\\n');",
      "  process.exit(2);",
      "}",
      "const { main } = await import(dist.href);",
      "process.exitCode = await main(process.argv.slice(2));",
      ""
    ].join("\n"),
    // 644 for the shebang-less variant, matching a bin committed without the exec
    // bit: npm sets it during install, so the file becomes "executable" without
    // ever becoming runnable.
    opts.shebang === false ? 0o644 : 0o755
  );

  // The CLI itself. `--version` reads the BUILD stamp (not package.json), so the
  // reported version proves a build ran at the checked-out commit; every other
  // command needs both provider variables, which is what makes --version the one
  // invocation a keyless verify can rely on.
  await write(
    path.join(cliDir, "src", "cli.js"),
    [
      "import { readFileSync } from 'node:fs';",
      "import shared from '@fixture/shared';",
      "export async function main(argv) {",
      "  if (argv[0] === '--version' || argv[0] === 'version') {",
      "    const stamp = JSON.parse(readFileSync(new URL('./build-stamp.json', import.meta.url), 'utf8'));",
      "    process.stdout.write(stamp.version + '\\n');",
      "    return 0;",
      "  }",
      "  if (!process.env.CORTEX_BASE_URL) { process.stderr.write('CORTEX_BASE_URL is not set\\n'); return 2; }",
      "  if (!process.env.CORTEX_API_KEY) { process.stderr.write('CORTEX_API_KEY is not set\\n'); return 2; }",
      "  process.stdout.write(JSON.stringify({ ok: true, brand: shared.brand }) + '\\n');",
      "  return 0;",
      "}",
      ""
    ].join("\n")
  );

  // The build: src -> dist plus a version stamp taken from package.json at BUILD time.
  await write(
    path.join(cliDir, "scripts", "build.mjs"),
    [
      "import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
      "import { fileURLToPath } from 'node:url';",
      "const dist = fileURLToPath(new URL('../dist/', import.meta.url));",
      "const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));",
      "mkdirSync(dist, { recursive: true });",
      "copyFileSync(fileURLToPath(new URL('../src/cli.js', import.meta.url)), dist + 'cli.js');",
      "writeFileSync(dist + 'build-stamp.json', JSON.stringify({ version: pkg.version }) + '\\n');",
      ""
    ].join("\n")
  );

  await write(path.join(cliDir, "package.json"), cliPackage("1.0.0"));
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "--quiet", "-m", "fixture: cli v1.0.0"]);
  const pin = await git(root, ["rev-parse", "HEAD"]);

  await write(path.join(cliDir, "package.json"), cliPackage("2.0.0"));
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "--quiet", "-m", "fixture: cli v2.0.0"]);
  const tip = await git(root, ["rev-parse", "HEAD"]);

  return { pin, tip };
}

describe("cortex-client fitting (setup + verify against a fake pinned repo)", () => {
  let tmp: string;
  let home: string; // GARRISON_HOME
  let origin: string;
  let pin: string;
  let tip: string;

  const clone = () => path.join(home, "external", "cortex-cli");
  const binDir = () => path.join(home, "bin");
  const link = () => path.join(binDir(), "cortex");
  const receiptPath = () => path.join(home, "cortex-client", "install.json");
  const binTarget = () => path.join(clone(), "clients", "fake-cli", "bin", "cortex.mjs");

  /** The env the runner projects for THIS fitting's setup hook. */
  function setupEnv(over: Record<string, string | undefined> = {}) {
    return {
      GARRISON_HOME: home,
      CORTEX_CLIENT_REPO_URL: origin,
      CORTEX_CLIENT_GIT_REF: pin,
      CORTEX_CLIENT_BASE_URL: "https://provider.example.invalid",
      CORTEX_CLIENT_PACKAGE_SUBDIR: "clients/fake-cli",
      // The runner hands verify NOTHING of the above — deliberately absent there.
      CORTEX_API_KEY: undefined,
      CORTEX_BASE_URL: undefined,
      ...over
    };
  }

  async function readReceipt(): Promise<Record<string, string>> {
    return JSON.parse(await fs.readFile(receiptPath(), "utf8")) as Record<string, string>;
  }

  async function cliVersion(): Promise<string> {
    const result = await run(link(), ["--version"], { CORTEX_API_KEY: undefined, CORTEX_BASE_URL: undefined });
    expect(result.exitCode, result.stderr).toBe(0);
    return result.stdout.trim();
  }

  /** Replace the fixture repo with a hostile / malformed variant. */
  async function rebuildFixture(opts: FixtureOptions): Promise<void> {
    await fs.rm(origin, { recursive: true, force: true });
    const refs = await buildFixtureRepo(origin, opts);
    pin = refs.pin;
    tip = refs.tip;
  }

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "garrison-cortex-client-"));
    home = path.join(tmp, "garrison-home");
    origin = path.join(tmp, "origin");
    const refs = await buildFixtureRepo(origin);
    pin = refs.pin;
    tip = refs.tip;
  }, SLOW);

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("unconfigured is the shipped default: setup writes NOTHING and verify still says ok", async () => {
    const setup = await run("bash", [SETUP], {
      GARRISON_HOME: home,
      CORTEX_CLIENT_REPO_URL: undefined,
      CORTEX_CLIENT_GIT_REF: undefined,
      CORTEX_CLIENT_BASE_URL: undefined
    });
    expect(setup.exitCode).toBe(0);
    expect(setup.stdout).toContain("no repo_url configured");
    // Rule 6: a fresh clone with an empty vault composes and runs. Not one byte.
    await expect(fs.stat(home)).rejects.toMatchObject({ code: "ENOENT" });

    const verify = await run("bash", [VERIFY], { GARRISON_HOME: home });
    expect(verify.exitCode).toBe(0);
    expect(verify.stdout).toContain("not configured");
    expect(verify.stdout.trim().endsWith("ok")).toBe(true);
  });

  it(
    "installs the pinned commit — not the branch tip — and links one binary the receipt names",
    async () => {
      const setup = await run("bash", [SETUP], setupEnv());
      expect(setup.exitCode, `${setup.stdout}\n${setup.stderr}`).toBe(0);

      // The pin is honoured: HEAD is the pinned commit, and the built binary reports
      // the version that commit carried (the tip would say 2.0.0).
      expect(await git(clone(), ["rev-parse", "HEAD"])).toBe(pin);
      expect(pin).not.toBe(tip);
      expect(await cliVersion()).toBe("1.0.0");

      // One stable binary path, and it is a symlink into the license-isolated clone.
      expect((await fs.lstat(link())).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(link())).toBe(binTarget());

      const receipt = await readReceipt();
      expect(receipt.ref).toBe(pin);
      expect(receipt.bin).toBe(link());
      expect(receipt.clone).toBe(clone());
      expect(receipt.bin_name).toBe("cortex");
      expect(receipt.base_url).toBe("https://provider.example.invalid");
      // The receipt is a lookup table, never a credential store.
      expect(JSON.stringify(receipt)).not.toContain("API_KEY");

      const verify = await run("bash", [VERIFY], { GARRISON_HOME: home });
      expect(verify.exitCode, `${verify.stdout}\n${verify.stderr}`).toBe(0);
      expect(verify.stdout.trim().endsWith("ok")).toBe(true);
    },
    SLOW
  );

  it(
    "re-running is idempotent: one clone, one link, same target, still at the pin",
    async () => {
      const first = await run("bash", [SETUP], setupEnv());
      expect(first.exitCode, `${first.stdout}\n${first.stderr}`).toBe(0);
      const firstTarget = await fs.readlink(link());

      const second = await run("bash", [SETUP], setupEnv());
      expect(second.exitCode, `${second.stdout}\n${second.stderr}`).toBe(0);
      expect(second.stdout).toContain("already installed at this pin");

      expect(await fs.readdir(binDir())).toEqual(["cortex"]);
      expect(await fs.readdir(path.join(home, "external"))).toEqual(["cortex-cli"]);
      expect(await fs.readlink(link())).toBe(firstTarget);
      expect(await git(clone(), ["rev-parse", "HEAD"])).toBe(pin);
      expect(await cliVersion()).toBe("1.0.0");
      expect((await readReceipt()).ref).toBe(pin);
    },
    SLOW
  );

  it(
    "moving the pin re-checks out and rebuilds, re-pointing the SAME single link",
    async () => {
      expect((await run("bash", [SETUP], setupEnv())).exitCode).toBe(0);
      expect(await cliVersion()).toBe("1.0.0");

      const moved = await run("bash", [SETUP], setupEnv({ CORTEX_CLIENT_GIT_REF: tip }));
      expect(moved.exitCode, `${moved.stdout}\n${moved.stderr}`).toBe(0);

      expect(await git(clone(), ["rev-parse", "HEAD"])).toBe(tip);
      expect(await cliVersion()).toBe("2.0.0");
      expect((await readReceipt()).ref).toBe(tip);
      expect(await fs.readdir(binDir())).toEqual(["cortex"]); // re-pointed, not duplicated
    },
    SLOW
  );

  it(
    "a stale symlink of the same name is re-pointed rather than nested or duplicated",
    async () => {
      await fs.mkdir(binDir(), { recursive: true });
      await fs.symlink(path.join(tmp, "decoy", "cortex"), link()); // broken, on purpose

      const setup = await run("bash", [SETUP], setupEnv());
      expect(setup.exitCode, `${setup.stdout}\n${setup.stderr}`).toBe(0);

      expect(await fs.readdir(binDir())).toEqual(["cortex"]);
      expect(await fs.readlink(link())).toBe(binTarget());
    },
    SLOW
  );

  it(
    "refuses to clobber a real file sitting at the binary's name",
    async () => {
      await write(link(), "#!/bin/sh\necho a binary the user put here\n", 0o755);

      const setup = await run("bash", [SETUP], setupEnv());
      expect(setup.exitCode).toBe(1);
      expect(setup.stderr).toContain("refusing to clobber");
      expect(await fs.readFile(link(), "utf8")).toContain("the user put here");
      expect((await fs.lstat(link())).isSymbolicLink()).toBe(false);
    },
    SLOW
  );

  it("byte containment: a clone path inside the MIT tree is refused BEFORE any write", async () => {
    const inside = path.join(REPO_ROOT, ".tmp-cortex-client-guard-fixture");
    const setup = await run("bash", [SETUP], setupEnv({ CORTEX_CLIENT_CLONE_DIR: inside }));

    expect(setup.exitCode).toBe(1);
    expect(setup.stderr).toContain("INSIDE Garrison's own source tree");
    expect(setup.stderr).toContain("aborting before any write");
    await expect(fs.stat(inside)).rejects.toMatchObject({ code: "ENOENT" });
    // The guard is the ONE refusal that legitimately leaves no marker: it runs
    // before every write, and the marker's own write would otherwise need guarding
    // too. So a guarded path is indistinguishable from unconfigured to verify -
    // recorded as an accepted residual rather than pretended away.
    await expect(fs.stat(home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("byte containment: a path that only RESOLVES into the MIT tree is refused too", async () => {
    // Deliberately NOT path.join: the literal `..` has to survive into the script,
    // which is what the guard has to see through.
    const sneaky = `${REPO_ROOT}/../${path.basename(REPO_ROOT)}/.tmp-cortex-client-guard-sneaky`;
    const setup = await run("bash", [SETUP], setupEnv({ CORTEX_CLIENT_CLONE_DIR: sneaky }));

    expect(setup.exitCode).toBe(1);
    expect(setup.stderr).toContain("aborting before any write");
    await expect(fs.stat(path.resolve(sneaky))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a branch name is refused: git_ref is a PIN, and nothing is cloned", async () => {
    const setup = await run("bash", [SETUP], setupEnv({ CORTEX_CLIENT_GIT_REF: "main" }));

    expect(setup.exitCode).toBe(1);
    expect(setup.stderr).toContain("not a commit sha");
    // Nothing is cloned, but the failure IS recorded: a bad pin on a configured
    // repo_url is configured-and-broken, not the shipped default.
    expect((await run("bash", [VERIFY], setupEnv())).exitCode).toBe(1);
  });

  it(
    "verify is degraded-ok without a key, reports its presence, and never prints its value",
    async () => {
      expect((await run("bash", [SETUP], setupEnv())).exitCode).toBe(0);

      const keyless = await run("bash", [VERIFY], { GARRISON_HOME: home, CORTEX_API_KEY: undefined });
      expect(keyless.exitCode, `${keyless.stdout}\n${keyless.stderr}`).toBe(0);
      expect(keyless.stdout).toContain("CORTEX_API_KEY: absent");
      expect(keyless.stdout).toContain("not a failure");
      expect(keyless.stdout.trim().endsWith("ok")).toBe(true);

      const secret = "ekoa_gk_do_not_print_me_anywhere";
      const keyed = await run("bash", [VERIFY], { GARRISON_HOME: home, CORTEX_API_KEY: secret });
      expect(keyed.exitCode, `${keyed.stdout}\n${keyed.stderr}`).toBe(0);
      expect(keyed.stdout).toContain("CORTEX_API_KEY: provisioned");
      expect(keyed.stdout).not.toContain(secret);
      expect(keyed.stderr).not.toContain(secret);
      expect(keyed.stdout.trim().endsWith("ok")).toBe(true);
    },
    SLOW
  );

  it(
    "verify catches pin drift: a clone moved off the recorded commit is not ok",
    async () => {
      expect((await run("bash", [SETUP], setupEnv())).exitCode).toBe(0);
      await git(clone(), ["checkout", "--quiet", "--detach", tip]);

      const verify = await run("bash", [VERIFY], { GARRISON_HOME: home });
      expect(verify.exitCode).toBe(1);
      expect(verify.stdout).toContain("pin drift");
      expect(verify.stdout.trim().endsWith("ok")).toBe(false);
    },
    SLOW
  );

  it(
    "verify catches an unbuilt clone: the receipt exists but the CLI cannot run",
    async () => {
      expect((await run("bash", [SETUP], setupEnv())).exitCode).toBe(0);
      await fs.rm(path.join(clone(), "clients", "fake-cli", "dist"), { recursive: true, force: true });

      const verify = await run("bash", [VERIFY], { GARRISON_HOME: home });
      expect(verify.exitCode).toBe(1);
      expect(verify.stdout).toContain("not built");
      expect(verify.stdout.trim().endsWith("ok")).toBe(false);
    },
    SLOW
  );

  // ---------------------------------------------------------------------------
  // Fresh-context review findings. Each of these fails if its fix is reverted.
  // ---------------------------------------------------------------------------

  // R1 — the clone is built with the composition's materialised vault in scope.
  // The reviewer's fixture postinstall RAN, wrote outside the clone, and read back
  // every *_API_KEY / *_TOKEN in the environment. --ignore-scripts is what stops
  // the install lifecycle; the honesty text is what stops the manifest implying a
  // containment it does not provide.
  it(
    "R1: install lifecycle scripts in the cloned repository never execute",
    async () => {
      const markers = {
        root: path.join(tmp, "pwned-root.json"),
        cli: path.join(tmp, "pwned-cli.json")
      };
      await rebuildFixture({ postinstallMarkers: markers });

      const setup = await run("bash", [SETUP], setupEnv({ CORTEX_API_KEY: "vault-secret-in-scope" }));
      expect(setup.exitCode, `${setup.stdout}\n${setup.stderr}`).toBe(0);
      expect(setup.stdout).toContain("--ignore-scripts");

      // Neither the root package's pre/postinstall nor the workspace's postinstall ran.
      await expect(fs.stat(markers.root)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(markers.cli)).rejects.toMatchObject({ code: "ENOENT" });
      // …and the install still produced a working CLI.
      expect(await cliVersion()).toBe("1.0.0");
    },
    SLOW
  );

  it("R1: the manifest states the trust grant instead of implying containment", async () => {
    const yaml = await import("js-yaml");
    const manifest = yaml.load(
      await fs.readFile(path.join(REPO_ROOT, "fittings", "seed", "cortex-client", "apm.yml"), "utf8")
    ) as { description?: string; "x-garrison"?: { for_consumers?: string; summary?: string } };
    const forConsumers = manifest["x-garrison"]?.for_consumers ?? "";

    // The word that was doing the lying — in the manifest AND in the registry
    // summary the Armory shows, which is a copy of the same claim.
    const registry = JSON.parse(
      await fs.readFile(path.join(REPO_ROOT, "data", "library.json"), "utf8")
    ) as Array<{ id: string; summary: string }>;
    const listed = registry.find((entry) => entry.id === "cortex-client");
    expect(
      `${manifest.description} ${manifest["x-garrison"]?.summary} ${listed?.summary}`
    ).not.toContain("isolated");
    // What must be said instead, plainly.
    expect(forConsumers).toContain("EXECUTES ITS CODE");
    expect(forConsumers).toContain("materialised vault");
    expect(forConsumers).toContain("--ignore-scripts");
    expect(forConsumers).toContain("There is no sandbox here");
    // R6 — the two places a URL-borne credential actually lands.
    expect(forConsumers).toContain(".git/config");
    expect(forConsumers).toContain("command line");
  });

  // R2 — a bin entry with no `#!` is handed to /bin/sh by execve, which then
  // interprets JavaScript as shell. The reviewer's repro reached ImageMagick's
  // `import`, which blocks on X11: setup wedged for the full 900s budget.
  it(
    "R2: a bin shim with no '#!' is refused fast, never executed, never allowed to hang",
    async () => {
      await rebuildFixture({ shebang: false });

      const started = Date.now();
      const setup = await run("bash", [SETUP], setupEnv());
      const elapsed = Date.now() - started;

      expect(setup.exitCode).toBe(1);
      expect(setup.stderr).toContain("has no '#!' line");
      // The point of the finding: it must not sit on the budget.
      expect(elapsed).toBeLessThan(60_000);
      // R3 — and it must not leave a success receipt for verify to inherit.
      await expect(fs.stat(receiptPath())).rejects.toMatchObject({ code: "ENOENT" });
    },
    SLOW
  );

  // R3 — setup and verify used to hold separate probes, so setup could bless a
  // binary verify then refused, blaming a missing build. They now share one.
  it(
    "R3: setup and verify reach the same verdict about whether the CLI runs",
    async () => {
      expect((await run("bash", [SETUP], setupEnv())).exitCode).toBe(0);
      expect((await run("bash", [VERIFY], { GARRISON_HOME: home })).exitCode).toBe(0);

      // Break the build behind both of their backs.
      await fs.rm(path.join(clone(), "clients", "fake-cli", "dist"), { recursive: true, force: true });
      expect((await run("bash", [VERIFY], { GARRISON_HOME: home })).exitCode).toBe(1);

      // setup's probe must see the same thing: it may NOT take the "already
      // installed at this pin" shortcut, and it must repair the box.
      const repair = await run("bash", [SETUP], setupEnv());
      expect(repair.exitCode, `${repair.stdout}\n${repair.stderr}`).toBe(0);
      expect(repair.stdout).not.toContain("already installed at this pin");
      expect((await run("bash", [VERIFY], { GARRISON_HOME: home })).exitCode).toBe(0);
    },
    SLOW
  );

  // R4 — the runner catches a failed pre-verify setup pass and CONTINUES, so a
  // half-installed box reached verify with no receipt and verified "ok".
  it(
    "R4: a failed install leaves a marker, and verify refuses to call it 'not configured'",
    async () => {
      const missingCommit = "0".repeat(40);
      const setup = await run("bash", [SETUP], setupEnv({ CORTEX_CLIENT_GIT_REF: missingCommit }));
      expect(setup.exitCode).toBe(1);

      // Half-cloned, no receipt — indistinguishable from "never configured" without this.
      await expect(fs.stat(receiptPath())).rejects.toMatchObject({ code: "ENOENT" });
      const marker = JSON.parse(
        await fs.readFile(path.join(home, "cortex-client", "install-failed.json"), "utf8")
      ) as { reason?: string; fitting?: string };
      expect(marker.fitting).toBe("cortex-client");
      expect(marker.reason).toContain(missingCommit);

      const verify = await run("bash", [VERIFY], { GARRISON_HOME: home });
      expect(verify.exitCode).toBe(1);
      expect(verify.stdout).toContain("setup failed");
      expect(verify.stdout.trim().endsWith("ok")).toBe(false);

      // And the marker clears once the install actually succeeds.
      expect((await run("bash", [SETUP], setupEnv())).exitCode).toBe(0);
      await expect(
        fs.stat(path.join(home, "cortex-client", "install-failed.json"))
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect((await run("bash", [VERIFY], { GARRISON_HOME: home })).exitCode).toBe(0);
    },
    SLOW
  );

  // R5 — package_subdir (operator) and the `bin` entry (THE CLONED REPO) both
  // reach chmod and ln, and neither was guarded. A repo declaring a traversing
  // bin made setup chmod +x a file inside the tree and symlink into it, exit 0.
  it("R5: a traversing package_subdir is refused", async () => {
    const setup = await run(
      "bash",
      [SETUP],
      setupEnv({ CORTEX_CLIENT_PACKAGE_SUBDIR: "clients/../../../../etc" })
    );
    expect(setup.exitCode).toBe(1);
    expect(setup.stderr).toContain("'..' segment");
  });

  it(
    "R5: a repo-declared bin path that traverses out of the package is refused",
    async () => {
      const outside = path.join(tmp, "outside");
      await write(path.join(outside, "innocent.mjs"), "// a file the repo must not reach\n", 0o644);
      await rebuildFixture({ binPath: "../../../../outside/innocent.mjs" });

      const setup = await run("bash", [SETUP], setupEnv());
      expect(setup.exitCode).toBe(1);
      expect(setup.stderr).toContain("'..' segment");
      // Untouched: no chmod, no link.
      expect((await fs.stat(path.join(outside, "innocent.mjs"))).mode & 0o111).toBe(0);
      await expect(fs.stat(link())).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(receiptPath())).rejects.toMatchObject({ code: "ENOENT" });
    },
    SLOW
  );

  it(
    "R5: a bin path that escapes through a committed symlink is refused too",
    async () => {
      const outside = path.join(tmp, "outside");
      await write(path.join(outside, "innocent.mjs"), "// a file the repo must not reach\n", 0o644);
      // No '..' anywhere — the escape is a symlink the repository itself ships.
      await rebuildFixture({ outboundSymlink: outside, binPath: "./outbound/innocent.mjs" });

      const setup = await run("bash", [SETUP], setupEnv());
      expect(setup.exitCode).toBe(1);
      expect(setup.stderr).toContain("escapes the clone");
      expect((await fs.stat(path.join(outside, "innocent.mjs"))).mode & 0o111).toBe(0);
      await expect(fs.stat(receiptPath())).rejects.toMatchObject({ code: "ENOENT" });
    },
    SLOW
  );

  it(
    "R5: verify re-checks WHERE the published binary points, not just the clone",
    async () => {
      expect((await run("bash", [SETUP], setupEnv())).exitCode).toBe(0);
      expect((await run("bash", [VERIFY], { GARRISON_HOME: home })).exitCode).toBe(0);

      // Re-point the published link at a file outside the clone.
      const outside = path.join(tmp, "outside", "impostor.mjs");
      await write(outside, "#!/usr/bin/env node\nprocess.stdout.write('9.9.9\\n');\n", 0o755);
      await fs.rm(link());
      await fs.symlink(outside, link());

      const verify = await run("bash", [VERIFY], { GARRISON_HOME: home });
      expect(verify.exitCode).toBe(1);
      expect(verify.stdout).toContain("escapes the clone");
      expect(verify.stdout.trim().endsWith("ok")).toBe(false);
    },
    SLOW
  );

  // R6 — a credential in repo_url lands in /proc/<pid>/cmdline (world-readable)
  // and in <clone>/.git/config (persisted). Neither is undoable after the fact, so
  // the URL form is refused rather than mitigated.
  // Both reasons the refusal gives - the remote is written verbatim into .git/config, and the
  // URL is visible in /proc while git clones - are transport-independent, so the check must not
  // be http(s)-only. The earlier version was, and its own advice ("use an ssh remote") named a
  // spelling it let straight through: ssh://user:secret@host IS an ssh remote.
  it.each([
    ["https with secret", "https://user:ghp_notarealtoken@example.invalid/private.git"],
    // http(s) treats a bare userinfo as a credential too - that IS how a PAT is passed.
    ["https bare token", "https://ghp_notarealtoken@example.invalid/private.git"],
    ["http with secret", "http://user:ghp_notarealtoken@example.invalid/private.git"],
    ["ssh with secret", "ssh://user:ghp_notarealtoken@example.invalid/private.git"],
    ["git with secret", "git://user:ghp_notarealtoken@example.invalid/private.git"],
    // scp-style has no scheme, so the URL branch cannot see it; only a colon
    // BEFORE the @ is a secret (the one after the host is a path separator).
    ["scp-style with secret", "deploy:ghp_notarealtoken@example.invalid:org/private.git"],
  ])("R6: a repo_url carrying credentials (%s) is refused before any write", async (_shape, url) => {
    const setup = await run("bash", [SETUP], setupEnv({ CORTEX_CLIENT_REPO_URL: url }));
    expect(setup.exitCode).toBe(1);
    expect(setup.stderr).toContain(".git/config");
    expect(setup.stderr).toContain("credential helper");
    expect(setup.stderr).not.toContain("ghp_notarealtoken");
    expect((await run("bash", [VERIFY], setupEnv())).exitCode).toBe(1);
  });

  // The credential-free spellings the advice points at must NOT be refused. The
  // ssh:// form matters most: `ssh://git@github.com/org/repo.git` is what GitHub
  // and GitLab hand you, `git` is a username rather than a secret, and an earlier
  // version refused it while the manifest told operators to use exactly that.
  it.each([
    ["scp-style", "git@example.invalid:org/repo.git"],
    ["ssh:// with a username", "ssh://git@example.invalid/org/repo.git"],
    ["ssh:// with a username and port", "ssh://git@example.invalid:2222/org/repo.git"],
    ["no userinfo at all", "https://example.invalid/org/repo.git"],
  ])("R6: a credential-free %s repo_url is NOT refused by the credential check", async (_shape, url) => {
    const setup = await run("bash", [SETUP], setupEnv({ CORTEX_CLIENT_REPO_URL: url }));
    expect(setup.stderr).not.toContain("carries a credential in the URL");
  });

  it(
    "R6: an inherited xtrace is turned off before anything is expanded",
    async () => {
      const setup = await run("bash", [SETUP], setupEnv({ SHELLOPTS: "xtrace" }));
      expect(setup.exitCode, `${setup.stdout}\n${setup.stderr}`).toBe(0);

      const traced = setup.stderr.split("\n").filter((line) => line.startsWith("+ "));
      // Only the two lines it takes to disable it; never a variable expansion.
      expect(traced.length, traced.join("\n")).toBeLessThanOrEqual(2);
      expect(setup.stderr).not.toContain("REPO_URL=");
      expect(setup.stderr).not.toContain(origin);
    },
    SLOW
  );

  // R7 — un-configuring used to be a half-state: the receipt survived a cleared
  // repo_url, so consumers kept finding a binary the operator had withdrawn.
  it(
    "R7: clearing repo_url withdraws the published binary and receipt",
    async () => {
      expect((await run("bash", [SETUP], setupEnv())).exitCode).toBe(0);
      expect((await fs.lstat(link())).isSymbolicLink()).toBe(true);

      const cleared = await run("bash", [SETUP], setupEnv({ CORTEX_CLIENT_REPO_URL: "" }));
      expect(cleared.exitCode, `${cleared.stdout}\n${cleared.stderr}`).toBe(0);
      expect(cleared.stdout).toContain("repo_url cleared");

      await expect(fs.stat(receiptPath())).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.lstat(link())).rejects.toMatchObject({ code: "ENOENT" });
      // The clone is left on disk rather than silently deleted, and said so.
      expect(await fs.stat(clone())).toBeTruthy();
      expect(cleared.stdout).toContain("left on disk");

      // And the state is now honestly "not configured".
      const verify = await run("bash", [VERIFY], { GARRISON_HOME: home });
      expect(verify.exitCode).toBe(0);
      expect(verify.stdout).toContain("not configured");
    },
    SLOW
  );

  // R8 — bin_dir/clone_dir defaulted to a literal ~/.garrison while the receipt
  // went to $GARRISON_HOME, so a non-default instance home split them apart.
  it(
    "R8: every path this Fitting owns is derived from GARRISON_HOME",
    async () => {
      expect((await run("bash", [SETUP], setupEnv())).exitCode).toBe(0);
      const receipt = await readReceipt();
      for (const value of [receipt.bin, receipt.clone, receipt.package_dir]) {
        expect(value.startsWith(`${home}/`), `${value} should live under ${home}`).toBe(true);
      }
      // Nothing landed in the real ~/.garrison.
      expect(receipt.bin).not.toContain(path.join(os.homedir(), ".garrison"));
    },
    SLOW
  );

  // R11 — an abbreviated ref is ambiguous and cannot be compared exactly, so a
  // hand-edited 4-character ref used to satisfy verify's prefix match.
  it("R11: an abbreviated git_ref is refused", async () => {
    const setup = await run("bash", [SETUP], setupEnv({ CORTEX_CLIENT_GIT_REF: pin.slice(0, 7) }));
    expect(setup.exitCode).toBe(1);
    expect(setup.stderr).toContain("pin the FULL sha");
    // After the unconfigured exit, so a bad pin IS recorded as configured-and-broken.
    expect((await run("bash", [VERIFY], setupEnv())).exitCode).toBe(1);
  });

  it(
    "R11: verify compares the pin exactly, so a truncated recorded ref is drift",
    async () => {
      expect((await run("bash", [SETUP], setupEnv())).exitCode).toBe(0);

      const receipt = await readReceipt();
      receipt.ref = pin.slice(0, 4);
      await fs.writeFile(receiptPath(), JSON.stringify(receipt, null, 2));

      const verify = await run("bash", [VERIFY], { GARRISON_HOME: home });
      expect(verify.exitCode).toBe(1);
      expect(verify.stdout).toContain("pin drift");
    },
    SLOW
  );
});

// The registry gate. A composition selection is filtered through data/library.json
// (selectedLibraryEntries keeps only ids the registry knows), so a fitting that is
// SELECTED but UNREGISTERED is silently dropped: `up()` never runs its setup or its
// verify and the install only LOOKS done. Asserting the selection survives that
// filter is the difference between "the manifest parses" and "the fitting is
// actually stationed".
describe("cortex-client stationing", () => {
  /** The shipped composition these connector fittings are stationed in. Derived,
 *  because this used to name "dogfood-dev" and broke when it was retired. */
const STATIONED_IN = shippedCompositionIds()[0];

async function selectionsOf(compositionId: string): Promise<FittingSelectionMap> {
    const yaml = await import("js-yaml");
    const manifest = yaml.load(
      await fs.readFile(path.join(REPO_ROOT, "compositions", compositionId, "apm.yml"), "utf8")
    ) as { "x-garrison"?: { composition?: { selections?: FittingSelectionMap } } };
    return manifest["x-garrison"]?.composition?.selections ?? {};
  }

  it("is selected under connectors AND survives the library filter", async () => {
    const selections = await selectionsOf(STATIONED_IN);
    expect((selections.connectors ?? []).map((s) => s.id)).toContain("cortex-client");

    const entries = await selectedLibraryEntries(selections);
    expect(
      entries.map((entry) => entry.id),
      "selected but unregistered fittings are silently dropped — add it to data/library.json"
    ).toContain("cortex-client");

    // …and the filter really is a filter (this assertion is what makes the one
    // above non-vacuous): an id the registry does not know vanishes silently.
    const withStranger = await selectedLibraryEntries({
      ...selections,
      connectors: [...(selections.connectors ?? []), { id: "not-registered-xyz", config: {} }]
    });
    expect(withStranger.map((e) => e.id)).not.toContain("not-registered-xyz");
    expect(withStranger.map((e) => e.id)).toContain("cortex-client");

    const entry = entries.find((candidate) => candidate.id === "cortex-client");
    expect(entry?.faculty).toBe("connectors");
    expect(entry?.metadata.provides).toContainEqual({ kind: "connector", name: "cortex" });
    expect(entry?.metadata.secret_scope).toEqual(["CORTEX_API_KEY"]);
    expect(entry?.metadata.setup?.[0]?.command).toBe("bash scripts/setup.sh");
    expect(entry?.metadata.verify.command).toContain("scripts/verify.sh");
  });

  it("ships INERT: no repository, origin or credential in the shipped config or defaults", async () => {
    // Rule 6 governs what the FITTING ships, not what a composition configures -
    // exactly as the note below this test states. Asserting the STATIONED config
    // empty here contradicted that, and only passed because this read a
    // composition that happened to leave the keys unset; `default` deliberately
    // points cortex-client at a real repo.
    const selections = await selectionsOf(STATIONED_IN);
    const entries = await selectedLibraryEntries(selections);
    const defaults = new Map(
      (entries.find((e) => e.id === "cortex-client")?.metadata.config_schema ?? []).map((f) => [
        f.key,
        f.default
      ])
    );
    expect(defaults.get("repo_url")).toBe("");
    expect(defaults.get("git_ref")).toBe("");
    expect(defaults.get("base_url")).toBe("");
  });

  // The original working agreement ("compositions/default sees zero change") was
  // retired deliberately by 68faa2e8, which equipped cortex-client in default AND
  // configured it against a real repo. That is a composition-level choice, not a
  // Rule 6 question: Rule 6 governs what the FITTING ships, and the test above
  // pins those defaults empty. So this asserts the stationing that now exists
  // rather than an agreement that no longer holds.
  it("is stationed in compositions/default too, configured at the composition level", async () => {
    const selections = await selectionsOf("default");
    const selected = (selections.connectors ?? []).find((s) => s.id === "cortex-client");
    // Reading it out of `selections.connectors` is itself the faculty assertion.
    expect(selected, "cortex-client has been equipped in default since 68faa2e8").toBeTruthy();
  });
});
