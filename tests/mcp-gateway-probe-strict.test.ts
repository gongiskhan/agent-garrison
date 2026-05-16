import { describe, expect, it, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const GATEWAY_SCRIPT = path.resolve(
  __dirname,
  "..",
  "fittings",
  "seed",
  "mcp-gateway",
  "scripts",
  "gateway.mjs"
);

const tempDirs: string[] = [];

afterEach(async () => {
  for (const d of tempDirs.splice(0)) {
    await fsp.rm(d, { recursive: true, force: true }).catch(() => null);
  }
});

async function makeEmptyComposition(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-strict-probe-"));
  tempDirs.push(dir);
  return dir;
}

async function makeFullComposition(): Promise<string> {
  // Synthesise a composition dir with stub scripts at the expected paths so
  // both probes report ready. The stubs each print "ok" on --probe and exit 0.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-strict-probe-full-"));
  tempDirs.push(dir);
  const tier = path.join(dir, "apm_modules", "_local", "tier-classifier", "scripts");
  const testing = path.join(dir, "apm_modules", "_local", "testing", "scripts");
  await fsp.mkdir(tier, { recursive: true });
  await fsp.mkdir(testing, { recursive: true });
  const stub = `#!/usr/bin/env node\nif (process.argv.includes('--probe')) { process.stdout.write('ok\\n'); process.exit(0); }\nprocess.exit(0);\n`;
  await fsp.writeFile(path.join(tier, "classify_tier.mjs"), stub, { mode: 0o755 });
  await fsp.writeFile(path.join(testing, "run_tests.mjs"), stub, { mode: 0o755 });
  return dir;
}

function runProbe(args: string[], compositionDir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [GATEWAY_SCRIPT, ...args], {
      env: { ...process.env, GARRISON_COMPOSITION_DIR: compositionDir },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("mcp-gateway --probe", () => {
  it("lenient default exits 0 even when both underlying probes are absent", async () => {
    const dir = await makeEmptyComposition();
    const result = await runProbe(["--probe"], dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("classify_tier=absent");
    expect(result.stdout).toContain("run_tests=absent");
  }, 15_000);

  it("strict exits non-zero when both probes are absent", async () => {
    const dir = await makeEmptyComposition();
    const result = await runProbe(["--probe", "--strict"], dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("missing underlying probe(s): classify_tier, run_tests");
  }, 15_000);

  it("strict exits non-zero when only one probe is missing", async () => {
    const dir = await makeFullComposition();
    // Remove the testing stub
    await fsp.rm(path.join(dir, "apm_modules", "_local", "testing", "scripts", "run_tests.mjs"));
    const result = await runProbe(["--probe", "--strict"], dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/run_tests/);
  }, 15_000);

  it("strict exits 0 when both probes succeed", async () => {
    const dir = await makeFullComposition();
    const result = await runProbe(["--probe", "--strict"], dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ok (strict;");
  }, 15_000);
});
