#!/usr/bin/env node
// M8 live validation for PROGRESS-WEB-PARITY.md: run the SAME three scenarios
// once in a real interactive Claude Code terminal session and once in a live Web
// Channel thread on this machine, capturing both sides.
//
//   a) a plain question              — streaming + rendering
//   b) a two-tool-call coding task   — tool calls, results, permission prompt
//   c) an interrupt, then a steer    — Stop + queued mid-turn input
//
// Terminal side: packages/claude-pty drives the real TUI under node-pty and the
// xterm screen is dumped as text. Web side: a real Chromium drives the live
// web-channel port and screenshots each state. Everything lands under
//   evidence/web-parity-live/<side>-<scenario>.*
//
// Usage: node scripts/web-parity-live-check.mjs [--side terminal|web|both]
//        WEB_CHANNEL_URL=http://127.0.0.1:8083 (default: prod's port)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "evidence", "web-parity-live");
const WEB_URL = process.env.WEB_CHANNEL_URL ?? "http://127.0.0.1:8083";
const MODEL = process.env.WEB_PARITY_MODEL ?? "claude-opus-5";

const args = process.argv.slice(2);
const sideArg = args.includes("--side") ? args[args.indexOf("--side") + 1] : "both";

const SCENARIOS = {
  a: {
    id: "a-plain-question",
    prompt: "In one short sentence: what does the word 'garrison' mean?",
  },
  b: {
    id: "b-two-tools-and-permission",
    // Two tool calls where the SECOND is permission-gated on this machine:
    // Write is allowlisted in ~/.claude/settings.json but `cksum` is not, so
    // both sides must stop and ask before running it. (Picked against the real
    // allowlist rather than assumed - an allowlisted tool prompts on neither
    // side and would prove nothing.)
    prompt: "Write a file parity.txt containing exactly the word ready, then run `cksum parity.txt` in the shell and tell me the checksum.",
  },
  c: {
    id: "c-interrupt-and-steer",
    // Long enough to actually be interrupted, and phrased as a QUESTION on
    // purpose. A shell `sleep` is not usable (this environment blocks a
    // foreground sleep, so the model detaches it and the turn ends in seconds),
    // and an imperative "write an essay" is registered by the router as a board
    // run rather than answered in the thread - either way there is no streaming
    // turn left to interrupt.
    prompt: "In this conversation, tell me at length and in detail how military garrisons evolved from the Roman empire to the modern era. Several thorough paragraphs please.",
    steer: "Forget the sleep. Just reply with the single word done.",
  },
};

fs.mkdirSync(OUT, { recursive: true });

