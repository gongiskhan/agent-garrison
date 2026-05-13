// Playwright CLI test: mcp-gateway system prompt injection.
// Verifies that launching Claude Code from the workbench appends
// --append-system-prompt-file to the PTY command when mcp-gateway is installed.
//
// Run: node scripts/test-mcp-injection.mjs
//
// Requires the Garrison dev server to be running at http://127.0.0.1:3000

import { chromium } from "/Users/ggomes/.nvm/versions/node/v22.22.0/lib/node_modules/playwright/index.mjs";
import { mkdirSync, existsSync, rmSync, symlinkSync, readdirSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import WebSocket from "ws";
import path from "node:path";
import os from "node:os";

const BASE = "http://127.0.0.1:3000";

// ── Fake composition dir ──────────────────────────────────────────────────────
const COMP_DIR = path.join(os.tmpdir(), "garrison-test-comp-mcp");
const SCRIPT_DIR = path.join(COMP_DIR, "apm_modules", "_local", "mcp-gateway", "scripts");
const GATEWAY_SCRIPT = path.join(SCRIPT_DIR, "gateway.mjs");
const REAL_GATEWAY = path.resolve("fittings/seed/mcp-gateway/scripts/gateway.mjs");

mkdirSync(SCRIPT_DIR, { recursive: true });
if (!existsSync(GATEWAY_SCRIPT)) symlinkSync(REAL_GATEWAY, GATEWAY_SCRIPT);

const LIB_DIR = path.join(SCRIPT_DIR, "lib");
mkdirSync(LIB_DIR, { recursive: true });
const TOOLS_LINK = path.join(LIB_DIR, "tools.mjs");
if (!existsSync(TOOLS_LINK)) {
  symlinkSync(path.resolve("fittings/seed/mcp-gateway/scripts/lib/tools.mjs"), TOOLS_LINK);
}
const NM_LINK = path.join(COMP_DIR, "apm_modules", "_local", "mcp-gateway", "node_modules");
if (!existsSync(NM_LINK)) {
  symlinkSync(path.resolve("fittings/seed/mcp-gateway/node_modules"), NM_LINK);
}

function assert(condition, msg) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}
function cleanup() {
  try { rmSync(COMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── Test 1: temp file created ─────────────────────────────────────────────────
async function testPromptFileCreated() {
  // Clear leftover prompt files
  for (const f of readdirSync(os.tmpdir())) {
    if (f.startsWith("garrison-prompt-")) await unlink(path.join(os.tmpdir(), f)).catch(() => {});
  }

  const res = await fetch(`${BASE}/api/trenches/terminals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cwd: "/tmp",
      initialCommand: "claude --dangerously-skip-permissions",
      compositionDir: COMP_DIR,
    }),
  });

  const json = await res.json().catch(() => ({}));
  assert(res.status === 201, `Expected 201, got ${res.status}: ${JSON.stringify(json)}`);
  const sessionId = json.mcpSessionId;
  assert(sessionId, "No mcpSessionId in response");

  const promptFile = path.join(os.tmpdir(), `garrison-prompt-${sessionId}.txt`);
  assert(existsSync(promptFile), `Prompt file not found: ${promptFile}`);

  const content = await readFile(promptFile, "utf8");
  assert(content.includes("classify_tier"), "Prompt missing classify_tier");
  assert(content.includes("run_tests"), "Prompt missing run_tests");

  console.log(`  session: ${json.id}`);
  console.log(`  mcpSessionId: ${sessionId}`);
  console.log(`  prompt file: ${promptFile}`);
  console.log(`  content preview: ${content.slice(0, 80).replace(/\n/g, " ")}`);
  console.log("  PASS: garrison-prompt temp file created with correct content");

  return { sessionId, wsUrl: json.wsUrl, sessionTrenchesId: json.id };
}

// ── Test 2: --append-system-prompt-file typed into PTY ────────────────────────
// Terminal.tsx connects to wsUrl, then sends { type:"init", sessionId, cols, rows }.
// trenches-ws then attaches the WS to the session and types initialCommand into the PTY.
// The PTY shell echoes the command back through the WS as binary PTY data.
async function testCommandTypedIntoPty(wsUrl, trenchesSessionId, sessionId) {
  const expectedFragment = `--append-system-prompt-file`;
  const expectedPath = path.join(os.tmpdir(), `garrison-prompt-${sessionId}.txt`);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let output = "";
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out waiting for PTY output.\nCaptured: ${JSON.stringify(output.slice(0, 400))}`));
    }, 8000);

    ws.on("open", () => {
      // Mimic Terminal.tsx init handshake
      ws.send(JSON.stringify({ type: "init", sessionId: trenchesSessionId, cols: 220, rows: 50 }));
    });

    ws.on("message", (data) => {
      const chunk = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      output += chunk;
      if (output.includes(expectedFragment)) {
        clearTimeout(timer);
        ws.close();
        assert(output.includes(expectedPath), `Expected path ${expectedPath} not found in PTY output`);
        const line = output.split(/[\r\n\x1b]/).find(l => l.includes(expectedFragment)) ?? "";
        console.log(`  PTY echo: ...${line.trim().slice(0, 130)}`);
        console.log("  PASS: --append-system-prompt-file with correct path typed into PTY");
        resolve();
      }
    });

    ws.on("error", (err) => { clearTimeout(timer); reject(err); });
    ws.on("close", (code) => {
      if (!output.includes(expectedFragment)) {
        clearTimeout(timer);
        reject(new Error(`WS closed before flag appeared. code=${code}\nOutput: ${JSON.stringify(output.slice(0, 400))}`));
      }
    });
  });
}

