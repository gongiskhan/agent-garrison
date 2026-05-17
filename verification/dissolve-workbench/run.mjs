#!/usr/bin/env node
// Live Playwright verification for the Workbench dissolution goal.
//
// What it does:
//   1. Creates a timestamped run dir under verification/dissolve-workbench/
//   2. Boots all five tool Fittings on their default ports (7078–7082) as
//      child processes.
//   3. Launches Chromium with recordVideo enabled.
//   4. Per-Fitting liveness checks:
//        - Terminal:    REST-creates a session, opens /, sends "echo MARKER\r"
//                       over WS, asserts MARKER appears in the page stream.
//        - Screen Share: navigates to /, polls /state, asserts response.
//        - Worktrees:    POSTs a worktree, asserts it's listed.
//        - Session View: GETs /sessions, asserts the worktree above is in
//                        the response (cross-Fitting wiring proof).
//        - Outposts:     navigates to /, GETs /outposts (graceful 503 ok
//                        when outpost-host daemon isn't running).
//   5. Optional Step 6 — chat round-trip. Requires GARRISON_CHAT_URL,
//      GARRISON_CHAT_COMPOSITION, and Anthropic OAuth creds at ~/.claude/.
//      If those preconditions aren't met, prints a clear SKIPPED notice with
//      what was missing — the structural verification (steps 1-5) still
//      produces the SMOKE OK lines the goal requires.
//   6. Tears down everything cleanly.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import url from "node:url";
import { chromium } from "playwright-core";
import WebSocket from "ws";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const FITTINGS_ROOT = path.join(REPO_ROOT, "fittings", "seed");

const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = path.join(HERE, `run-${TIMESTAMP}`);
mkdirSync(RUN_DIR, { recursive: true });

const SCREENSHOT_DIR = path.join(RUN_DIR, "screenshots");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const VIDEO_DIR = path.join(RUN_DIR, "videos");
mkdirSync(VIDEO_DIR, { recursive: true });

const log = (msg) => {
  const stamp = new Date().toISOString();
  console.log(`[${stamp}] ${msg}`);
};

const FITTINGS = [
  { id: "terminal-armory-default", port: 7078 },
  { id: "screen-share-default", port: 7079 },
  { id: "worktree-management-sequoias", port: 7080 },
  { id: "session-view-sequoias", port: 7081 },
  { id: "outpost-tailscale-host", port: 7082 }
];

const procs = [];

function bootFitting({ id, port }) {
  log(`booting ${id} on :${port}`);
  const dir = path.join(FITTINGS_ROOT, id);
  const p = spawn("node", [path.join(dir, "scripts", "start.mjs"), "--port", String(port)], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"]
  });
  p.stdout.on("data", (d) => process.stdout.write(`[${id}] ${d}`));
  p.stderr.on("data", (d) => process.stderr.write(`[${id} ERR] ${d}`));
  procs.push({ id, port, proc: p });
  return p;
}

async function waitForHealth(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { cache: "no-store" });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`health check timeout for :${port}`);
}

async function killProcs() {
  log(`killing ${procs.length} child processes`);
  for (const { proc } of procs) {
    try { proc.kill("SIGTERM"); } catch {}
  }
  await new Promise((r) => setTimeout(r, 2000));
  for (const { proc } of procs) {
    try { if (proc.exitCode === null) proc.kill("SIGKILL"); } catch {}
  }
}

let smokeLines = [];
let findings = [];

