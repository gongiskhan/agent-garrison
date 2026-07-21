import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { drillJudge } from "../fittings/seed/drill/assets/drill-judge";

// Q3 — drillJudge()'s own HTTP contract: reads the internal token, POSTs
// {mode:"judge", observation:{url,title,bodyText}, step:{description}} to
// GARRISON_BASE_URL/api/automations/vision, and returns result.passed.

const STUB_PORT = 7227;
const home = mkdtempSync(path.join(tmpdir(), "garrison-judge-home-"));
let stub: http.Server | null = null;
let lastBody: any = null;
let lastToken: string | null = null;
let browser: Browser | null = null;
let page: Page | null = null;
let nextPassed = true;

beforeAll(async () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "internal-token"), "test-token-abc", { mode: 0o600 });

  stub = http.createServer((req, res) => {
    lastToken = req.headers["x-garrison-internal"] as string;
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: { passed: nextPassed, reasoning: "stub" } }));
    });
  });
  await new Promise<void>((resolve) => stub!.listen(STUB_PORT, "127.0.0.1", () => resolve()));

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.goto("data:text/html,<title>Citations</title><h1>Citations</h1><p>marker [1] -> source row 1</p>");
}, 20000);

afterAll(async () => {
  await page?.close();
  await browser?.close();
  await new Promise((r) => stub?.close(() => r(undefined)));
  rmSync(home, { recursive: true, force: true });
});

describe("drillJudge()", () => {
  it("sends mode=judge with the question, page url/title/bodyText, and the internal token", async () => {
    process.env.GARRISON_BASE_URL = `http://127.0.0.1:${STUB_PORT}`;
    process.env.GARRISON_HOME = home;
    delete process.env.GARRISON_INTERNAL_TOKEN_PATH;
    nextPassed = true;

    const ok = await drillJudge(page!, "Do citation markers match their source rows in order?");
    expect(ok).toBe(true);
    expect(lastToken).toBe("test-token-abc");
    expect(lastBody.mode).toBe("judge");
    expect(lastBody.step.description).toBe("Do citation markers match their source rows in order?");
    expect(lastBody.observation.title).toBe("Citations");
    expect(lastBody.observation.bodyText).toContain("marker [1]");
  });

  it("returns false when the judge verdict says failed", async () => {
    nextPassed = false;
    const ok = await drillJudge(page!, "anything");
    expect(ok).toBe(false);
  });

  it("throws a clear error when the vision endpoint is unreachable", async () => {
    process.env.GARRISON_BASE_URL = "http://127.0.0.1:1"; // nothing listens here
    await expect(drillJudge(page!, "anything")).rejects.toThrow();
    process.env.GARRISON_BASE_URL = `http://127.0.0.1:${STUB_PORT}`;
  });
});
