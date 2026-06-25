import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..");
const IMPROVER = path.join(
  REPO_ROOT,
  "fittings",
  "seed",
  "improver-nightly",
  "scripts",
  "improver.mjs"
);

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runImprover(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn("node", [IMPROVER, ...args], {
      env: { ...process.env, VAULT_UNLOCKED: undefined, GARRISON_IMPROVER_VAULT_UNLOCKED: undefined }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code }));
  });
}

async function writeFixtureRepo(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "docs", "autothing", "evidence"), { recursive: true });
  await fs.mkdir(path.join(root, "docs", "autothing", "slices", "S1"), { recursive: true });
  await fs.mkdir(path.join(root, "logs"), { recursive: true });
  await fs.mkdir(path.join(root, "data"), { recursive: true });
  await fs.writeFile(path.join(root, "docs", "GARRISON_ROADMAP.md"), "# Roadmap\n\n- TODO: review stale evidence.\n", "utf8");
  await fs.writeFile(path.join(root, "docs", "DECISIONS.md"), "# Decisions\n\n## Settled\n", "utf8");
  await fs.writeFile(path.join(root, "docs", "CLAUDE_CONFIG_PLANE_HANDOFF.md"), "# Handoff\n", "utf8");
  await fs.writeFile(path.join(root, "docs", "FLOW_PLAN.md"), "# Flow\n", "utf8");
  await fs.writeFile(path.join(root, "CLAUDE.md"), "# Claude\n", "utf8");
  await fs.writeFile(path.join(root, "docs", "autothing", "evidence-index.json"), "[]\n", "utf8");
  await fs.writeFile(path.join(root, "docs", "autothing", "evidence", "screen.png"), "png", "utf8");
  await fs.writeFile(path.join(root, "docs", "autothing", "slices", "S1", "gate-status.json"), "{}\n", "utf8");
  await fs.writeFile(path.join(root, "logs", "launchd-stdout.log"), "ok\nTOKEN_SECRET=abc\n", "utf8");
}

describe("improver-nightly.mjs", () => {
  let tmpRoot: string;
  let repoRoot: string;
  let compositionDir: string;
  let stateDir: string;
  let artifactRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "garrison-improver-"));
    repoRoot = path.join(tmpRoot, "repo");
    compositionDir = path.join(repoRoot, "compositions", "default");
    stateDir = path.join(tmpRoot, "state");
    artifactRoot = path.join(tmpRoot, "artifacts");
    await fs.mkdir(compositionDir, { recursive: true });
    await writeFixtureRepo(repoRoot);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("records a skipped run when the vault appears locked", async () => {
    await fs.writeFile(path.join(repoRoot, "data", "vault.json"), "{}", "utf8");
    const result = await runImprover([
      "run",
      "--root",
      repoRoot,
      "--composition-dir",
      compositionDir,
      "--state-dir",
      stateDir,
      "--artifact-root",
      artifactRoot,
      "--json"
    ]);
    expect(result.exitCode).toBe(0);
    const record = JSON.parse(result.stdout);
    expect(record).toMatchObject({ status: "skipped", reason: "vault-locked" });
    expect(await fs.readFile(record.recordPath, "utf8")).toContain("\"vault-locked\"");
  });

  it("writes an artifact-compatible proposal fallback and run record", async () => {
    const result = await runImprover([
      "run",
      "--root",
      repoRoot,
      "--composition-dir",
      compositionDir,
      "--state-dir",
      stateDir,
      "--artifact-root",
      artifactRoot,
      "--require-vault",
      "false",
      "--json"
    ]);
    expect(result.exitCode).toBe(0);
    const record = JSON.parse(result.stdout);
    expect(record.status).toBe("completed");
    expect(record.artifact.mode).toBe("artifact-compatible-fallback");
    expect(record.artifact.uri).toMatch(/^garrison:\/\/artifacts\//);

    const proposal = await fs.readFile(record.artifact.path, "utf8");
    expect(proposal).toContain("# Improver Proposal");
    expect(proposal).toContain("Review Contract");
    expect(proposal).toContain("TOKEN_SECRET=[redacted]");

    const sidecar = JSON.parse(await fs.readFile(`${record.artifact.path}.meta.json`, "utf8"));
    expect(sidecar).toMatchObject({
      id: record.artifact.id,
      namespace: "improver",
      producer: "improver-nightly",
      mime: "text/markdown"
    });
  });

  it("records a skipped run when required local services are missing", async () => {
    const emptyRoot = path.join(tmpRoot, "empty-root");
    await fs.mkdir(emptyRoot, { recursive: true });
    const result = await runImprover([
      "run",
      "--root",
      emptyRoot,
      "--composition-dir",
      compositionDir,
      "--state-dir",
      stateDir,
      "--artifact-root",
      artifactRoot,
      "--require-vault",
      "false",
      "--artifact-cli",
      path.join(tmpRoot, "missing-artifacts.py"),
      "--artifact-fallback",
      "false",
      "--json"
    ]);
    expect(result.exitCode).toBe(0);
    const record = JSON.parse(result.stdout);
    expect(record.status).toBe("skipped");
    expect(record.reason).toBe("missing-services");
    expect(record.missingServices).toEqual(
      expect.arrayContaining(["docs-root", "roadmap-doc", "artifact-store-cli"])
    );
  });
});
