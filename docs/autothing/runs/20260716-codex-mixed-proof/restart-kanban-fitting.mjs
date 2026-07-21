import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = "http://127.0.0.1:27777";
const BOARD = "http://127.0.0.1:27089";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VISION = path.join(HERE, "vision");

const before = await (await fetch(`${BOARD}/health`)).json();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
page.setDefaultTimeout(180_000);

try {
  await page.goto(`${APP}/fitting/kanban-loop`, { waitUntil: "domcontentloaded" });
  const button = page.getByRole("button", { name: "Restart", exact: true });
  await button.waitFor();
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST"
      && response.url().includes("/api/fittings/kanban-loop/restart")
  );
  await button.click();
  const response = await responsePromise;
  if (!response.ok()) throw new Error(`Kanban restart failed: ${response.status()} ${await response.text()}`);
  await page.waitForFunction(async ({ url, prior }) => {
    try {
      const response = await fetch(`${url}/health`, { cache: "no-store" });
      if (!response.ok) return false;
      const body = await response.json();
      return body.ok === true && body.pid && body.pid !== prior;
    } catch { return false; }
  }, { url: BOARD, prior: before.pid });
  await page.screenshot({ path: path.join(VISION, "15-kanban-fitting-restarted.png"), fullPage: true });
  const after = await (await page.request.get(`${BOARD}/health`)).json();
  console.log(JSON.stringify({ action: "Restart Kanban fitting through Fitting UI", before, after }, null, 2));
} finally {
  await browser.close();
}
