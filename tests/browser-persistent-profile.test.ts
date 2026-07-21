import path from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitExit } from "./helpers/wait-exit";

// Login continuity: the Browser fitting's shared context must keep its cookie
// jar across a fitting restart (prod redeploys on every landed commit, and an
// ephemeral /tmp profile forced a fresh app login each time). Pins:
//   1. persistent profile is the DEFAULT, lives under GARRISON_HOME, and is
//      reported on /health;
//   2. a cookie set in the shared context survives kill + respawn;
//   3. the composition-config projection (GARRISON_BROWSERDEFAULT_
//      PERSISTENT_PROFILE=false) opts out - previously a dead knob.

const REPO = path.resolve(__dirname, "..");
const START = path.join(REPO, "fittings", "seed", "browser-default", "scripts", "start.mjs");
const PORT = 7371;
const APP_PORT = 7372;
const BASE = `http://127.0.0.1:${PORT}`;
const APP_BASE = `http://127.0.0.1:${APP_PORT}`;
const GHOME = mkdtempSync(path.join(tmpdir(), "garrison-persist-"));

let srv: ChildProcess | null = null;
// Cookies need a real http origin (data: URLs have no cookie jar).
let app: Server | null = null;

function spawnBrowser(extraEnv: Record<string, string> = {}) {
  return spawn("node", [START, "--port", String(PORT), "--host", "127.0.0.1"], {
    stdio: "ignore",
    env: { ...process.env, GARRISON_HOME: GHOME, ...extraEnv }
  });
}

async function waitHealthy(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`${BASE}/health`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// Wait for the fitting PROCESS to exit, not just its listener to close: the
// server closes the listener as shutdown step one and only exits after the
// graceful chromium teardown, so an HTTP probe going dark proves nothing
// about the profile being released. A null exitCode+signalCode afterwards
// means waitExit hit its SIGKILL fallback - i.e. the shutdown hung.
async function waitGone(child: ChildProcess | null, ms = 25000) {
  await waitExit(child, ms);
  expect((child!.exitCode ?? child!.signalCode) !== null).toBe(true);
}

async function openTab(url: string): Promise<string> {
  const r = await (await fetch(`${BASE}/tabs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url })
  })).json();
  return r.id ?? r.tabId;
}

async function evalJs(tabId: string, js: string): Promise<unknown> {
  const r = await (await fetch(`${BASE}/tabs/${encodeURIComponent(tabId)}/eval`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ js })
  })).json();
  if (!r.ok) throw new Error(r.error || "eval failed");
  return r.value;
}

beforeAll(async () => {
  app = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>persist fixture</title><p>hello</p>");
  });
  await new Promise<void>((resolve) => app!.listen(APP_PORT, "127.0.0.1", resolve));
  srv = spawnBrowser();
  expect(await waitHealthy(20000)).toBe(true);
}, 30000);

afterAll(async () => {
  if (srv && !srv.killed) srv.kill("SIGTERM");
  await waitExit(srv);
  srv = null;
  await new Promise<void>((resolve) => (app ? app.close(() => resolve()) : resolve()));
  rmSync(GHOME, { recursive: true, force: true });
}, 15000);

describe("browser-default persistent profile", () => {
  it("defaults to a persistent profile under GARRISON_HOME and reports it on /health", async () => {
    const health = await (await fetch(`${BASE}/health`)).json();
    expect(health.persistentProfile).toBe(true);
    expect(health.profileDir).toBe(path.join(GHOME, "browser-profile"));
  });

  it("keeps a cookie across a fitting restart", async () => {
    const tab = await openTab(APP_BASE);
    await evalJs(tab, `document.cookie = "drill_session=alive; max-age=86400"; document.cookie`);
    expect(existsSync(path.join(GHOME, "browser-profile"))).toBe(true);

    // SIGTERM (the lifecycle stop signal) so chromium flushes the profile.
    // The server holds its exit for chromium's graceful close (up to 15s
    // under full-suite load) - the wait here must outlast that. Waiting for
    // the exit (not the port) also means the respawn can't race the old
    // chromium for the profile lock.
    srv!.kill("SIGTERM");
    await waitGone(srv);
    srv = spawnBrowser();
    expect(await waitHealthy(20000)).toBe(true);

    const tab2 = await openTab(APP_BASE);
    const cookie = await evalJs(tab2, "document.cookie");
    expect(String(cookie)).toContain("drill_session=alive");
  }, 90000);

  it("opts out via the projected composition-config env", async () => {
    srv!.kill("SIGTERM");
    await waitGone(srv);
    srv = spawnBrowser({ GARRISON_BROWSERDEFAULT_PERSISTENT_PROFILE: "false" });
    expect(await waitHealthy(20000)).toBe(true);
    const health = await (await fetch(`${BASE}/health`)).json();
    expect(health.persistentProfile).toBe(false);
    expect(health.profileDir).toBeNull();
  }, 60000);

  it("leaves no chromium behind holding the profile after shutdown", async () => {
    // The previous test's opt-out server still owns the port; replace it with
    // a persistent-profile one (a same-port spawn would EADDRINUSE-exit while
    // waitHealthy happily sees the old server).
    srv!.kill("SIGTERM");
    await waitGone(srv);
    srv = spawnBrowser();
    expect(await waitHealthy(20000)).toBe(true);
    // Warm the shared chromium so a real child exists to leak.
    await openTab(APP_BASE);

    // SIGTERM, then keep poking the tab endpoint through the shutdown window.
    // The shutting-down latch makes ensureChromium refuse to relaunch, so no
    // fresh chromium is spawned behind the departing process to be orphaned on
    // the profile. (A request served by the still-live browser before
    // Browser.close is fine - the invariant is the leak check below, not that
    // every request fails.)
    srv.kill("SIGTERM");
    const started = Date.now();
    while (Date.now() - started < 3000) {
      try {
        await fetch(`${BASE}/tabs`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: APP_BASE })
        });
      } catch { /* connection refused once the server closes - expected */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    await waitGone(srv);

    // No chromium process is left pointing at this test's profile dir. The
    // main chrome is dead before the server exits (shutdownChromium awaits
    // it), but its helper processes (zygote/gpu/renderer) die a beat later -
    // poll to empty; only what still lives after the grace window is a leak.
    const { execSync } = await import("node:child_process");
    const probe = () => {
      try {
        // [-]- so the regex matches chrome's cmdline but not this pgrep's own
        // /bin/sh wrapper (whose cmdline contains the pattern text verbatim).
        return execSync(
          `pgrep -af -- '[-]-user-data-dir=${path.join(GHOME, "browser-profile")}' || true`,
          { encoding: "utf8" }
        ).trim();
      } catch { return ""; /* pgrep absent - skip the assertion */ }
    };
    let leaked = probe();
    const grace = Date.now() + 10000;
    while (leaked && Date.now() < grace) {
      await new Promise((r) => setTimeout(r, 250));
      leaked = probe();
    }
    expect(leaked).toBe("");
  }, 60000);
});
