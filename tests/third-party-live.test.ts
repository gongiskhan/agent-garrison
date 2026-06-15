import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// U4 — LIVE third-party round-trips (secondary-delegate-live-ok /
// gemini-runtime-live-ok). These bill external providers and take ~15-30s each,
// so they run only under GARRISON_LIVE_THIRDPARTY=1 (proven live during the U4
// build; re-runnable on demand). The argv/contract paths are covered free in the
// normal suite (codex-runtime.test.ts / gemini-runtime.test.ts).

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = process.env.GARRISON_LIVE_THIRDPARTY === "1";

function onPath(bin: string) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8" });
  return r.status === 0 && !!r.stdout.trim();
}

function runBridge(bridge: string, spec: object, env: Record<string, string>) {
  const out = execFileSync("node", [bridge, "delegate"], {
    input: JSON.stringify(spec),
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 180_000,
  });
  return JSON.parse(out);
}

describe.skipIf(!LIVE || !onPath("codex"))("U4 — codex live delegation (secondary-delegate-live-ok)", () => {
  it("delegates a real coding subtask; the returned artifact integrates", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "gar-codex-live-"));
    const bridge = path.join(REPO_ROOT, "fittings/seed/codex-runtime/scripts/bridge.mjs");
    const res = runBridge(
      bridge,
      { task: "Write a JavaScript function isPrime(n) that returns true iff n is a prime number. Reply with ONLY the function code in a single fenced block.", cwd },
      { CODEX_RUNTIME_DATA: path.join(cwd, "data") }
    );
    expect(Array.isArray(res.artifacts)).toBe(true);
    const md = res.artifacts.find((a: string) => a.endsWith(".md"));
    const content = readFileSync(md, "utf8");
    expect(content).toMatch(/function\s+isPrime/);
    // integrate: extract the function and run it
    const code = content.replace(/```[a-z]*/gi, "");
    // eslint-disable-next-line no-new-func
    const isPrime = new Function(`${code}; return isPrime;`)();
    expect(isPrime(7)).toBe(true);
    expect(isPrime(8)).toBe(false);
    expect(isPrime(13)).toBe(true);
  }, 200_000);
});

describe.skipIf(!LIVE || !onPath("gemini"))("U4 — gemini live image delegation (gemini-runtime-live-ok)", () => {
  it("delegates a real image task; a real image artifact path returns and exists", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "gar-gemini-live-"));
    const bridge = path.join(REPO_ROOT, "fittings/seed/gemini-runtime/scripts/bridge.mjs");
    const res = runBridge(
      bridge,
      {
        task: `Generate an image: write a 200x200 SVG of a blue circle on a white background to the file ${cwd}/circle.svg using the write_file tool. After writing it, print the absolute path on its own line.`,
        cwd,
      },
      { GEMINI_RUNTIME_DATA: path.join(cwd, "data") }
    );
    const img = (res.artifacts || []).find((a: string) => /\.(svg|png|jpg|jpeg|webp)$/i.test(a));
    expect(img).toBeTruthy();
    expect(existsSync(img)).toBe(true);
    expect(statSync(img).size).toBeGreaterThan(0);
  }, 200_000);
});
