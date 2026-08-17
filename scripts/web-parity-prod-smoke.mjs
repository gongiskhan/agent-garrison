#!/usr/bin/env node
// Post-deploy smoke for the Web Channel session-parity work, run against the
// DEPLOYED prod instance rather than a checkout. Two checks, both on the path a
// real user takes:
//
//   1. A live turn over the TAILNET HTTPS origin at iPhone size — proves the
//      deployed bundle streams a reply, records it durably with a `completed`
//      terminal (the post-terminal-chunk regression), and that the composer is
//      reachable at 390x844 (the push-notice defect).
//   2. A live tool call whose permission prompt is answered in the UI — proves
//      the Agent SDK canUseTool bridge end to end on the deployed gateway.
//
// Usage: node scripts/web-parity-prod-smoke.mjs [--origin https://host:port]
//        Defaults to the tailnet URL published for the web-channel port.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "evidence", "web-parity-prod-smoke");
const args = process.argv.slice(2);
const ORIGIN = args.includes("--origin") ? args[args.indexOf("--origin") + 1] : "https://dev-madrid.tail31efa.ts.net:8483";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

fs.mkdirSync(OUT, { recursive: true });

const api = (thePath, init) => fetch(`${ORIGIN}${thePath}`, init).then((r) => r.json());

async function settled(threadId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const thread = await api(`/api/threads/${encodeURIComponent(threadId)}`);
    const pending = thread?.pendingInputs ?? thread?.thread?.pendingInputs ?? [];
    if (pending.length === 0 && (thread?.thread?.messages ?? []).length > 0) return thread;
    await sleep(1_000);
  }
  throw new Error("turn did not settle");
}

const { chromium } = await import("playwright");
const report = { origin: ORIGIN, checks: {} };

const created = await api("/api/threads", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ title: "prod smoke", source: "web-parity-prod-smoke" }),
});
const threadId = created.thread.id;
// Same Opus 5 Agent SDK target the parity work validated, kept a conversation so
// the router answers here instead of registering a board run.
await api(`/api/threads/${encodeURIComponent(threadId)}/routing`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ routing: { target: "fable", duty: "discuss", level: 1 } }),
});
console.log(`[prod-smoke] ${ORIGIN} thread ${threadId}`);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 200)); });
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) })
  .then(() => console.log(`[evidence] evidence/web-parity-prod-smoke/${name}.png`));

try {
  await page.goto(`${ORIGIN}/?thread=${encodeURIComponent(threadId)}`, { waitUntil: "domcontentloaded" });
  await page.locator(".cc-input").waitFor({ state: "visible", timeout: 30_000 });

  // 1. The composer must be the thing under the composer, at phone size, over HTTPS.
  const hittable = await page.evaluate(() => {
    const at = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return "missing";
      const box = el.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return el.contains(top) || top === el ? "self" : (top?.className || top?.tagName || "unknown");
    };
    return { send: at(".cc-send"), input: at(".cc-input"), notice: Boolean(document.querySelector(".wc-push-notice")) };
  });
  await shot("1-idle-phone");

  await page.locator(".cc-input").fill("Reply with exactly: parity smoke ok");
  await page.locator(".cc-send").click();
  await sleep(3_000);
  await shot("2-streaming");
  const afterOne = await settled(threadId, 300_000);
  await shot("3-answered");
  const terminals = (afterOne.thread.sessionEvents ?? [])
    .filter((event) => event.id.startsWith("terminal:"))
    .map((event) => (event.blocks.find((block) => block.type === "turn_end") ?? {}).status);
  const reply = (afterOne.thread.messages.filter((m) => m.role === "assistant").pop() ?? {}).text ?? "";
  report.checks.streamedTurn = {
    hittable,
    terminals,
    replyPersisted: reply.trim().length > 0,
    reply: reply.slice(0, 160),
  };

  // 2. A permission-gated tool call, answered in the UI.
  await page.locator(".cc-input").fill("Run `cksum /etc/hostname` in the shell and tell me the number it prints.");
  await page.locator(".cc-send").click();
  let answered = 0;
  const deadline = Date.now() + 420_000;
  while (Date.now() < deadline) {
    const pending = page.locator(".cc-session-permission.is-pending");
    if (await pending.count()) {
      if (answered === 0) await shot("4-permission-prompt");
      const allow = pending.first().getByRole("button", { name: "Allow once" });
      if (await allow.count()) { await allow.click().catch(() => {}); answered += 1; }
    }
    const thread = await api(`/api/threads/${encodeURIComponent(threadId)}`);
    if ((thread?.pendingInputs ?? thread?.thread?.pendingInputs ?? []).length === 0) break;
    await sleep(1_500);
  }
  const afterTwo = await settled(threadId, 120_000);
  await shot("5-tool-result");
  report.checks.permissionTurn = {
    permissionsAnswered: answered,
    toolCards: await page.locator("details.cc-session-tool").count(),
    terminals: (afterTwo.thread.sessionEvents ?? [])
      .filter((event) => event.id.startsWith("terminal:"))
      .map((event) => (event.blocks.find((block) => block.type === "turn_end") ?? {}).status),
    reply: ((afterTwo.thread.messages.filter((m) => m.role === "assistant").pop() ?? {}).text ?? "").slice(0, 200),
  };
  report.consoleErrors = consoleErrors.slice(0, 10);
  report.threadId = threadId;
} finally {
  await context.close();
  await browser.close();
}

fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
