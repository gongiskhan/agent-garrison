import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeBrowserClient } from "../fittings/seed/automations/lib/browser-client.mjs";
import { waitExit } from "./helpers/wait-exit";

// F1 — the Browser Fitting's new observation endpoint: the fingerprint inputs
// (url/title/heading + DOM-shape counts + viewport) + a CDP a11y tree that the
// Automations orchestration layer keys its action cache on. Launches the real
// headless chromium the fitting drives.

const REPO = path.resolve(__dirname, "..");
const START = path.join(REPO, "fittings", "seed", "browser-default", "scripts", "start.mjs");
const PORT = 7186;
const BASE = `http://127.0.0.1:${PORT}`;
// Status file goes to the test sandbox, never the live ~/.garrison slot.
const GHOME = mkdtempSync(path.join(tmpdir(), "garrison-observe-"));

let srv: ChildProcess | null = null;
let fixtureSrv: Server | null = null;
let fixtureWs: WebSocketServer | null = null;
let fixtureBase = "";
const fixtureSockets = new Set<Socket>();

async function waitHealthy(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`${BASE}/health`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

beforeAll(async () => {
  fixtureSrv = createServer((req, res) => {
    const pathname = new URL(req.url || "/", "http://fixture.invalid").pathname;
    if (pathname === "/network-fixture") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(`<!doctype html><h1>Network fixture</h1><script>
        fetch('/ok?kind=completed');
        fetch('/bad');
        fetch('/hang');
        fetch('/redirect');
      </script>`);
    }
    if (pathname === "/timeout-fixture") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(`<!doctype html><h1>Waiting on API</h1><script>fetch('/hang')</script>`);
    }
    if (pathname === "/quiet-events") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(`<!doctype html><h1>Booting</h1><script>
        new EventSource('/events');
        setTimeout(() => {
          document.querySelector('h1').textContent = 'Hydrated';
          document.body.dataset.hydrated = 'true';
        }, 350);
      </script>`);
    }
    if (pathname === "/delayed-hydration") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(`<!doctype html><h1>Booting</h1><script>
        setTimeout(() => {
          document.querySelector('h1').textContent = 'Hydrated legacy';
          const button = document.createElement('button');
          button.textContent = 'Continue';
          document.body.appendChild(button);
        }, 300);
      </script>`);
    }
    if (pathname === "/overflow-fixture") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(`<!doctype html><title>loading</title><h1>Overflow</h1><script>
        Promise.all(Array.from({ length: 510 }, (_, index) => fetch('/fast?n=' + index)))
          .then(() => { document.title = 'done'; });
      </script>`);
    }
    if (pathname === "/overflow-hang-fixture") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(`<!doctype html><title>loading</title><h1>Overflow with pending</h1><script>
        fetch('/hang?kind=evicted-pending');
        Promise.all(Array.from({ length: 510 }, (_, index) => fetch('/fast?n=' + index)))
          .then(() => { document.title = 'done'; });
      </script>`);
    }
    if (pathname === "/capture-race") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(`<!doctype html><title>Capture race</title><h1>Before capture</h1><script>
        const originalQuerySelectorAll = Document.prototype.querySelectorAll;
        let captureMutationFired = false;
        Document.prototype.querySelectorAll = function(selector) {
          const result = originalQuerySelectorAll.call(this, selector);
          const probe = globalThis.__garrisonBrowserQuietProbeV1;
          if (selector === '*' && !captureMutationFired && probe && Date.now() - probe.lastMutationAt >= 500) {
            captureMutationFired = true;
            setTimeout(() => {
              document.querySelector('h1').textContent = 'After capture mutation';
              const button = document.createElement('button');
              button.textContent = 'Captured state';
              document.body.appendChild(button);
            }, 0);
          }
          return result;
        };
      </script>`);
    }
    if (pathname === "/stability-token" || pathname === "/stability-token-next") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(`<!doctype html><title>Stability token</title><h1>${pathname}</h1>`);
    }
    if (pathname === "/websocket-fixture") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(`<!doctype html><title>connecting</title><h1>WebSocket lifecycle</h1><script>
        window.testSocket = new WebSocket('ws://' + location.host + '/socket');
        window.testSocket.addEventListener('open', () => { document.title = 'open'; });
        window.testSocket.addEventListener('close', () => { document.title = 'closed'; });
      </script>`);
    }
    if (pathname === "/fast") {
      res.statusCode = 204;
      return res.end();
    }
    if (pathname === "/ok") {
      res.setHeader("content-type", "application/json");
      return setTimeout(() => { if (!res.destroyed) res.end('{"ok":true}'); }, 35);
    }
    if (pathname === "/bad") {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      return setTimeout(() => { if (!res.destroyed) res.end('{"error":"unavailable"}'); }, 45);
    }
    if (pathname === "/redirect") {
      res.statusCode = 302;
      res.setHeader("location", "/ok?kind=redirect-target");
      return res.end();
    }
    if (pathname === "/hang") {
      // Send the response headers and a partial body, then deliberately never
      // finish. This pins the important case where status===200 but the request
      // is still pending because loadingFinished has not fired.
      res.writeHead(200, { "content-type": "application/json" });
      return res.write('{"still":"loading"');
    }
    if (pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      return res.write("data: connected\n\n");
    }
    res.statusCode = 404;
    return res.end("not found");
  });
  fixtureWs = new WebSocketServer({ noServer: true });
  fixtureSrv.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url || "/", "http://fixture.invalid").pathname;
    if (pathname !== "/socket" || !fixtureWs) {
      socket.destroy();
      return;
    }
    fixtureWs.handleUpgrade(req, socket, head, (client) => fixtureWs?.emit("connection", client, req));
  });
  fixtureSrv.on("connection", (socket) => {
    fixtureSockets.add(socket);
    socket.on("close", () => fixtureSockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    fixtureSrv!.once("error", reject);
    fixtureSrv!.listen(0, "127.0.0.1", () => resolve());
  });
  const address = fixtureSrv.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind a TCP port");
  fixtureBase = `http://127.0.0.1:${address.port}`;

  srv = spawn("node", [START, "--port", String(PORT), "--host", "127.0.0.1"], {
    stdio: "ignore",
    env: { ...process.env, GARRISON_HOME: GHOME, GARRISON_BROWSER_PERSISTENT: "1" }
  });
  process.env.GARRISON_BROWSER_URL = BASE;
  await waitHealthy(15000);
}, 20000);

