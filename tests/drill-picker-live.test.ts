import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPickScript, buildResolveScript, rectToPercent } from "../fittings/seed/drill/lib/picker.mjs";
import { openTab, evalJs } from "../fittings/seed/drill/lib/browser-fitting-client.mjs";

// D4/B2/B3 live — drives a REAL headless chromium (via browser-default) to
// prove the picker's in-page scripts actually work, not just that they parse.

const REPO = path.resolve(__dirname, "..");
const START = path.join(REPO, "fittings", "seed", "browser-default", "scripts", "start.mjs");
const PORT = 7188;
const BASE = `http://127.0.0.1:${PORT}`;
const GHOME = mkdtempSync(path.join(tmpdir(), "garrison-picker-live-"));
const VENDOR = path.join(REPO, "fittings", "seed", "drill", "dist", "picker-vendor.js");

let srv: ChildProcess | null = null;

async function waitHealthy(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`${BASE}/health`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

beforeAll(async () => {
  srv = spawn("node", [START, "--port", String(PORT), "--host", "127.0.0.1"], {
    stdio: "ignore",
    env: { ...process.env, GARRISON_HOME: GHOME }
  });
  process.env.GARRISON_BROWSER_URL = BASE;
  await waitHealthy(15000);
}, 20000);

afterAll(() => {
  if (srv && !srv.killed) srv.kill("SIGTERM");
  srv = null;
  delete process.env.GARRISON_BROWSER_URL;
  rmSync(GHOME, { recursive: true, force: true });
});

const FIXTURE_HTML =
  'data:text/html,' +
  encodeURIComponent(
    '<div style="position:absolute;top:40px;left:80px;width:200px;height:44px" ' +
      'data-testid="chat-composer" role="textbox" aria-label="Composer">Composer</div>' +
      '<button style="position:absolute;top:120px;left:80px" data-testid="send-btn">Send it</button>'
  );

describe("picker live (D4/B2/B3)", () => {
  it("picks an element at a point and captures testId/css/xpath anchors", async () => {
    const tabId = await openTab(FIXTURE_HTML);
    // Poll until rendered.
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      const v = await evalJs(tabId, "document.querySelector('[data-testid=\"chat-composer\"]') ? 1 : 0");
      ready = v === 1;
      if (!ready) await new Promise((r) => setTimeout(r, 250));
    }
    expect(ready).toBe(true);

    // Point inside the composer's rect (top:40 left:80 width:200 height:44 -> center ~ 180,62).
    const script = buildPickScript(180, 62, VENDOR);
    const anchors = await evalJs(tabId, script);
    expect(anchors).toBeTruthy();
    expect(anchors.testId).toBe("chat-composer");
    expect(anchors.role).toBe("textbox");
    expect(anchors.ariaLabel).toBe("Composer");
    expect(typeof anchors.css).toBe("string");
    expect(anchors.css.length).toBeGreaterThan(0);
    expect(typeof anchors.xpath).toBe("string");
    expect(anchors.xpath.startsWith("/")).toBe(true);
    expect(anchors.rect).toMatchObject({ x: 80, y: 40, width: 200, height: 44 });
    expect(anchors.viewport.w).toBeGreaterThan(0);

    const pct = rectToPercent(anchors.rect, anchors.viewport);
    expect(pct!.leftPct).toBeCloseTo((80 / anchors.viewport.w) * 100, 3);
  }, 30000);

  it("resolves a stored anchor set back to the live element (testId first) and its current rect", async () => {
    const tabId = await openTab(FIXTURE_HTML);
    for (let i = 0; i < 40; i++) {
      const v = await evalJs(tabId, "document.querySelector('[data-testid=\"send-btn\"]') ? 1 : 0");
      if (v === 1) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const resolveScript = buildResolveScript({ testId: "send-btn", css: "button.does-not-exist-anymore", xpath: "//nope", text: "Send it" });
    const resolved = await evalJs(tabId, resolveScript);
    expect(resolved).toBeTruthy();
    expect(resolved.matched).toBe("testId"); // testId still resolves even though css/xpath are stale
    expect(resolved.rect).toMatchObject({ x: 80, y: 120 });
  }, 30000);

  it("falls back down the ladder to text when testId/css/xpath are all stale", async () => {
    const tabId = await openTab(FIXTURE_HTML);
    for (let i = 0; i < 40; i++) {
      const v = await evalJs(tabId, "document.querySelector('[data-testid=\"send-btn\"]') ? 1 : 0");
      if (v === 1) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const resolveScript = buildResolveScript({ testId: "renamed-elsewhere", css: "#nope", xpath: "//nope", text: "Send it" });
    const resolved = await evalJs(tabId, resolveScript);
    expect(resolved).toBeTruthy();
    expect(resolved.matched).toBe("text");
  }, 30000);

  it("returns null (never guesses) when nothing resolves", async () => {
    const tabId = await openTab(FIXTURE_HTML);
    const resolveScript = buildResolveScript({ testId: "nope", css: "#nope", xpath: "//nope-at-all", text: "no such text anywhere" });
    const resolved = await evalJs(tabId, resolveScript);
    expect(resolved).toBeNull();
  }, 30000);
});
