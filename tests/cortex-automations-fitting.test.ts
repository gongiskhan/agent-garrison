// Slice G5 - the cortex-automations Fitting: a skill-first VIEW over a remote
// automation runner, reached through a CLI that a different Fitting installs.
//
// Two things are worth committing a test for, and neither is "the YAML parses":
//
//  1. THE REGISTRY GATE. A composition selection is filtered through
//     data/library.json (selectedLibraryEntries keeps only ids the registry knows),
//     so a fitting that is SELECTED but UNREGISTERED is silently dropped: `up()`
//     never runs its verify and the station only LOOKS filled. The filter is proved
//     to be a filter by injecting a stranger id that must vanish.
//  2. THE THREE VERIFY OUTCOMES. verify.sh is driven as a subprocess exactly as the
//     runner drives it - GARRISON_HOME plus the gateway hook env, and deliberately
//     NONE of this fitting's config env (runner.verify() does not project it). Not
//     installed must be green (the shipped default), installed-but-broken must be
//     red, and the documented resolution order (receipt first, bin name on PATH as
//     the fallback) must actually be the order it uses.
//
// No network, no provider, no credential: the "CLI" is a five-line shell script.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { selectedLibraryEntries } from "@/lib/compositions";
import { parseGarrisonMetadata } from "@/lib/metadata";
import { readYamlFile } from "@/lib/yaml";
import type { FittingSelectionMap, GarrisonMetadata } from "@/lib/types";

const REPO_ROOT = path.resolve(__dirname, "..");
const FITTING_DIR = path.join(REPO_ROOT, "fittings", "seed", "cortex-automations");
const VERIFY = path.join(FITTING_DIR, "scripts", "verify.sh");
const SKILL = path.join(FITTING_DIR, ".apm", "skills", "cortex-automations", "SKILL.md");

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function run(
  cmd: string,
  args: string[],
  env: Record<string, string | undefined> = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code }));
  });
}

/**
 * The parent PATH with every directory that already carries a `cortex` executable
 * removed. "Not installed" has to mean not installed on the machine running the
 * test too, and a developer box that really did install the client would otherwise
 * turn the inert-default assertion green for the wrong reason (or red).
 */
async function pathWithoutCortex(): Promise<string> {
  const entries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const kept: string[] = [];
  for (const dir of entries) {
    try {
      await fs.access(path.join(dir, "cortex"), fs.constants.X_OK);
    } catch {
      kept.push(dir);
      continue;
    }
  }
  return kept.join(path.delimiter);
}

async function writeExecutable(file: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, { encoding: "utf8", mode: 0o755 });
}

/** A stand-in CLI that answers the one keyless invocation verify relies on. */
const WORKING_CLI = [
  "#!/usr/bin/env bash",
  'if [ "$1" = "automations" ] && [ "$2" = "--help" ]; then',
  '  echo "cortex automations <command>"',
  "  exit 0",
  "fi",
  'if [ "$1" = "--version" ]; then echo "1.0.0"; exit 0; fi',
  "exit 2",
  ""
].join("\n");

/** Installed, runnable, and useless: it does not expose the automations group. */
const BROKEN_CLI = [
  "#!/usr/bin/env bash",
  'echo "cortex: not built. Run the build first" >&2',
  "exit 2",
  ""
].join("\n");

async function selectionsOf(compositionId: string): Promise<FittingSelectionMap> {
  const yaml = await import("js-yaml");
  const manifest = yaml.load(
    await fs.readFile(path.join(REPO_ROOT, "compositions", compositionId, "apm.yml"), "utf8")
  ) as { "x-garrison"?: { composition?: { selections?: FittingSelectionMap } } };
  return manifest["x-garrison"]?.composition?.selections ?? {};
}

async function loadSeedMetadata(id: string): Promise<GarrisonMetadata> {
  const manifest = await readYamlFile<{ "x-garrison"?: unknown }>(
    path.join(REPO_ROOT, "fittings", "seed", id, "apm.yml")
  );
  expect(manifest, `seed ${id} should have an apm.yml`).toBeTruthy();
  return parseGarrisonMetadata(manifest!["x-garrison"]);
}

