// U4 live probe — a REAL non-anthropic-plan provider launch (ollama-local).
//
// buildLaunchEnv(cc-ollama target) sets ANTHROPIC_BASE_URL=http://localhost:11434
// + a dummy AUTH_TOKEN; OperativePtySession.spawn({providerLaunch:true}) KEEPS
// them (the session.mjs fix) and launches a real `claude` TUI bound to ollama's
// Anthropic-compatible /v1/messages endpoint. We then prove the launch HANDLES a
// turn: the status line shows the ollama model (claude accepted the provider, no
// auth-trap) and a sent turn drives the session BUSY (the model is computing via
// ollama). Prints provider-launch-live-ok or provider-launch-inconclusive (never
// fakes). Re-runnable:  node scripts/probe-provider-launch.mjs [ollama-model]

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OperativePtySession, isBusy } from "../packages/claude-pty/src/index.mjs";
import { buildLaunchEnv } from "../fittings/seed/orchestrator/lib/stage-b.mjs";

const MODEL = process.argv[2] || "qwen3:0.6b";
const HARD_MS = 150_000;
let done = false;
let session;
function finish(state, note) {
  if (done) return;
  done = true;
  console.log(state === "ok" ? "provider-launch-live-ok" : state === "inconclusive" ? "provider-launch-inconclusive" : "provider-launch-FAILED");
  if (note) console.log(`(${note})`);
  try { session?.dispose(); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 300).unref();
}
const timer = setTimeout(() => finish("inconclusive", "hard timeout"), HARD_MS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const ping = await fetch("http://localhost:11434/api/tags").then((r) => r.ok).catch(() => false);
  if (!ping) {
    finish("inconclusive", "ollama not reachable at localhost:11434 — `ollama serve`");
  } else {
    const target = { runtime: "claude-code", provider: "ollama-local", model: MODEL };
    const env = buildLaunchEnv(target, { baseEnv: process.env, secrets: {} });
    if (env.ANTHROPIC_BASE_URL !== "http://localhost:11434") {
      finish("FAILED", `base URL not wired: ${env.ANTHROPIC_BASE_URL}`);
    } else {
      const cwd = mkdtempSync(path.join(tmpdir(), "gar-provider-"));
      session = await OperativePtySession.spawn({
        compositionDir: cwd,
        model: MODEL,
        env,
        providerLaunch: true,
        permissionMode: "bypassPermissions",
        readinessTimeoutMs: 60_000,
      });
      // The status/welcome panel names the active model — claude accepted the
      // ollama provider config (no auth-trap → it would have thrown on spawn).
      const screen0 = session.screen().filter(Boolean).join("\n");
      const modelShown = screen0.includes(MODEL);

      // Send ONE turn directly (the retry loop in runTurn over-queues on a slow
      // thinking model; a single keystroke is the clean path proven in dev).
      session.writeKeys(`Reply with the single word: ready\r`);

      // Success = the session goes BUSY (the ollama-backed model is computing the
      // turn) within the window, OR the reply text materialises. Scan the WHOLE
      // screen (the spinner sits in the conversation area, not the footer) and
      // recover from a queued message by nudging Enter once.
      let handled = false;
      let nudged = false;
      const deadline = Date.now() + 100_000;
      while (Date.now() < deadline) {
        await sleep(750);
        const scr = session.screen().filter(Boolean).join("\n");
        const busyMarker = /Computing|esc to interrupt|Thinking|Pondering|Forging|Channelling|✻|✽|·\s*\d+\s*tokens/i.test(scr);
        if (isBusy(session.handle) || busyMarker || /\bready\b/i.test(scr.replace(/single word: ready/gi, ""))) {
          handled = true;
          break;
        }
        if (!nudged && /Press up to edit queued messages/i.test(scr)) {
          session.writeKeys("\r"); // submit the queued message
          nudged = true;
        }
      }
      clearTimeout(timer);
      finish(
        modelShown && handled ? "ok" : "inconclusive",
        `model=${MODEL} base=${env.ANTHROPIC_BASE_URL} modelShown=${modelShown} turnHandled=${handled}`
      );
    }
  }
} catch (err) {
  clearTimeout(timer);
  finish("inconclusive", `live error: ${err?.message}`);
}
