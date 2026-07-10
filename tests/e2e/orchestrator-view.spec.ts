import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import net from "node:net";
import path from "node:path";

// Deterministic UI test for the Model Router own-port view. Boots the router
// server with a SANDBOXED routing.json (seeded from the seed config) on a free
// port, then drives the page directly — the Compiled pane + manual simulator
// resolve client-side (bundled routing-core), so no live model is needed.

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
let configFile = "";

test.beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gar-router-e2e-"));
  configFile = path.join(dir, "routing.json");
  copyFileSync(SEED, configFile);
  const home = path.join(dir, "garrison-home");
  mkdirSync(home, { recursive: true });
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  proc = spawn("node", [SERVER], {
    env: { ...process.env, MODEL_ROUTER_CONFIG: configFile, MODEL_ROUTER_PORT: String(port), GARRISON_HOME: home },
    stdio: "ignore"
  });
  await waitReachable(`${baseUrl}/health`);
});

test.afterAll(() => {
  proc?.kill("SIGTERM");
});

test("Model Router view: matrix edit → simulate reflects it; discipline + continuations + profile in compiled; pins green/red", async ({ page }, testInfo) => {
  await page.goto(baseUrl);
  await expect(page.getByText("Model Router")).toBeVisible();

  // router-view-ok: edit a matrix cell (code/T2-deep → review) then simulate.
  await page.getByTestId("cell-code-T2-deep").selectOption("review");
  await expect(page.getByTestId("pending-restart")).toBeVisible({ timeout: 4000 }); // autosave PUT happened
  await page.getByTestId("tab-simulator").click();
  await page.getByTestId("sim-tasktype").selectOption("code");
  await page.getByTestId("sim-tier").selectOption("T2-deep");
  await page.getByTestId("sim-run").click();
  await expect(page.getByTestId("sim-trace")).toContainText("role=review");
  await expect(page.getByTestId("sim-trace")).toContainText("[route:");

  // simulator-pins-ok: pins run; valid pins green, the deliberately-wrong pin red.
  await page.getByTestId("run-pins").click();
  await expect(page.getByTestId("pin-pin-code-trivial").locator(".dot")).toHaveClass(/green/);
  await expect(page.getByTestId("pin-pin-image").locator(".dot")).toHaveClass(/green/);
  await expect(page.getByTestId("pin-pin-wrong").locator(".dot")).toHaveClass(/red/);

  // discipline-ok: change a T2 discipline field → compiled reflects it.
  await page.getByTestId("tab-policy").click();
  await page.getByTestId("disc-T2-deep-evidence").selectOption("table");
  await page.getByTestId("tab-compiled").click();
  await expect(page.getByTestId("compiled-output")).toContainText("evidence: table");

  // continuations-ok: the seeded continuation renders into the compiled section.
  await expect(page.getByTestId("compiled-output")).toContainText("Implement this plan?");

  // profiles-ok: switch profile → compiled (economy) shows the local provider.
  await page.getByTestId("compiled-profile").selectOption("economy");
  await expect(page.getByTestId("compiled-output")).toContainText("ollama-local");

  const shot = testInfo.outputPath("orchestrator-view.png");
  await page.screenshot({ path: shot, fullPage: true });
  console.log(`[orchestrator-view] screenshot: ${shot}`);
});