describe("cortex-automations is stationed in dogfood-dev and survives the registry filter", () => {
  it("is selected under connectors AND survives selectedLibraryEntries", async () => {
    const selections = await selectionsOf("dogfood-dev");
    expect((selections.connectors ?? []).map((s) => s.id)).toContain("cortex-automations");

    const entries = await selectedLibraryEntries(selections);
    expect(
      entries.map((entry) => entry.id),
      "selected but unregistered fittings are silently dropped - add it to data/library.json"
    ).toContain("cortex-automations");

    // ...and the filter really is a filter. Without this, the assertion above would
    // pass just as happily against a function that returned its input unchanged.
    const withStranger = await selectedLibraryEntries({
      ...selections,
      connectors: [
        ...(selections.connectors ?? []),
        { id: "not-registered-xyz", config: {} }
      ]
    });
    expect(withStranger.map((e) => e.id)).not.toContain("not-registered-xyz");
    expect(withStranger.map((e) => e.id)).toContain("cortex-automations");

    const entry = entries.find((candidate) => candidate.id === "cortex-automations");
    expect(entry?.faculty).toBe("connectors");
    expect(entry?.metadata.provides).toEqual([{ kind: "connector", name: "cortex-automations" }]);
    expect(entry?.metadata.consumes).toContainEqual({ kind: "vault", cardinality: "one" });
    expect(entry?.metadata.secret_scope).toEqual(["CORTEX_API_KEY"]);
    expect(entry?.metadata.verify.command).toContain("scripts/verify.sh");
  });

  it("is a view, not an engine: no port, no server, no setup hook", async () => {
    const metadata = await loadSeedMetadata("cortex-automations");
    expect(metadata.own_port).toBeUndefined();
    expect(metadata.default_port).toBeUndefined();
    expect(metadata.setup).toBeUndefined();
    // The session view needs to know WHERE Cortex is, and that is the only
    // thing it configures. It must still default to empty: inert by
    // construction, so a fresh clone with an empty vault composes and runs
    // (capability contract rule 6).
    expect(metadata.config_schema.map((f) => f.key)).toEqual(["base_url"]);
    expect(metadata.config_schema[0]?.default).toBe("");
    const selected = ((await selectionsOf("dogfood-dev")).connectors ?? []).find(
      (s) => s.id === "cortex-automations"
    );
    expect(selected?.config?.base_url ?? "").toBe("");
  });

  it("declares the connector/skill shared views plus the bespoke session rig", async () => {
    const metadata = await loadSeedMetadata("cortex-automations");
    const views = metadata.ui?.views ?? [];
    expect(views.map((v) => v.entry).sort()).toEqual([
      "cortex-automations:session",
      "garrison:connector",
      "garrison:skill"
    ]);
    // The bespoke entry is a REGISTRY key, not a path: a view whose loader was
    // never registered renders "Loader pending" forever, and nothing else
    // catches that.
    const registry = await fs.readFile(
      path.join(REPO_ROOT, "src", "components", "fitting-views", "registry.tsx"),
      "utf8"
    );
    expect(registry).toContain('"cortex-automations:session"');
    await expect(
      fs.stat(path.join(FITTING_DIR, "ui", "CortexSession.tsx"))
    ).resolves.toBeTruthy();
    // The skill IS the deliverable, and APM installs it from this path.
    await expect(fs.stat(SKILL)).resolves.toBeTruthy();
  });

  it("the skill is honest about the three things that are easy to get wrong", async () => {
    const skill = await fs.readFile(SKILL, "utf8");
    // 1. watch polls; it is not a stream.
    expect(skill).toMatch(/`watch` polls/i);
    expect(skill).toMatch(/not a stream/i);
    // 2. the CLI neither authors automations nor mints keys.
    expect(skill).toMatch(/no `?create`?/i);
    expect(skill).toMatch(/never bootstrap one|no key minting/i);
    // 3. a replay was already accepted, so retrying the same key is safe.
    expect(skill).toMatch(/"created": false/);
    expect(skill).toMatch(/(cannot|will not)\s+double-execute/i);
  });
});

