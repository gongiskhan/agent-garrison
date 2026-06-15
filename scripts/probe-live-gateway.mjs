// U1 live probe — a REAL prompt through the gateway with a LIVE claude session.
//
// Boots the real gateway-pty.mjs (NO stub) with a tiny system prompt that makes
// the operative honor the [gateway-route:] annotation, then POSTs two prompts
// over HTTP: one resolving to cc-sonnet-med, one (trivial) resolving to
// cc-haiku-low. Asserts the decisions.jsonl entry + the honored route token from
// a real model (live-route-ok), and that the second prompt landed on a different
// target via the in-place slash-inject switch (live-switch-ok).
//
// Evidence, not a gate (the committed gate is tests/gateway-routing.test.ts +
// tests/gateway-live-route.integration.test.ts). Hard-timeout guarded; prints
// *-inconclusive (never fakes) if claude is unavailable. Re-runnable:
//   node scripts/probe-live-gateway.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const GATEWAY = path.join(ROOT, "fittings/seed/http-gateway/scripts/gateway-pty.mjs");
const HARD_MS = 240_000;

let done = false;
let proc;
function finish(routeState, switchState, note) {
  if (done) return;
  done = true;
  console.log(routeState === "ok" ? "live-route-ok" : routeState === "inconclusive" ? "live-route-inconclusive" : "live-route-FAILED");
  console.log(switchState === "ok" ? "live-switch-ok" : switchState === "inconclusive" ? "live-switch-inconclusive" : "live-switch-FAILED");
  if (note) console.log(`(${note})`);
  try { proc?.kill("SIGTERM"); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 500).unref();
}
const timer = setTimeout(() => finish("inconclusive", "inconclusive", "hard timeout"), HARD_MS);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitReady(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      const j = await r.json();
      if (j.pty_status === "ready") return true;
      if (j.pty_status === "failed") throw new Error(`gateway failed: ${j.error}`);
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function chat(port, message, timeoutMs = 120_000) {
  const r = await fetch(`http://127.0.0.1:${port}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`/chat ${r.status}: ${await r.text()}`);
  return r.json();
}

function readDecisions(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

try {
  const port = await freePort();
  const tmp = mkdtempSync(path.join(tmpdir(), "gar-live-gw-"));
  mkdirSync(path.join(tmp, ".garrison"), { recursive: true });
  const sysPrompt = path.join(tmp, "system-prompt.md");
  writeFileSync(
    sysPrompt,
    [
      "You are a terse routing-test operative.",
      "Every user message begins with a line `[gateway-route: target=T rule=R profile=P]`.",
      "Answer the task in ONE short sentence, then on the FINAL line emit EXACTLY:",
      "`[route: T | rule: R | profile: P]` — copy T, R, P verbatim from the gateway-route line.",
      "Do not add anything after that token.",
    ].join("\n"),
    "utf8"
  );

  proc = spawn("node", [GATEWAY], {
    env: {
      ...process.env,
      GARRISON_GATEWAY_PORT: String(port),
      GARRISON_GATEWAY_HOST: "127.0.0.1",
      GARRISON_COMPOSITION_DIR: tmp,
      GARRISON_SYSTEM_PROMPT_PATH: sysPrompt,
      GARRISON_PERMISSION_MODE: "bypassPermissions",
      GARRISON_MODEL: "sonnet",
      GARRISON_CLASSIFIER_MODEL: "haiku",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", (b) => process.stderr.write(`[gw] ${b}`));

  const ready = await waitReady(port, 90_000);
  if (!ready) {
    finish("inconclusive", "inconclusive", "gateway did not become ready (claude unavailable?)");
  } else {
    const decisionsFile = path.join(tmp, ".garrison", "decisions.jsonl");
    // Turn 1 → cc-sonnet-med
    const r1 = await chat(port, "fix the failing login unit test");
    const d1 = readDecisions(decisionsFile);
    const routeOk =
      r1.honored === true &&
      r1.route === "cc-sonnet-med" &&
      d1.some((d) => d.targetId === "cc-sonnet-med" && d.profile === "balanced");

    // Turn 2 → cc-haiku-low (trivial), drives the in-place switch
    const r2 = await chat(port, "quick: what is 2 plus 2");
    const d2 = readDecisions(decisionsFile);
    const switchOk =
      r2.route === "cc-haiku-low" &&
      r2.honored === true &&
      d2.some((d) => d.targetId === "cc-haiku-low");

    clearTimeout(timer);
    finish(
      routeOk ? "ok" : "inconclusive",
      switchOk ? "ok" : "inconclusive",
      `t1.route=${r1.route} honored=${r1.honored}; t2.route=${r2.route} honored=${r2.honored}; decisions=${d2.length}`
    );
  }
} catch (err) {
  clearTimeout(timer);
  finish("inconclusive", "inconclusive", `live error: ${err?.message}`);
}
