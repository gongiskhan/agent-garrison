import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test, expect } from "@playwright/test";

// The public landing page (site/index.html) is a self-contained static file,
// so this spec brings its own tiny static server instead of using the sandbox
// dev server. Acceptance mirrors the landing brief: EN default, PT-PT toggle,
// ten Standing Orders each with a large inline SVG, real screenshots, no em
// dashes anywhere in the copy, licence text matching the repo LICENSE.

const SITE = path.resolve(__dirname, "..", "..", "site");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

let server: http.Server;
let origin: string;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const file = path.join(SITE, rel === "/" ? "index.html" : rel);
    if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("EN is the default and the dictionary hero renders with bolded concept terms", async ({
  page
}) => {
  await page.goto(origin);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator(".headword")).toHaveText("gar·ri·son");
  for (const term of ["operatives", "faculties", "fittings", "Fittings Registry", "orchestrator", "Quarters"]) {
    await expect(page.locator(".gloss b", { hasText: term }).first()).toBeVisible();
  }
});

test("ten Standing Orders, each with a large inline SVG illustration", async ({ page }) => {
  await page.goto(origin);
  const orders = page.locator(".order");
  await expect(orders).toHaveCount(10);
  for (let i = 0; i < 10; i++) {
    await expect(orders.nth(i).locator("svg")).toHaveCount(1);
    await expect(orders.nth(i).locator("h3")).not.toBeEmpty();
  }
});

test("the PT toggle switches all copy to PT-PT and back", async ({ page }) => {
  await page.goto(origin);
  await page.locator(".top .lang button[data-lang='pt']").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "pt-PT");
  await expect(page.locator(".headword")).toHaveText("guar·ni·ção");
  await expect(page.locator(".orders h2.big")).toHaveText("Ordens Permanentes");
  await expect(page.locator(".features h2.big")).toHaveText("A funcionar hoje.");
  await expect(page).toHaveTitle(/base estruturada/);
  await expect(page.locator(".hero .logo img")).toHaveAttribute("alt", /paliçada/);
  await page.locator(".top .lang button[data-lang='en']").click();
  await expect(page.locator(".headword")).toHaveText("gar·ri·son");
  await expect(page.locator(".orders h2.big")).toHaveText("Standing Orders");
});

test("no em dashes anywhere in either language's rendered copy", async ({ page }) => {
  await page.goto(origin);
  expect(await page.locator("body").innerText()).not.toContain("—");
  await page.locator(".top .lang button[data-lang='pt']").click();
  await expect(page.locator(".headword")).toHaveText("guar·ni·ção");
  expect(await page.locator("body").innerText()).not.toContain("—");
});

test("licence claim matches the repo LICENSE and the footer links GitHub", async ({ page }) => {
  const licence = fs.readFileSync(path.resolve(__dirname, "..", "..", "LICENSE"), "utf8");
  expect(licence).toContain("MIT License");
  await page.goto(origin);
  await expect(page.locator("footer .fm")).toContainText("MIT licence");
  await expect(page.locator("footer a[href*='github.com']")).toBeVisible();
});

test("the feature screenshots are real files that load", async ({ page }) => {
  await page.goto(origin);
  const imgs = page.locator(".shot img");
  await expect(imgs).toHaveCount(7);
  for (let i = 0; i < 7; i++) {
    // The images are loading="lazy": bring each into view, then wait for it.
    await imgs.nth(i).scrollIntoViewIfNeeded();
    await expect
      .poll(
        () => imgs.nth(i).evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0),
        { message: `screenshot ${i} failed to load`, timeout: 10_000 }
      )
      .toBe(true);
  }
});