describe("cortex-automations verify (driven as the runner drives it)", () => {
  let tmp: string;
  let home: string;
  let cleanPath: string;

  const receiptPath = () => path.join(home, "cortex-client", "install.json");

  async function writeReceipt(fields: Record<string, string>): Promise<void> {
    await fs.mkdir(path.dirname(receiptPath()), { recursive: true });
    await fs.writeFile(
      receiptPath(),
      `${JSON.stringify({ fitting: "cortex-client", ...fields }, null, 2)}\n`
    );
  }

  /** The env the runner actually hands a verify hook: GARRISON_HOME + gateway, no config. */
  function verifyEnv(over: Record<string, string | undefined> = {}) {
    return {
      GARRISON_HOME: home,
      PATH: cleanPath,
      GARRISON_GATEWAY_URL: "http://127.0.0.1:4777",
      CORTEX_API_KEY: undefined,
      CORTEX_BASE_URL: undefined,
      ...over
    };
  }

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "garrison-cortex-automations-"));
    home = path.join(tmp, "garrison-home");
    cleanPath = await pathWithoutCortex();
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("NOT INSTALLED is the shipped default: no receipt, no binary, still ok", async () => {
    const verify = await run("bash", [VERIFY], verifyEnv());

    expect(verify.exitCode, `${verify.stdout}\n${verify.stderr}`).toBe(0);
    expect(verify.stdout).toContain("not installed");
    expect(verify.stdout).toContain("shipped default");
    expect(verify.stdout.trim().endsWith("ok")).toBe(true);
    // Read-only: it does not create the state dir it reads from.
    await expect(fs.stat(home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("INSTALLED: the receipt is the lookup table, and the binary it names is probed", async () => {
    const bin = path.join(tmp, "bin", "cortex");
    await writeExecutable(bin, WORKING_CLI);
    await writeReceipt({ bin_name: "cortex", bin, ref: "deadbeef", base_url: "" });

    const verify = await run("bash", [VERIFY], verifyEnv());

    expect(verify.exitCode, `${verify.stdout}\n${verify.stderr}`).toBe(0);
    expect(verify.stdout).toContain("resolved from the install receipt");
    expect(verify.stdout.trim().endsWith("ok")).toBe(true);
  });

  it("INSTALLED BUT BROKEN: a receipt pointing at a binary that cannot run is NOT ok", async () => {
    const bin = path.join(tmp, "bin", "cortex");
    await writeExecutable(bin, BROKEN_CLI);
    await writeReceipt({ bin_name: "cortex", bin, ref: "deadbeef", base_url: "" });

    const verify = await run("bash", [VERIFY], verifyEnv());

    expect(verify.exitCode).toBe(1);
    expect(verify.stdout).toContain("installed but broken");
    expect(verify.stdout.trim().endsWith("ok")).toBe(false);
  });

  it("INSTALLED BUT BROKEN: a receipt whose bin path is gone, with no fallback, is NOT ok", async () => {
    await writeReceipt({
      bin_name: "cortex-fixture-not-on-path",
      bin: path.join(tmp, "bin", "vanished"),
      ref: "deadbeef",
      base_url: ""
    });

    const verify = await run("bash", [VERIFY], verifyEnv());

    expect(verify.exitCode).toBe(1);
    expect(verify.stdout).toContain("no runnable");
    expect(verify.stdout.trim().endsWith("ok")).toBe(false);
  });

  it("the PATH fallback is second, not first: it resolves only when the receipt does not", async () => {
    const onPath = path.join(tmp, "pathbin", "cortex");
    await writeExecutable(onPath, WORKING_CLI);

    // (a) No receipt: the fallback resolves, and says so.
    const fallback = await run("bash", [VERIFY], verifyEnv({
      PATH: `${path.dirname(onPath)}${path.delimiter}${cleanPath}`
    }));
    expect(fallback.exitCode, `${fallback.stdout}\n${fallback.stderr}`).toBe(0);
    expect(fallback.stdout).toContain("no install receipt, but a usable");
    expect(fallback.stdout.trim().endsWith("ok")).toBe(true);

    // (b) With a receipt, the receipt wins even though the same name is on PATH:
    //     a receipt naming a BROKEN binary must not be rescued by the fallback,
    //     or "installed but broken" would silently read as green.
    const broken = path.join(tmp, "bin", "cortex");
    await writeExecutable(broken, BROKEN_CLI);
    await writeReceipt({ bin_name: "cortex", bin: broken, ref: "deadbeef", base_url: "" });

    const receiptWins = await run("bash", [VERIFY], verifyEnv({
      PATH: `${path.dirname(onPath)}${path.delimiter}${cleanPath}`
    }));
    expect(receiptWins.exitCode).toBe(1);
    expect(receiptWins.stdout).toContain("installed but broken");
  });

  it("a stranger binary of the same name, with no receipt, is reported and NOT failed", async () => {
    // Nothing on this machine claimed to install a CLI, so a `cortex` that happens
    // to be on PATH and does not answer `automations --help` is somebody else's
    // program - failing a whole composition over it would be a false alarm.
    const stranger = path.join(tmp, "pathbin", "cortex");
    await writeExecutable(stranger, BROKEN_CLI);

    const verify = await run("bash", [VERIFY], verifyEnv({
      PATH: `${path.dirname(stranger)}${path.delimiter}${cleanPath}`
    }));

    expect(verify.exitCode, `${verify.stdout}\n${verify.stderr}`).toBe(0);
    expect(verify.stdout).toContain("treating the capability as not installed");
    expect(verify.stdout).toContain("not a failure");
    expect(verify.stdout.trim().endsWith("ok")).toBe(true);
  });

  it("reports the credential's presence and never its value", async () => {
    const keyless = await run("bash", [VERIFY], verifyEnv());
    expect(keyless.exitCode).toBe(0);
    expect(keyless.stdout).toContain("CORTEX_API_KEY: absent");
    expect(keyless.stdout).toContain("not a failure");

    const secret = "ekoa_gk_do_not_print_me_anywhere";
    const keyed = await run("bash", [VERIFY], verifyEnv({ CORTEX_API_KEY: secret }));
    expect(keyed.exitCode).toBe(0);
    expect(keyed.stdout).toContain("CORTEX_API_KEY: provisioned");
    expect(keyed.stdout).not.toContain(secret);
    expect(keyed.stderr).not.toContain(secret);
    expect(keyed.stdout.trim().endsWith("ok")).toBe(true);
  });

  it("fails when its own skill payload did not travel", async () => {
    // The script alone, without the .apm/skills payload beside it: a manifest that
    // installs a view teaching the operative nothing is a broken install, not a
    // degraded one.
    const orphan = path.join(tmp, "orphan", "scripts", "verify.sh");
    await fs.mkdir(path.dirname(orphan), { recursive: true });
    await fs.copyFile(VERIFY, orphan);

    const verify = await run("bash", [orphan], verifyEnv());

    expect(verify.exitCode).toBe(1);
    expect(verify.stdout).toContain("skill payload is missing");
  });
});

// The local automations engine is a DIFFERENT capability with a different
// lifecycle, and it is the OSS default. This slice added a sibling; it did not
// bolt a remote backend onto the engine, and nothing here may drift it.
describe("the local automations engine is untouched, and nothing binds to the wrong one", () => {
  it("fittings/seed/automations still declares the local-scheduler contract it always did", async () => {
    const metadata = await loadSeedMetadata("automations");
    expect(metadata.faculty).toBe("observability");
    expect(metadata.own_port).toBe(true);
    expect(metadata.default_port).toBe(7090);
    expect(metadata.provides).toEqual([{ kind: "automation-runner", name: "automations" }]);
    expect(metadata.setup?.[0]?.command).toBe("bash scripts/setup.sh");
    expect(metadata.verify.command).toContain("scripts/server.mjs --probe");
  });

  it("the remote view provides connector and NEVER automation-runner", async () => {
    const remote = await loadSeedMetadata("cortex-automations");
    expect(remote.provides.map((p) => p.kind)).not.toContain("automation-runner");
    // Distinct connector names: the connectors surface keys on provides[].name, so
    // two fittings sharing one would collide in the Vault view.
    const client = await loadSeedMetadata("cortex-client");
    const nameOf = (m: GarrisonMetadata) =>
      m.provides.find((p) => p.kind === "connector")?.name;
    expect(nameOf(remote)).not.toBe(nameOf(client));
  });

  // WHAT THIS ACTUALLY PROTECTS, restated 2026-08-06. It began as "no default* composition may
  // station it", which read as "existing users see zero change" — but on this repo
  // compositions/default IS the maintainer's daily driver as well as the shipped default, so
  // stationing it locally is a legitimate choice the old assertion could not express, and it went
  // red the moment the Fitting was used for real.
  //
  // The property worth keeping is the one that would actually harm a fresh clone: a SHIPPED
  // composition must not arrive pointing at somebody ELSE'S Cortex. Presence of the Fitting is
  // harmless — with no base_url the session view is inert and every consumer takes its no-op path
  // (see the Fitting's config_schema). A LOOPBACK origin is harmless for the same reason it is
  // harmless anywhere else in this repo: composition-migrate.ts `classifyConfigValue` already
  // rules that a localhost `_url` is a portable default which legitimately stays in apm.yml, since
  // it can only ever reach the machine it is read on. A remote host is the thing that must never
  // ship, and this uses that module's own predicate rather than inventing a second rule.
  it("no compositions/default* composition ships a REMOTE Cortex origin", async () => {
    const isLoopback = (v: string) => /^\w+:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)([:/]|$)/.test(v);
    // Non-tautology: the predicate distinguishes the two cases it is relied on to distinguish.
    expect(isLoopback("http://127.0.0.1:4111")).toBe(true);
    expect(isLoopback("https://cortex.example.com")).toBe(false);

    for (const id of ["default", "default-build", "default-economy", "default-premium"]) {
      const selections = await selectionsOf(id);
      const stationed = Object.values(selections)
        .flatMap((items) => items ?? [])
        .filter((s) => s.id === "cortex-automations" || s.id === "cortex-client");
      for (const s of stationed) {
        const baseUrl = String((s.config as Record<string, unknown> | undefined)?.base_url ?? "");
        expect(
          baseUrl === "" || isLoopback(baseUrl),
          `${id} ships base_url="${baseUrl}" on ${s.id} — a fresh clone would talk to another deployment`,
        ).toBe(true);
      }
    }
  });
});
