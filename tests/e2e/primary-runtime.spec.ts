import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import net from "node:net";
import path from "node:path";

// GARRISON-RUNTIMES-V1 S3 (P3/D3/D4): the composer sets primaryRuntime and a
// per-target provider WITH THE GATEWAY DOWN. This boots ONLY the orchestrator
// own-port server over a sandboxed composition (no gateway, no operative, no
// Next app) and drives the real page: the Primary picker is fed by the
// composition's installed runtime fittings, an uninstalled runtime is
// unselectable, picking an installed one autosaves and recompiles policy.json,
// and a mechanism-bearing target exposes a provider select that persists.

const REPO_ROOT = process.cwd();
const SERVER = path.join(REPO_ROOT, "fittings", "seed", "orchestrator", "scripts", "server.mjs");
const SEED = path.join(REPO_ROOT, "fittings", "seed", "orchestrator", "config", "routing.seed.json");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function waitReachable(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) reject(new Error(`timeout waiting for ${url}`));
        else setTimeout(tick, 250);
      });
    };
    tick();
  });
}

let proc: ChildProcess | null = null;
let baseUrl = "";
let policyFile = "";

test.beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gar-primary-e2e-"));
  const configFile = path.join(dir, "routing.json");
  copyFileSync(SEED, configFile);
  const home = path.join(dir, "garrison-home");
  mkdirSync(home, { recursive: true });
  policyFile = path.join(home, "orchestrator", "policy.json");

  // Sandboxed composition: codex-runtime installed (with its D3 config-file
  // mechanism), ghost-runtime selected but NOT installed.
  const comp = path.join(dir, "composition");
  mkdirSync(path.join(comp, "apm_modules", "_local", "codex-runtime"), { recursive: true });
  writeFileSync(
    path.join(comp, "apm.yml"),
    [
      "name: e2e-comp",
      "x-garrison:",
      "  composition:",
      "    id: e2e",
      "    selections:",
      "      runtimes:",
      "        - id: codex-runtime",
      "          config: {}",
      "        - id: ghost-runtime",
      "          config: {}",
      ""
    ].join("\n")
  );
  writeFileSync(
    path.join(comp, "apm_modules", "_local", "codex-runtime", "apm.yml"),
    [
      "name: codex-runtime",
      "x-garrison:",
      "  faculty: runtimes",
      "  provides:",
      "    - kind: runtime",
      "      name: codex",
      "  provider_mechanism:",
      "    type: config-file",
      "    config_file: ~/.codex/config.toml",
      "    config_format: toml",
      "    config_key: model_providers",
      ""
    ].join("\n")
  );

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  proc = spawn("node", [SERVER], {
    env: {
      ...process.env,
      ORCHESTRATOR_CONFIG: configFile,
      ORCHESTRATOR_PORT: String(port),
      GARRISON_HOME: home,
      GARRISON_COMPOSITION_DIR: comp
    },
    stdio: "ignore"
  });
  await waitReachable(`${baseUrl}/health`);
});

test.afterAll(() => {
  proc?.kill("SIGTERM");
});

test("primary picker: installed runtimes selectable, uninstalled disabled, choice lands in policy.json — gateway down", async ({ page }) => {
  await page.goto(baseUrl);
  await expect(page.locator("h1")).toHaveText("Composer");

  const picker = page.locator(".primary-picker select");
  await expect(picker).toBeVisible();
  // Default present + composed runtimes listed; the uninstalled one is disabled.
  await expect(picker.locator("option", { hasText: "codex-runtime" })).toHaveCount(1);
  const ghost = picker.locator("option", { hasText: "ghost-runtime" });
  await expect(ghost).toBeDisabled();

  // Pick the installed runtime — autosave (debounced PUT) recompiles policy.json.
  await picker.selectOption("codex-runtime");
  await expect
    .poll(
      () => {
        try {
          return JSON.parse(readFileSync(policyFile, "utf8")).primaryRuntime;
        } catch {
          return null;
        }
      },
      { timeout: 8000 }
    )
    .toBe("codex-runtime");

  // Switch back to the default — restores the exact current behavior.
  await picker.selectOption("claude-code-runtime");
  await expect
    .poll(() => JSON.parse(readFileSync(policyFile, "utf8")).primaryRuntime, { timeout: 8000 })
    .toBe("claude-code-runtime");
});

test("a mechanism-bearing target exposes a provider select that persists to the policy", async ({ page }) => {
  await page.goto(baseUrl);
  await expect(page.locator("h1")).toHaveText("Composer");

  // The seed's codex checkpoint target runs on the codex engine, whose fitting
  // declares a config-file mechanism → provider select renders.
  const codexCard = page.locator(".tray .tcard").filter({ hasText: "codex-gpt55-high" });
  const sel = codexCard.locator(".tcard-provider");
  await expect(sel).toBeVisible();
  await expect(sel).toHaveAttribute("title", /config\.toml/);

  await sel.selectOption("ollama-local");
  await expect
    .poll(
      () => {
        try {
          const pol = JSON.parse(readFileSync(policyFile, "utf8"));
          return pol.targets["codex-gpt55-high"]?.provider ?? null;
        } catch {
          return null;
        }
      },
      { timeout: 8000 }
    )
    .toBe("ollama-local");

  // A target on an engine with NO composed fitting/mechanism shows no provider
  // control (D3: still a target, just without overrides).
  const opusCard = page.locator(".tray .tcard").filter({ hasText: "cc-opus-high" });
  await expect(opusCard.locator(".tcard-provider")).toHaveCount(0);
});