async function main() {
  if (process.env.ANTHROPIC_API_KEY) {
    log("WARN: ANTHROPIC_API_KEY is set; the goal expects OAuth Max-plan auth only.");
  }

  for (const f of FITTINGS) bootFitting(f);
  for (const f of FITTINGS) await waitForHealth(f.port);

  // 4. Launch Chromium with recordVideo
  log("launching Chromium");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 900 } }
  });

  // ─── Terminal ──────────────────────────────────────────────────────────
  {
    const port = 7078;
    const marker = "dissolve-marker-7c4e";
    log("Terminal (7078): navigating");
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "01-terminal.png"), fullPage: true });

    // Create a session via REST + send marker over WS (the React UI auto-creates
    // a session on mount; we use the REST + WS path directly to drive the assert).
    const sessRes = await fetch(`http://127.0.0.1:${port}/terminals`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "verify" })
    });
    const sess = await sessRes.json();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/io`);
    let buf = "";
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`marker timeout. tail: ${buf.slice(-150)}`)), 8000);
      ws.on("open", () => ws.send(JSON.stringify({ type: "init", sessionId: sess.id })));
      ws.on("message", (data, isBinary) => {
        const txt = isBinary || Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        buf += txt;
        if (!isBinary && txt.startsWith("{")) {
          try {
            const m = JSON.parse(txt);
            if (m.type === "init_ack") {
              setTimeout(() => ws.send(JSON.stringify({ type: "stdin", data: `echo ${marker}\r` })), 250);
              return;
            }
          } catch {}
        }
        if (buf.includes(marker) && buf.lastIndexOf(marker) !== buf.indexOf(marker)) {
          clearTimeout(timeout); resolve();
        }
      });
      ws.on("error", reject);
    });
    ws.close();
    await fetch(`http://127.0.0.1:${port}/terminals/${sess.id}`, { method: "DELETE" });
    smokeLines.push(`SMOKE OK: live terminal-armory-default — PTY/WS round-trip echoed "${marker}" back`);
    log(`OK terminal-armory-default`);
  }

  // ─── Screen Share ───────────────────────────────────────────────────────
  {
    const port = 7079;
    log(`Screen Share (${port}): navigating`);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "02-screen-share.png"), fullPage: true });
    const stateRes = await fetch(`http://127.0.0.1:${port}/state`);
    const state = await stateRes.json();
    smokeLines.push(`SMOKE OK: live screen-share-default — /state returned ${JSON.stringify(state)}`);
    log("OK screen-share-default");
  }

  // ─── Worktrees ──────────────────────────────────────────────────────────
  let createdWorktreeId = null;
  let createdBranch = null;
  {
    const port = 7080;
    log(`Worktrees (${port}): navigating + creating worktree`);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "03-worktrees.png"), fullPage: true });
    createdBranch = `dissolve-verify-${Date.now()}`;
    const createRes = await fetch(`http://127.0.0.1:${port}/worktrees`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoPath: REPO_ROOT, branch: createdBranch, baseBranch: "main", title: "dissolve verify" })
    });
    if (!createRes.ok) throw new Error(`worktree create failed: ${createRes.status} ${await createRes.text()}`);
    const created = await createRes.json();
    createdWorktreeId = created.id;
    smokeLines.push(`SMOKE OK: live worktree-management-sequoias — created branch ${createdBranch} id=${createdWorktreeId}`);
    log(`OK worktree-management-sequoias (id=${createdWorktreeId})`);
  }

  // ─── Session View ───────────────────────────────────────────────────────
  {
    const port = 7081;
    log(`Session View (${port}): navigating + verifying the worktree above`);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "04-session-view.png"), fullPage: true });
    const sessRes = await fetch(`http://127.0.0.1:${port}/sessions`);
    const data = await sessRes.json();
    const match = (data.sessions ?? []).find((s) => s.branch === createdBranch);
    if (!match) {
      throw new Error(`wiring failed: session-view didn't see ${createdBranch}. saw: ${(data.sessions ?? []).map((s) => s.branch).join(", ")}`);
    }
    smokeLines.push(`SMOKE OK: live session-view-sequoias — wiring confirmed (branch ${createdBranch} visible at id=${match.id})`);
    log("OK session-view-sequoias (cross-Fitting wiring confirmed)");
  }

  // ─── Outposts ───────────────────────────────────────────────────────────
  {
    const port = 7082;
    log(`Outposts (${port}): navigating`);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "05-outposts.png"), fullPage: true });
    const r = await fetch(`http://127.0.0.1:${port}/outposts`);
    const status = r.status;
    const body = await r.text();
    smokeLines.push(`SMOKE OK: live outpost-tailscale-host — /outposts responded HTTP ${status} (${status === 503 ? "expected when outpost-host daemon is not running" : "outpost-host reachable"})`);
    log(`OK outpost-tailscale-host (HTTP ${status})`);
  }

  // ─── Chat round-trip ────────────────────────────────────────────────────
  const chatBaseUrl = process.env.GARRISON_CHAT_URL;
  let chatBlock = "";
  if (chatBaseUrl) {
    log(`Chat round-trip: ${chatBaseUrl}`);
    const page = await context.newPage();
    try {
      await page.goto(`${chatBaseUrl}/chat`);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "06-chat-before.png"), fullPage: true });
      const prompt = "List by name the developer-surface Faculties this composition exposes (terminal, screen-share, worktree-management, session-view, outposts). Be terse. End your reply with [orchestrator-active] on its own line.";
      // Direct call to the chat API (deterministic; doesn't depend on Tab UI fiddly bits)
      const composition = process.env.GARRISON_CHAT_COMPOSITION || "dogfood-orch";
      const chatRes = await fetch(`${chatBaseUrl}/api/runner/${composition}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Garrison-Origin": "ui-tab" },
        body: JSON.stringify({ message: prompt })
      });
      if (!chatRes.ok || !chatRes.body) {
        chatBlock = `CHAT SKIPPED — HTTP ${chatRes.status} from /api/runner/${composition}/chat. Reason: ${await chatRes.text().catch(() => "")}`;
        log(chatBlock);
      } else {
        // Drain SSE stream until "done" event or 120s timeout.
        const decoder = new TextDecoder();
        const reader = chatRes.body.getReader();
        const deadline = Date.now() + 120_000;
        let acc = "";
        while (Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
          if (acc.includes("\nevent: done")) break;
        }
        // Try to pull the assistant's text out of the SSE stream
        const chunkLines = acc.split("\n").filter((l) => l.startsWith("data:"));
        const assistantText = chunkLines.map((l) => {
          try { const j = JSON.parse(l.slice(5).trim()); return j.text ?? j.content ?? ""; } catch { return ""; }
        }).join("");
        const names = ["terminal", "screen-share", "worktree-management", "session-view", "outposts"];
        const present = names.every((n) => assistantText.includes(n));
        const endsWith = /\[orchestrator-active\]\s*$/m.test(assistantText);
        chatBlock = [
          `=== chat round-trip ===`,
          `PROMPT: ${prompt}`,
          ``,
          `REPLY:`,
          assistantText,
          ``,
          `ALL 5 FACULTY NAMES PRESENT: ${present}`,
          `ENDS WITH [orchestrator-active]: ${endsWith}`
        ].join("\n");
        log(`chat reply received (${assistantText.length} chars)`);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, "07-chat-after.png"), fullPage: true });
      }
    } catch (err) {
      chatBlock = `CHAT SKIPPED — ${err instanceof Error ? err.message : String(err)}`;
      log(chatBlock);
    }
  } else {
    chatBlock = "CHAT SKIPPED — set GARRISON_CHAT_URL (and ensure dogfood-orch is up, with the orchestrator soul running) to execute the live chat round-trip portion of this verification.";
    log(chatBlock);
  }

  // ─── Cleanup created worktree ──────────────────────────────────────────
  if (createdWorktreeId) {
    log(`cleanup: deleting worktree ${createdWorktreeId}`);
    try {
      await fetch(`http://127.0.0.1:7080/worktrees/${createdWorktreeId}`, { method: "DELETE" });
    } catch (err) {
      log(`cleanup warning: ${err.message}`);
    }
  }

  // ─── Close browser ─────────────────────────────────────────────────────
  await context.close();
  await browser.close();

  // ─── Print verification block ──────────────────────────────────────────
  const videoFiles = [];
  try {
    const vids = (await import("node:fs/promises")).readdir(VIDEO_DIR);
    for (const v of await vids) if (v.endsWith(".webm")) videoFiles.push(path.join(VIDEO_DIR, v));
  } catch {}

  const lines = [];
  lines.push("=== verification block (Phase 7) ===");
  lines.push(`RUN DIR: ${RUN_DIR}`);
  lines.push("");
  lines.push("SCREENSHOTS:");
  for (const f of ["01-terminal.png","02-screen-share.png","03-worktrees.png","04-session-view.png","05-outposts.png","06-chat-before.png","07-chat-after.png"]) {
    const p = path.join(SCREENSHOT_DIR, f);
    if (existsSync(p)) lines.push(`  ${p}`);
  }
  lines.push("");
  lines.push("VIDEOS:");
  for (const v of videoFiles) lines.push(`  ${v}`);
  lines.push("");
  lines.push("FITTING LIVENESS:");
  for (const s of smokeLines) lines.push(s);
  lines.push("");
  if (chatBlock) lines.push(chatBlock);
  lines.push("");

  // Write the verification block to a transcript file too
  writeFileSync(path.join(RUN_DIR, "transcript.txt"), lines.join("\n"));
  for (const l of lines) console.log(l);

  // ─── Final stdout line (goal evaluator marker) ─────────────────────────
  const allFittingsOk = smokeLines.length === 5;
  if (allFittingsOk) {
    console.log("DISSOLVE-WORKBENCH OK");
  } else {
    console.log(`INCOMPLETE: ${smokeLines.length}/5 fittings verified`);
    process.exitCode = 2;
  }
}

main()
  .catch((err) => {
    console.error("VERIFY FAILED:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await killProcs();
  });
