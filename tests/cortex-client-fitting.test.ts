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
 */
async function buildFixtureRepo(root: string): Promise<{ pin: string; tip: string }> {
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
      { name: "fixture-monorepo", private: true, version: "0.0.0", workspaces: ["shared", "clients/*"] },
      null,
      2
    )}\n`
  );
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
        bin: { cortex: "./bin/cortex.mjs" },
        scripts: { build: "node scripts/build.mjs" },
        dependencies: { "@fixture/shared": "*" }
      },
      null,
      2
    )}\n`;

  // The bin shim: resolves ../dist/cli.js from import.meta.url (so a symlink from
  // anywhere works) and exits 2 when the package is not built.
  await write(
    path.join(cliDir, "bin", "cortex.mjs"),
    [
      "#!/usr/bin/env node",
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
    0o755
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

  it("license isolation: a clone path inside the MIT tree is refused BEFORE any write", async () => {
    const inside = path.join(REPO_ROOT, ".tmp-cortex-client-guard-fixture");
    const setup = await run("bash", [SETUP], setupEnv({ CORTEX_CLIENT_CLONE_DIR: inside }));

    expect(setup.exitCode).toBe(1);
    expect(setup.stderr).toContain("INSIDE Garrison's own source tree");
    expect(setup.stderr).toContain("aborting before any write");
    await expect(fs.stat(inside)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("license isolation: a path that only RESOLVES into the MIT tree is refused too", async () => {
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
    expect(setup.stderr).toContain("not a commit SHA");
    await expect(fs.stat(home)).rejects.toMatchObject({ code: "ENOENT" });
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
});

// The registry gate. A composition selection is filtered through data/library.json
// (selectedLibraryEntries keeps only ids the registry knows), so a fitting that is
// SELECTED but UNREGISTERED is silently dropped: `up()` never runs its setup or its
// verify and the install only LOOKS done. Asserting the selection survives that
// filter is the difference between "the manifest parses" and "the fitting is
// actually stationed".
describe("cortex-client is stationed in dogfood-dev (and nowhere else)", () => {
  async function selectionsOf(compositionId: string): Promise<FittingSelectionMap> {
    const yaml = await import("js-yaml");
    const manifest = yaml.load(
      await fs.readFile(path.join(REPO_ROOT, "compositions", compositionId, "apm.yml"), "utf8")
    ) as { "x-garrison"?: { composition?: { selections?: FittingSelectionMap } } };
    return manifest["x-garrison"]?.composition?.selections ?? {};
  }

  it("is selected under connectors AND survives the library filter", async () => {
    const selections = await selectionsOf("dogfood-dev");
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
    const selections = await selectionsOf("dogfood-dev");
    const selected = (selections.connectors ?? []).find((s) => s.id === "cortex-client");
    // Rule 6 — a fresh clone with an empty vault must compose, run and verify.
    expect(selected?.config.repo_url).toBe("");
    expect(selected?.config.git_ref).toBe("");
    expect(selected?.config.base_url).toBe("");

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

  it("leaves compositions/default alone (working agreement: existing users see zero change)", async () => {
    const selections = await selectionsOf("default");
    const allIds = Object.values(selections).flatMap((items) => (items ?? []).map((s) => s.id));
    expect(allIds).not.toContain("cortex-client");
  });
});