const save = (name, body) => {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  console.log(`[evidence] ${path.relative(REPO, file)}`);
  return file;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Terminal side ───────────────────────────────────────────────────────────

async function runTerminal() {
  const { OperativePtySession } = await import("../packages/claude-pty/src/index.mjs");
  const { captureLines, isWorking } = await import("../packages/claude-pty/src/screen.mjs");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "web-parity-term-"));
  const screen = () => captureLines(session.handle).join("\n").replace(/\s+$/gm, "").replace(/\n{3,}/g, "\n\n");

  console.log(`[terminal] scratch ${scratch}`);
  const session = await OperativePtySession.spawn({
    compositionDir: scratch,
    model: MODEL,
    // The point of the comparison: the terminal asks before it writes.
    permissionMode: "default",
    env: process.env,
  });

  const record = { scratch, model: MODEL, scenarios: {} };
  try {
    // (a) plain question
    const a = await session.runTurn({ message: SCENARIOS.a.prompt, timeoutMs: 180_000 });
    save(`terminal-${SCENARIOS.a.id}.txt`, screen());
    record.scenarios.a = { reply: a.reply ?? a.text ?? "", ok: Boolean(a.reply || a.text) };

    // (b) two tools + a permission prompt. runTurn cannot settle while the TUI
    // blocks on the prompt, so drive it by hand: watch the screen, capture the
    // prompt, answer it, then wait for the turn to finish.
    await session.handle.sendInput(SCENARIOS.b.prompt);
    let promptShot = null;
    for (let i = 0; i < 240; i += 1) {
      const text = screen();
      if (/Do you want to|❯\s*1\.\s*Yes|Yes, and don't ask again/i.test(text)) {
        promptShot = text;
        break;
      }
      await sleep(500);
    }
    if (promptShot) {
      save(`terminal-${SCENARIOS.b.id}-permission.txt`, promptShot);
      // "1" = allow once, the terminal's default highlighted choice.
      session.handle.writeRaw("1");
      await sleep(400);
      if (/Do you want to|Yes, and don't ask again/i.test(screen())) session.handle.writeRaw("\r");
    }
    for (let i = 0; i < 240; i += 1) {
      if (!isWorking(session.handle) && /cksum|checksum/i.test(screen())) break;
      await sleep(500);
    }
    save(`terminal-${SCENARIOS.b.id}.txt`, screen());
    record.scenarios.b = {
      permissionPromptSeen: Boolean(promptShot),
      fileWritten: fs.existsSync(path.join(scratch, "parity.txt")),
      fileBody: fs.existsSync(path.join(scratch, "parity.txt"))
        ? fs.readFileSync(path.join(scratch, "parity.txt"), "utf8").trim()
        : null,
    };

    // (c) interrupt mid-turn, then steer with a follow-up in the SAME session.
    // Busy/idle come from the TUI's own "esc to interrupt" marker; matching on
    // reply words is not safe here because the steer text itself sits on screen.
    // This CLI build renders no "(esc to interrupt)" hint - the working state is
    // a spinner line with a live progress parenthetical, which isWorking() knows.
    const busy = () => isWorking(session.handle);
    const waitBusy = async (ms) => {
      for (let i = 0; i < ms / 100; i += 1) { if (busy()) return true; await sleep(100); }
      return false;
    };
    const waitIdle = async (ms) => {
      let quiet = 0;
      for (let i = 0; i < ms / 500; i += 1) {
        quiet = busy() ? 0 : quiet + 1;
        if (quiet >= 3) return true;
        await sleep(500);
      }
      return false;
    };

    await session.handle.sendInput(SCENARIOS.c.prompt);
    const busySeen = await waitBusy(60_000);
    // Let it genuinely stream before the Esc lands.
    await sleep(8_000);
    const busyAtInterrupt = busy();
    session.handle.writeRaw("\u001b"); // Esc - interrupt, not kill
    await sleep(2_000);
    const stoppedShot = screen();
    save(`terminal-${SCENARIOS.c.id}-interrupted.txt`, stoppedShot);
    const idleAfterInterrupt = !busy();

    await session.handle.sendInput(SCENARIOS.c.steer);
    const steerBusy = await waitBusy(60_000);
    await waitIdle(180_000);
    save(`terminal-${SCENARIOS.c.id}.txt`, screen());
    record.scenarios.c = {
      busySeen,
      busyAtInterrupt,
      idleAfterInterrupt,
      interruptedText: /Interrupted|stopped by user|stopped/i.test(stoppedShot),
      steerAccepted: steerBusy,
      sessionAlive: !session.disposed,
    };
  } finally {
    try { await session.dispose?.(); } catch { /* best effort */ }
  }
  save("terminal-summary.json", record);
  return record;
}

// ── Web side ────────────────────────────────────────────────────────────────

