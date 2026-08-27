// Remote-shell terminal E2E — the browser half of the DoD: the session starts
// from the UI, the xterm pane attaches, KEYS TYPED IN THE BROWSER reach the
// remote tmux session, and the remote's output bytes stream back over the /io
// WebSocket. Uses the REAL fitting server with an ssh-to-localhost transport
// (the CSG shape with this box standing in for the VM); skips when the box
// cannot ssh to itself with the dedicated key.
//
// Run:  npx playwright test -c fittings/seed/remote-shell-runtime/ui/__tests__/terminal.pw.config.ts

import { test, expect } from "@playwright/test";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const KEY = path.join(os.homedir(), ".ssh", "garrison-remote-shell");
const sshSelfOk = (() => {
  const r = spawnSync("ssh", [
    "-i", KEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=3",
    "-o", "StrictHostKeyChecking=accept-new",
    `${os.userInfo().username}@127.0.0.1`, "true"
  ], { timeout: 8000 });
  return r.status === 0 && spawnSync("tmux", ["-V"], { timeout: 3000 }).status === 0;
})();

const TMUX_NAME = `rshpw_${process.pid}`;
let tmpHome: string;
let server: { close(): void } | null = null;
let baseUrl = "";

test.skip(!sshSelfOk, "requires sshd + the garrison-remote-shell key on this box");

test.beforeAll(async () => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), "rsh-pw-"));
  const eventsFile = path.join(tmpHome, "events.jsonl");
  writeFileSync(eventsFile, "");
  const port = 18000 + Math.floor(Math.random() * 2000);
  process.env.GARRISON_HOME = tmpHome;
  process.env.GARRISON_REMOTESHELLRUNTIME_PORT = String(port);
  process.env.GARRISON_REMOTESHELLRUNTIME_TRANSPORTS = JSON.stringify({
    pwtest: {
      ssh: { host: "127.0.0.1", port: 22, user: os.userInfo().username, identity: KEY },
      tmuxSession: TMUX_NAME,
      cwd: tmpHome,
      eventsFile,
      label: "PW test shell"
    }
  });
  // Build the UI once so dist/ exists, then boot the real server.
  execFileSync("node", [path.resolve(__dirname, "..", "build.mjs")], { stdio: "ignore" });
  const mod = await import(path.resolve(__dirname, "..", "..", "scripts", "server.mjs"));
  server = await mod.startServer();
  baseUrl = `http://127.0.0.1:${port}`;
});

test.afterAll(() => {
  try { server?.close(); } catch {}
  spawnSync("tmux", ["kill-session", "-t", TMUX_NAME], { timeout: 5000 });
  rmSync(tmpHome, { recursive: true, force: true });
});

test("start from UI, type in xterm, output streams back", async ({ page }) => {
  await page.goto(baseUrl);

  // The configured transport renders as a one-tap entry.
  const start = page.getByRole("button", { name: "Start / attach" });
  await expect(start).toBeVisible();
  await start.click();

  // Session appears in the rail and the xterm pane mounts + attaches.
  await expect(page.locator(".session")).toHaveCount(1);
  const pane = page.locator('[data-testid="terminal-pane"] .xterm');
  await expect(pane).toBeVisible({ timeout: 15_000 });

  // Two-way check, browser side: keys typed into the xterm must reach the
  // remote tmux pane. Focus the terminal and type a marker command.
  await page.locator('[data-testid="terminal-pane"]').click();
  const marker = `pw-round-trip-${Date.now()}`;
  await page.keyboard.type(`echo ${marker}`, { delay: 15 });
  await page.keyboard.press("Enter");

  // Server-side truth: the tmux pane executed it (echoed command + output).
  await expect
    .poll(async () => {
      const sessions = await (await fetch(`${baseUrl}/sessions`)).json();
      const id = sessions.sessions[0]?.id;
      if (!id) return "";
      const screen = await (await fetch(`${baseUrl}/sessions/${id}/screen?lines=30`)).json();
      return screen.text ?? "";
    }, { timeout: 15_000 })
    .toContain(marker);

  // Browser side: the output BYTES stream back over /io (fresh socket replays
  // the buffer, which now carries the marker's output).
  const sessions = await (await fetch(`${baseUrl}/sessions`)).json();
  const sessionId = sessions.sessions[0].id as string;
  const sawOutput = await page.evaluate(async ({ sessionId: sid }) => {
    return await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://${location.host}/io`);
      ws.binaryType = "arraybuffer";
      let acc = "";
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ type: "init", sessionId: sid, cols: 120, rows: 30 }));
      });
      ws.addEventListener("message", (ev) => {
        if (typeof ev.data === "string") { if (!ev.data.startsWith("{")) acc += ev.data; return; }
        acc += new TextDecoder().decode(new Uint8Array(ev.data as ArrayBuffer));
      });
      setTimeout(() => { try { ws.close(); } catch {} resolve(acc); }, 2500);
    });
  }, { sessionId });
  expect(sawOutput).toContain(marker);
});