afterAll(async () => {
  if (srv && !srv.killed) srv.kill("SIGTERM");
  await waitExit(srv);
  srv = null;
  if (fixtureWs) {
    for (const client of fixtureWs.clients) client.terminate();
    await new Promise<void>((resolve) => fixtureWs!.close(() => resolve()));
    fixtureWs = null;
  }
  for (const socket of fixtureSockets) socket.destroy();
  await new Promise<void>((resolve) => {
    if (!fixtureSrv?.listening) return resolve();
    fixtureSrv.close(() => resolve());
  });
  fixtureSrv = null;
  delete process.env.GARRISON_BROWSER_URL;
  rmSync(GHOME, { recursive: true, force: true });
});

describe("browser fitting observation (F1)", () => {
  it("returns the fingerprint inputs + a11y for a page", async () => {
    const created = await (
      await fetch(`${BASE}/tabs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "data:text/html,<h1>Q3 Report</h1><button>Export</button><main></main>" })
      })
    ).json();
    const tabId = created.id || created.tabId;
    expect(tabId).toBeTruthy();

    // Poll until the navigation has committed - a fixed sleep flakes when
    // several Chromium boots run in parallel under the suite.
    let obs: any = null;
    for (let i = 0; i < 40; i++) {
      obs = await (await fetch(`${BASE}/tabs/${tabId}/observe?a11y=1`)).json();
      if (typeof obs?.url === "string" && obs.url.includes("Q3 Report")) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(obs.url).toContain("Q3 Report");
    expect(obs.headingText).toBe("Q3 Report");
    expect(obs.shapeSketch).toContain("button:1");
    expect(obs.shapeSketch).toContain("h1:1");
    expect(obs.viewport).toBeTruthy();
    expect(Array.isArray(obs.a11y)).toBe(true);
    expect(obs.a11y.length).toBeGreaterThan(0);
  }, 30000);

  it("collects legacy screenshot observations after same-URL hydration settles", async () => {
    const created = await (
      await fetch(`${BASE}/tabs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: `${fixtureBase}/delayed-hydration` })
      })
    ).json();
    const tabId = created.id || created.tabId;
    try {
      // No quiet=1: this pins compatibility callers. Before the coherence fix,
      // heading/a11y were captured as "Booting" and only then did screenshot
      // settling wait long enough to photograph "Hydrated legacy" + Continue.
      const obs = await (
        await fetch(`${BASE}/tabs/${tabId}/observe?a11y=1&screenshot=1`)
      ).json();
      expect(obs.url).toBe(`${fixtureBase}/delayed-hydration`);
      expect(obs.headingText).toBe("Hydrated legacy");
      expect(obs.a11y).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "button", name: "Continue" })
      ]));
      expect(obs.screenshotB64).toEqual(expect.any(String));
      expect(obs.quiet).toBeUndefined();
    } finally {
      await fetch(`${BASE}/tabs/${tabId}`, { method: "DELETE" });
    }
  }, 30000);

  it("captures completed, failed-status, hanging, and redirect network evidence", async () => {
    const created = await (
      await fetch(`${BASE}/tabs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: `${fixtureBase}/network-fixture` })
      })
    ).json();
    const tabId = created.id || created.tabId;
    try {
      let entries: any[] = [];
      for (let i = 0; i < 50; i++) {
        const body = await (await fetch(`${BASE}/tabs/${tabId}/network`)).json();
        entries = body.entries || [];
        const hanging = entries.find((entry) => new URL(entry.url).pathname === "/hang");
        const complete = entries.filter((entry) => entry.pending === false);
        const hasTerminal = (pathName: string, status: number, kind = "") => complete.some((entry) => {
          const entryUrl = new URL(entry.url);
          return entryUrl.pathname === pathName
            && entry.status === status
            && (!kind || entryUrl.searchParams.get("kind") === kind);
        });
        if (
          hanging?.status === 200
          && hasTerminal("/ok", 200, "completed")
          && hasTerminal("/bad", 503)
          && hasTerminal("/redirect", 302)
          && hasTerminal("/ok", 200, "redirect-target")
        ) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const byPathAndQuery = (pathName: string, query = "") => entries.find((entry) => {
        const entryUrl = new URL(entry.url);
        return entryUrl.pathname === pathName && (!query || entryUrl.searchParams.get("kind") === query);
      });
      const ok = byPathAndQuery("/ok", "completed");
      const bad = byPathAndQuery("/bad");
      const hanging = byPathAndQuery("/hang");
      const redirect = byPathAndQuery("/redirect");
      const redirectTarget = byPathAndQuery("/ok", "redirect-target");

      expect(ok).toMatchObject({ status: 200, pending: false, persistent: false });
      expect(ok.duration).toBeGreaterThanOrEqual(0);
      expect(ok.ageMs).toBeGreaterThanOrEqual(ok.duration);
      expect(bad).toMatchObject({ status: 503, pending: false, persistent: false });
      expect(bad.duration).toBeGreaterThanOrEqual(0);
      // Headers arrived, but the response body never finished: pending derives
      // from missing duration, not from missing HTTP status.
      expect(hanging).toMatchObject({ status: 200, pending: true, persistent: false });
      expect(hanging.duration).toBeUndefined();
      expect(hanging.ageMs).toBeGreaterThan(0);
      // The 302 hop and its final 200 share one CDP requestId. Both must be
      // terminal; the old implementation left the 302 object pending forever.
      expect(redirect).toMatchObject({ status: 302, pending: false });
      expect(redirect.duration).toBeGreaterThanOrEqual(0);
      expect(redirectTarget).toMatchObject({ status: 200, pending: false });
      expect(redirectTarget.requestId).toBe(redirect.requestId);
    } finally {
      await fetch(`${BASE}/tabs/${tabId}`, { method: "DELETE" });
    }
  }, 30000);

  it("reports source-history eviction separately from request-window filtering", async () => {
    const created = await (
      await fetch(`${BASE}/tabs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: `${fixtureBase}/overflow-fixture` })
      })
    ).json();
    const tabId = created.id || created.tabId;
    try {
      let network: any = null;
      for (let i = 0; i < 100; i++) {
        network = await (await fetch(`${BASE}/tabs/${tabId}/network`)).json();
        const info = await (await fetch(`${BASE}/tabs`)).json();
        const tab = (info.tabs ?? []).find((item: any) => (item.id || item.tabId) === tabId);
        if (
          network.historyDroppedCount > 0
          && tab?.title === "done"
          && network.entries.every((entry: any) => entry.pending === false)
        ) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(network.entries).toHaveLength(500);
      expect(network.historyTruncated).toBe(true);
      expect(network.historyDroppedCount).toBeGreaterThan(0);

      const future = Date.now() + 60_000;
      const freshWindow = await (
        await fetch(`${BASE}/tabs/${tabId}/network?since=${future}`)
      ).json();
      expect(freshWindow.entries).toEqual([]);
      expect(freshWindow.historyTruncated).toBe(false);
      expect(freshWindow.historyDroppedCount).toBe(network.historyDroppedCount);
    } finally {
      await fetch(`${BASE}/tabs/${tabId}`, { method: "DELETE" });
    }
  }, 30000);

  it("keeps an evicted hanging request in network evidence and quiet accounting", async () => {
    const created = await (
      await fetch(`${BASE}/tabs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: `${fixtureBase}/overflow-hang-fixture` })
      })
    ).json();
    const tabId = created.id || created.tabId;
    try {
      let network: any = null;
      for (let i = 0; i < 120; i++) {
        network = await (await fetch(`${BASE}/tabs/${tabId}/network`)).json();
        const info = await (await fetch(`${BASE}/tabs`)).json();
        const tab = (info.tabs ?? []).find((item: any) => (item.id || item.tabId) === tabId);
        if (network.historyDroppedCount > 0 && tab?.title === "done") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(network.historyTruncated).toBe(true);
      expect(network.historyDroppedCount).toBeGreaterThan(0);
      // The hanging request was deliberately first, so its history slot was
      // evicted. The active overlay must still expose actionable evidence once.
      const pending = network.entries.filter((entry: any) =>
        new URL(entry.url).searchParams.get("kind") === "evicted-pending"
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        method: "GET",
        pending: true,
        persistent: false,
        ageMs: expect.any(Number)
      });
      expect(new URL(pending[0].url).pathname).toBe("/hang");
      expect(pending[0].ageMs).toBeGreaterThan(0);

      const obs = await (
        await fetch(`${BASE}/tabs/${tabId}/observe?a11y=1&quiet=1`)
      ).json();
      expect(obs.quiet).toMatchObject({
        outcome: "budget-exhausted",
        networkQuiet: false,
        timedOut: true
      });
      expect(obs.quiet.pendingRequests).toBeGreaterThanOrEqual(1);
      expect(obs.stabilityToken).toBeUndefined();
    } finally {
      await fetch(`${BASE}/tabs/${tabId}`, { method: "DELETE" });
    }
  }, 30000);

  it("bounds quiet observation when an ordinary API response never finishes", async () => {
    const created = await (
      await fetch(`${BASE}/tabs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: `${fixtureBase}/timeout-fixture` })
      })
    ).json();
    const tabId = created.id || created.tabId;
    try {
      // Forward has no destination on a newly opened tab. A no-op history action
      // must not advance the navigation baseline past the already-active fetch.
      let hanging: any = null;
      for (let i = 0; i < 40; i++) {
        const network = await (await fetch(`${BASE}/tabs/${tabId}/network`)).json();
        hanging = network.entries.find((entry: any) => new URL(entry.url).pathname === "/hang");
        if (hanging?.pending && hanging?.status === 200) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(hanging).toMatchObject({ status: 200, pending: true });
      const forward = await fetch(`${BASE}/tabs/${tabId}/forward`, { method: "POST" });
      expect(forward.status).toBe(200);

      const startedAt = Date.now();
      const obs = await (
        await fetch(`${BASE}/tabs/${tabId}/observe?a11y=1&screenshot=1&quiet=1`)
      ).json();
      const elapsed = Date.now() - startedAt;
      expect(obs.headingText).toBe("Waiting on API");
      expect(obs.screenshotB64).toEqual(expect.any(String));
      expect(obs.screenshotB64.length).toBeGreaterThan(100);
      expect(obs.quiet).toMatchObject({
        outcome: "budget-exhausted",
        quietForMs: 600,
        readyState: "complete",
        networkQuiet: false,
        domStable: true,
        timedOut: true,
        budgetMs: 4000
      });
      expect(obs.quiet.pendingRequests).toBeGreaterThanOrEqual(1);
      expect(obs.quiet.waitedMs).toBeGreaterThanOrEqual(3900);
      expect(elapsed).toBeLessThan(5500);
      expect(obs.browserContext).toMatchObject({
        persistentProfile: true,
        tabAgeMs: expect.any(Number),
        navigationAgeMs: expect.any(Number)
      });
      expect(obs.browserContext.tabAgeMs).toBeGreaterThanOrEqual(obs.browserContext.navigationAgeMs);
      expect(JSON.stringify(obs.browserContext)).not.toContain(GHOME);
      expect(Object.keys(obs.browserContext).sort()).toEqual([
        "navigationAgeMs", "persistentProfile", "tabAgeMs"
      ]);
    } finally {
      await fetch(`${BASE}/tabs/${tabId}`, { method: "DELETE" });
    }
  }, 30000);

  it("waits through delayed hydration but ignores and reports EventSource as persistent", async () => {
    const created = await (
      await fetch(`${BASE}/tabs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: `${fixtureBase}/quiet-events` })
      })
    ).json();
    const tabId = created.id || created.tabId;
    try {
      // quiet=1 is useful independently of vision; assertion callers do not ask
      // for a screenshot, but still need the post-hydration DOM/a11y snapshot.
      const obs = await (
        await fetch(`${BASE}/tabs/${tabId}/observe?a11y=1&quiet=1`)
      ).json();
      expect(obs.headingText).toBe("Hydrated");
      expect(obs.screenshotB64).toBeUndefined();
      expect(obs.quiet).toMatchObject({
        outcome: "quiet",
        quietForMs: 600,
        readyState: "complete",
        networkQuiet: true,
        domStable: true,
        timedOut: false,
        budgetMs: 4000,
        pendingRequests: 0
      });
      expect(obs.quiet.waitedMs).toBeGreaterThanOrEqual(550);
      expect(obs.quiet.persistentRequests).toBeGreaterThanOrEqual(1);

      const network = await (await fetch(`${BASE}/tabs/${tabId}/network`)).json();
      const events = network.entries.find((entry: any) => new URL(entry.url).pathname === "/events");
      expect(events).toMatchObject({ status: 200, pending: true, persistent: true });
    } finally {
      await fetch(`${BASE}/tabs/${tabId}`, { method: "DELETE" });
    }
  }, 30000);

  it("revalidates quiet evidence after a same-URL mutation during capture", async () => {
    const created = await (
      await fetch(`${BASE}/tabs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: `${fixtureBase}/capture-race` })
      })
    ).json();
    const tabId = created.id || created.tabId;
    try {
      const obs = await (
        await fetch(`${BASE}/tabs/${tabId}/observe?a11y=1&screenshot=1&quiet=1`)
      ).json();
      expect(obs.url).toBe(`${fixtureBase}/capture-race`);
      expect(obs.headingText).toBe("After capture mutation");
      expect(obs.a11y).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "button", name: "Captured state" })
      ]));
      expect(obs.screenshotB64).toEqual(expect.any(String));
      expect(obs.quiet).toMatchObject({
        outcome: "quiet",
        networkQuiet: true,
        domStable: true,
        timedOut: false
      });
      // Initial settle + the capture-triggered mutation's fresh quiet window.
      expect(obs.quiet.waitedMs).toBeGreaterThanOrEqual(1000);
      expect(obs.stabilityToken).toMatch(/^stability-v1-[a-f0-9]{32}$/);
    } finally {
      await fetch(`${BASE}/tabs/${tabId}`, { method: "DELETE" });
    }
  }, 30000);

  it("returns an opaque stability token that tracks DOM, network, and navigation generations", async () => {
    const created = await (
      await fetch(`${BASE}/tabs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: `${fixtureBase}/stability-token` })
      })
    ).json();
    const tabId = created.id || created.tabId;
    const observeQuiet = async () => (
      await fetch(`${BASE}/tabs/${tabId}/observe?a11y=1&quiet=1`)
    ).json();
    const evaluate = async (js: string) => fetch(`${BASE}/tabs/${tabId}/eval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ js })
    });
    try {
      const first = await observeQuiet();
      const unchanged = await observeQuiet();
      expect(first.quiet.outcome).toBe("quiet");
      expect(first.stabilityToken).toMatch(/^stability-v1-[a-f0-9]{32}$/);
      expect(unchanged.stabilityToken).toBe(first.stabilityToken);
      expect(first.stabilityToken).not.toContain(fixtureBase);

      expect((await evaluate("document.body.dataset.changed = 'yes'; true")).status).toBe(200);
      const afterDom = await observeQuiet();
      expect(afterDom.stabilityToken).not.toBe(unchanged.stabilityToken);

      expect((await evaluate("fetch('/ok?kind=stability-token'); true")).status).toBe(200);
      const afterNetwork = await observeQuiet();
      expect(afterNetwork.stabilityToken).not.toBe(afterDom.stabilityToken);

      const navigated = await fetch(`${BASE}/tabs/${tabId}/nav`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: `${fixtureBase}/stability-token-next` })
      });
      expect(navigated.status).toBe(200);
      const afterNavigation = await observeQuiet();
      expect(afterNavigation.url).toBe(`${fixtureBase}/stability-token-next`);
      expect(afterNavigation.stabilityToken).not.toBe(afterNetwork.stabilityToken);
    } finally {
      await fetch(`${BASE}/tabs/${tabId}`, { method: "DELETE" });
    }
  }, 30000);

  it("reports WebSocket persistence only while the socket is open", async () => {
    const created = await (
      await fetch(`${BASE}/tabs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: `${fixtureBase}/websocket-fixture` })
      })
    ).json();
    const tabId = created.id || created.tabId;
    try {
      let socketEntry: any = null;
      for (let i = 0; i < 60; i++) {
        const network = await (await fetch(`${BASE}/tabs/${tabId}/network`)).json();
        socketEntry = network.entries.find((entry: any) => entry.resourceType === "WebSocket");
        if (socketEntry?.pending && socketEntry?.persistent && socketEntry?.status === 101) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(socketEntry).toMatchObject({
        resourceType: "WebSocket",
        status: 101,
        pending: true,
        persistent: true
      });

      const closed = await fetch(`${BASE}/tabs/${tabId}/eval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ js: "window.testSocket.close(); true" })
      });
      expect(closed.status).toBe(200);

      for (let i = 0; i < 60; i++) {
        const network = await (await fetch(`${BASE}/tabs/${tabId}/network`)).json();
        socketEntry = network.entries.find((entry: any) => entry.resourceType === "WebSocket");
        if (socketEntry && socketEntry.pending === false) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(socketEntry).toMatchObject({
        resourceType: "WebSocket",
        pending: false,
        persistent: false
      });
      expect(socketEntry.duration).toBeGreaterThanOrEqual(0);
    } finally {
      await fetch(`${BASE}/tabs/${tabId}`, { method: "DELETE" });
    }
  }, 30000);

  it("executes a resolved action via the locator ladder", async () => {
    const created = await (
      await fetch(`${BASE}/tabs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "data:text/html,<button onclick=\"document.title='clicked'\">Go</button>" })
      })
    ).json();
    const tabId = created.id || created.tabId;
    // Poll until the button is rendered - a fixed sleep flakes under suite load.
    for (let i = 0; i < 40; i++) {
      const o = await (await fetch(`${BASE}/tabs/${tabId}/observe`)).json();
      if (typeof o?.shapeSketch === "string" && o.shapeSketch.includes("button:1")) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    const exec = await (
      await fetch(`${BASE}/tabs/${tabId}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: { kind: "click", text: "Go" } })
      })
    ).json();
    expect(exec.ok, JSON.stringify(exec)).toBe(true);

    let obs: any = null;
    for (let i = 0; i < 40; i++) {
      obs = await (await fetch(`${BASE}/tabs/${tabId}/observe`)).json();
      if (obs?.title === "clicked") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(obs.title).toBe("clicked");
  }, 30000);

  it("blocks navigation to a non-web scheme (no file: pivot)", async () => {
    const res = await fetch(`${BASE}/tabs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "file:///etc/passwd" })
    });
    expect(res.status).toBe(400);
  });

  it("rejects a cross-origin request (CSRF guard)", async () => {
    const res = await fetch(`${BASE}/tabs`, { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    // a loopback origin (the same-origin canvas) is allowed
    const ok = await fetch(`${BASE}/health`, { headers: { origin: `http://127.0.0.1:${PORT}` } });
    expect(ok.status).toBe(200);
  });

  // F2 live wiring — the Automations browser-client drives this real fitting
  // (the integration the cache->vision->execute orchestrator uses).
  it("automations browser-client navigates, observes, and executes (F2 live)", async () => {
    const client = makeBrowserClient();
    await client.navigate("data:text/html,<h1>Report</h1><button onclick=\"document.title='sent'\">Send</button>");
    // Poll until rendered - a fixed sleep flakes under suite load.
    let obs: any = null;
    for (let i = 0; i < 40; i++) {
      obs = await client.observe();
      if (obs?.headingText === "Report") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(obs.headingText).toBe("Report");
    expect(obs.shapeSketch).toContain("button:1");
    await client.execute({ kind: "click", text: "Send" });
    let after: any = null;
    for (let i = 0; i < 40; i++) {
      after = await client.observe();
      if (after?.title === "sent") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(after.title).toBe("sent");
  }, 30000);
});