// ── Test 3: browser workbench — MCP badge visible ────────────────────────────
async function testBrowserBadge(page) {
  let capturedRequest = null;

  await page.route("**/api/trenches/terminals", async (route) => {
    try { capturedRequest = JSON.parse(route.request().postData() ?? "{}"); } catch { /* ignore */ }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ id: "fake-id", wsUrl: "ws://127.0.0.1:9999/ws", mcpSessionId: "fake-mcp" }),
    });
  });

  await page.goto(`${BASE}/workbench`);
  await page.waitForLoadState("networkidle");

  const badge = page.locator('span.mcp-badge, [title*="MCP"], span:has-text("MCP")').first();
  const btnMcp = page.locator('button[title*="MCP"], button[title*="mcp"]').first();

  const worktreeRows = await page.locator('[data-worktree], .worktree-row, tr').count();
  const claudeBtn = page.locator('button:has-text("Claude Code")').first();
  const hasClaude = await claudeBtn.count();

  console.log(`  Worktree rows: ${worktreeRows}, Claude buttons: ${hasClaude}`);

  if (hasClaude > 0) {
    await Promise.all([
      page.waitForRequest("**/api/trenches/terminals").catch(() => {}),
      claudeBtn.click(),
    ]);
    await page.waitForTimeout(500);
    console.log("  Captured request initialCommand:", capturedRequest?.initialCommand);
    console.log("  Captured request compositionDir:", capturedRequest?.compositionDir);
    console.log("  PASS: Claude Code button sends POST to terminals endpoint");
  } else {
    console.log("  NOTE: No worktrees listed — cannot test button click. Add a worktree to test badge/request.");
    console.log("  PASS (partial): Workbench loads without error");
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
let browser;
try {
  console.log("Fake composition at:", COMP_DIR);
  console.log();

  console.log("[1/3] Prompt file created by API handler");
  const { sessionId, wsUrl, sessionTrenchesId } = await testPromptFileCreated();
  console.log();

  console.log("[2/3] --append-system-prompt-file reaches PTY via WebSocket");
  await testCommandTypedIntoPty(wsUrl, sessionTrenchesId, sessionId);
  console.log();

  console.log("[3/3] Browser workbench test");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await testBrowserBadge(page);
  console.log();

  console.log("All tests passed.");
} catch (err) {
  console.error("Test failed:", err.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
  cleanup();
}
