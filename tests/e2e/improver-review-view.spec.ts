import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import net from "node:net";
import path from "node:path";

// Deterministic UI test for the Improver review-queue own-port view (BRIEF U3).
// Boots the server with a sandboxed data dir + a pre-seeded "stale" proposal (so
// Reject has a target), then drives Run-now → Approve → Reject → the Autonomy
// tab. No live model — proposals come from a MEMORY.md fixture.

const REPO_ROOT = process.cwd();
const SERVER = path.join(REPO_ROOT, "fittings", "seed", "improver", "scripts", "server.mjs");

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

test.beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gar-improver-e2e-"));
  const data = path.join(dir, "data");
  const home = path.join(dir, "garrison-home");
  mkdirSync(data, { recursive: true });
  mkdirSync(home, { recursive: true });
  const memory = path.join(dir, "MEMORY.md");
  writeFileSync(memory, "- [Alpha](a.md) — hook a\n- [Beta](b.md) — hook b\n", "utf8");
  writeFileSync(path.join(dir, "target.md"), "# memory\n", "utf8");
  // a pre-seeded stale proposal so Reject has something to act on
  writeFileSync(
    path.join(data, "review-queue.json"),
    JSON.stringify(
      [
        {
          id: "skill-suggest-1",
          rule: "skill-suggest",
          targetClass: "skills",
          claim: "Promote the repeated grep-then-edit flow into a skill.",
          diff: "+ ## grep-then-edit\n+ a reusable skill",
          decision: "Create this skill?",
          status: "pending",
        },
      ],
      null,
      2
    ),
    "utf8"
  );
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  proc = spawn("node", [SERVER], {
    env: {
      ...process.env,
      IMPROVER_PORT: String(port),
      IMPROVER_DATA: data,
      IMPROVER_MEMORY: memory,
      IMPROVER_TARGET: path.join(dir, "target.md"),
      GARRISON_HOME: home,
    },
    stdio: "ignore",
  });
  await waitReachable(`${baseUrl}/health`);
});

test.afterAll(() => {
  proc?.kill("SIGTERM");
});

test("Improver review queue: run-now → approve (evidence) → reject → autonomy track record", async ({ page }, testInfo) => {
  await page.goto(baseUrl);
  await expect(page.getByText("Improver — Review Queue")).toBeVisible();

  // run-now creates the memory-consolidation proposal
  await page.getByTestId("btn-run-now").click();
  await expect(page.getByTestId("proposal-memory-consolidation-2")).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("status-memory-consolidation-2")).toHaveText("pending");

  // approve → applied with evidence
  await page.getByTestId("approve-memory-consolidation-2").click();
  await expect(page.getByTestId("status-memory-consolidation-2")).toHaveText("applied", { timeout: 5000 });
  await expect(page.getByTestId("evidence-memory-consolidation-2")).toBeVisible();

  // reject the pre-seeded proposal → rejected
  await page.getByTestId("reject-skill-suggest-1").click();
  await expect(page.getByTestId("status-skill-suggest-1")).toHaveText("rejected", { timeout: 5000 });

  // autonomy tab shows the memory-consolidation rule with an accept on record
  await page.getByTestId("tab-autonomy").click();
  await expect(page.getByTestId("autonomy-memory-consolidation")).toContainText("accepted 1");

  const shot = testInfo.outputPath("improver-review-view.png");
  await page.screenshot({ path: shot, fullPage: true });
  console.log(`[improver-review-view] screenshot: ${shot}`);
});