async function runWeb() {
  const { chromium } = await import("playwright");
  const created = await fetch(`${WEB_URL}/api/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "M8 live parity", source: "web-parity-live" }),
  }).then((r) => r.json());
  const threadId = created?.thread?.id;
  if (!threadId) throw new Error(`could not create a thread on ${WEB_URL}`);
  // Pin the thread to the same Opus 5 Agent SDK target the terminal side runs, so
  // this is a like-for-like comparison AND the router does not send a long writing
  // prompt to the Kanban run engine (an explicit pin bypasses routing inference -
  // without it, scenario (c) was registered as a board card and there was no
  // streaming turn left to interrupt).
  // `duty: discuss` keeps a long request a CONVERSATION. Without it the live
  // orchestrator (correctly) registers substantive work as a board card, which
  // settles in seconds and leaves nothing to interrupt.
  const pin = { target: process.env.WEB_PARITY_TARGET ?? "fable", duty: "discuss", level: 1 };
  const pinned = await fetch(`${WEB_URL}/api/threads/${encodeURIComponent(threadId)}/routing`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ routing: pin }),
  }).then((r) => r.json());
  console.log(`[web] thread ${threadId} pinned to ${JSON.stringify(pinned?.routing ?? null)}`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  const record = { threadId, url: WEB_URL, pin, scenarios: {} };
  const shot = (name) => page.screenshot({ path: path.join(OUT, `web-${name}.png`), fullPage: false })
    .then(() => console.log(`[evidence] evidence/web-parity-live/web-${name}.png`));

  const send = async (text) => {
    await page.locator(".cc-input").fill(text);
    await page.locator(".cc-send").click();
  };
  const settled = async (timeoutMs = 300_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const thread = await fetch(`${WEB_URL}/api/threads/${encodeURIComponent(threadId)}`).then((r) => r.json());
      const pending = thread?.pendingInputs ?? thread?.thread?.pendingInputs ?? [];
      if (pending.length === 0 && (thread?.thread?.messages ?? []).length > 0) return thread;
      await sleep(1_000);
    }
    throw new Error("web turn did not settle");
  };

  try {
    await page.goto(`${WEB_URL}/?thread=${encodeURIComponent(threadId)}`, { waitUntil: "domcontentloaded" });
    await page.locator(".cc-input").waitFor({ state: "visible", timeout: 30_000 });

    // (a) plain question — capture mid-stream and settled.
    await send(SCENARIOS.a.prompt);
    await sleep(4_000);
    await shot(`${SCENARIOS.a.id}-streaming`);
    const afterA = await settled();
    await shot(SCENARIOS.a.id);
    record.scenarios.a = {
      reply: (afterA.thread.messages.filter((m) => m.role === "assistant").pop() ?? {}).text ?? "",
    };

    // (b) two tools + permission prompt.
    await send(SCENARIOS.b.prompt);
    // A real turn can ask more than once (Write, then the shell command), so keep
    // answering until the turn settles - exactly what a user at the keyboard does.
    let permissionsAnswered = 0;
    const answerPrompts = async (deadline) => {
      while (Date.now() < deadline) {
        const pending = page.locator(".cc-session-permission.is-pending");
        if (await pending.count()) {
          if (permissionsAnswered === 0) await shot(`${SCENARIOS.b.id}-permission`);
          const allow = pending.first().getByRole("button", { name: "Allow once" });
          if (await allow.count()) {
            await allow.click().catch(() => {});
            permissionsAnswered += 1;
          }
        }
        const thread = await fetch(`${WEB_URL}/api/threads/${encodeURIComponent(threadId)}`).then((r) => r.json());
        const inputs = thread?.pendingInputs ?? thread?.thread?.pendingInputs ?? [];
        if (inputs.length === 0) return true;
        await sleep(1_500);
      }
      return false;
    };
    await answerPrompts(Date.now() + 420_000);
    const permissionSeen = permissionsAnswered > 0;
    const afterB = await settled();
    // Expand the first tool card so the captured evidence shows a real result.
    const tool = page.locator("details.cc-session-tool").first();
    if (await tool.count()) await tool.locator("summary").click().catch(() => {});
    await shot(SCENARIOS.b.id);
    record.scenarios.b = {
      permissionSeen,
      permissionsAnswered,
      toolCards: await page.locator("details.cc-session-tool").count(),
      reply: (afterB.thread.messages.filter((m) => m.role === "assistant").pop() ?? {}).text ?? "",
    };

    // (c) interrupt, then a queued steer. Everything here needs the turn to be
    // genuinely RUNNING, so wait for the durable input state rather than a sleep.
    await send(SCENARIOS.c.prompt);
    let running = false;
    for (let i = 0; i < 120; i += 1) {
      const thread = await fetch(`${WEB_URL}/api/threads/${encodeURIComponent(threadId)}`).then((r) => r.json());
      const inputs = thread?.pendingInputs ?? thread?.thread?.pendingInputs ?? [];
      if (inputs.some((input) => input.state === "running")) { running = true; break; }
      if (i > 8 && inputs.length === 0) break; // settled without ever running
      await sleep(1_000);
    }
    // Let it stream visibly before anything else happens.
    await sleep(10_000);
    await shot(`${SCENARIOS.c.id}-running`);

    // Queue the steer WHILE the turn runs — the mid-turn input case.
    await page.locator(".cc-input").fill(SCENARIOS.c.steer);
    const sendLabel = ((await page.locator(".cc-send").textContent()) ?? "").trim();
    await page.locator(".cc-send").click();
    await sleep(1_000);
    const queuedVisible = await page.locator(".cc-lifecycle-label").filter({ hasText: "Queued" }).count();
    await shot(`${SCENARIOS.c.id}-queued`);

    const stop = page.locator(".cc-stop").first();
    const stopped = await stop.count() ? await stop.click().then(() => true).catch(() => false) : false;
    await sleep(4_000);
    await shot(`${SCENARIOS.c.id}-interrupted`);
    const afterC = await settled(600_000);
    await shot(SCENARIOS.c.id);
    const terminals = (afterC.thread.sessionEvents ?? [])
      .filter((e) => e.id.startsWith("terminal:"))
      .map((e) => (e.blocks.find((b) => b.type === "turn_end") ?? {}).status);
    record.scenarios.c = {
      turnRanLive: running,
      sendLabelWhileBusy: sendLabel,
      queuedRowsVisible: queuedVisible,
      stopClicked: stopped,
      terminalStatuses: terminals,
      messages: afterC.thread.messages.map((m) => [m.role, (m.text ?? "").slice(0, 120)]),
    };

    const finalThread = await fetch(`${WEB_URL}/api/threads/${encodeURIComponent(threadId)}`).then((r) => r.json());
    record.sessionIds = finalThread?.thread?.sessionIds ?? [];
    record.sessionEventKinds = [...new Set((finalThread?.thread?.sessionEvents ?? [])
      .flatMap((e) => (e.blocks ?? []).map((b) => b.type)))];
  } finally {
    await context.close();
    await browser.close();
  }
  save("web-summary.json", record);
  return record;
}

const side = sideArg === "terminal" || sideArg === "web" ? sideArg : "both";
if (side === "terminal" || side === "both") await runTerminal();
if (side === "web" || side === "both") await runWeb();
console.log("[web-parity] done");
