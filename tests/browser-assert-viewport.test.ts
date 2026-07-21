import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitExit } from "./helpers/wait-exit";

// Automations engine deltas 5 (richer deterministic assertions) and 3
// (viewport emulation) — the Browser Fitting side. Launches the real headless
// chromium the fitting drives, same convention as browser-observe.test.ts.

const REPO = path.resolve(__dirname, "..");
const START = path.join(REPO, "fittings", "seed", "browser-default", "scripts", "start.mjs");
const PORT = 7187;
const BASE = `http://127.0.0.1:${PORT}`;
const GHOME = mkdtempSync(path.join(tmpdir(), "garrison-assert-"));

let srv: ChildProcess | null = null;

async function waitHealthy(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`${BASE}/health`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function openTab(url: string) {
  const created = await (
    await fetch(`${BASE}/tabs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url })
    })
  ).json();
  return created.id || created.tabId;
}

async function waitFor(tabId: string, predicate: (obs: any) => boolean) {
  let obs: any = null;
  for (let i = 0; i < 40; i++) {
    obs = await (await fetch(`${BASE}/tabs/${tabId}/observe`)).json();
    if (predicate(obs)) return obs;
    await new Promise((r) => setTimeout(r, 250));
  }
  return obs;
}

beforeAll(async () => {
  srv = spawn("node", [START, "--port", String(PORT), "--host", "127.0.0.1"], {
    stdio: "ignore",
    env: { ...process.env, GARRISON_HOME: GHOME }
  });
  await waitHealthy(15000);
}, 20000);

afterAll(async () => {
  if (srv && !srv.killed) srv.kill("SIGTERM");
  await waitExit(srv);
  srv = null;
  rmSync(GHOME, { recursive: true, force: true });
});

describe("richer deterministic assertions (delta 5)", () => {
  it("count: passes/fails by element count with an op+value", async () => {
    const tabId = await openTab("data:text/html,<ul><li>a</li><li>b</li><li>c</li></ul>");
    await waitFor(tabId, (o) => o?.shapeSketch?.includes("li:3"));
    const pass = await (await fetch(`${BASE}/tabs/${tabId}/assert`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ assertion: { kind: "count", selector: "li", op: "eq", value: 3 } })
    })).json();
    expect(pass).toMatchObject({ ok: true, passed: true, actual: 3 });
    const fail = await (await fetch(`${BASE}/tabs/${tabId}/assert`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ assertion: { kind: "count", selector: "li", op: "gte", value: 10 } })
    })).json();
    expect(fail).toMatchObject({ ok: true, passed: false });
  });

  it("visible: true for a shown element, false for display:none", async () => {
    const tabId = await openTab("data:text/html,<div data-testid=\"shown\">hi</div><div data-testid=\"hidden\" style=\"display:none\">bye</div>");
    await waitFor(tabId, (o) => o?.shapeSketch);
    const shown = await (await fetch(`${BASE}/tabs/${tabId}/assert`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ assertion: { kind: "visible", testId: "shown" } })
    })).json();
    expect(shown.passed).toBe(true);
    const hidden = await (await fetch(`${BASE}/tabs/${tabId}/assert`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ assertion: { kind: "visible", testId: "hidden" } })
    })).json();
    expect(hidden.passed).toBe(false);
  });

  it("attribute-equals: matches an element's attribute value", async () => {
    const tabId = await openTab("data:text/html,<a data-testid=\"lnk\" href=\"/kb/entry-1\">go</a>");
    await waitFor(tabId, (o) => o?.shapeSketch);
    const r = await (await fetch(`${BASE}/tabs/${tabId}/assert`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ assertion: { kind: "attribute-equals", testId: "lnk", attribute: "href", value: "/kb/entry-1" } })
    })).json();
    expect(r).toMatchObject({ ok: true, passed: true, actual: "/kb/entry-1" });
  });

  it("rejects an unsupported kind", async () => {
    const tabId = await openTab("data:text/html,<div></div>");
    await waitFor(tabId, (o) => o?.shapeSketch !== undefined);
    const r = await fetch(`${BASE}/tabs/${tabId}/assert`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ assertion: { kind: "text-contains", text: "x" } })
    });
    expect(r.status).toBe(400);
  });
});

describe("viewport emulation (delta 3)", () => {
  it("applies a viewport at tab-creation time", async () => {
    const created = await (
      await fetch(`${BASE}/tabs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "data:text/html,<div>x</div>", viewport: { width: 390, height: 844 } })
      })
    ).json();
    const tabId = created.id || created.tabId;
    const obs = await waitFor(tabId, (o) => o?.viewport?.w > 0);
    expect(obs.viewport).toMatchObject({ w: 390, h: 844 });
  });

  it("POST /tabs/:id/viewport re-emulates an already-open tab", async () => {
    const tabId = await openTab("data:text/html,<div>x</div>");
    const r = await fetch(`${BASE}/tabs/${tabId}/viewport`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ width: 1024, height: 768 })
    });
    expect((await r.json()).ok).toBe(true);
    const obs = await waitFor(tabId, (o) => o?.viewport?.w === 1024);
    expect(obs.viewport).toMatchObject({ w: 1024, h: 768 });
  });

  it("rejects a viewport with no numeric width/height", async () => {
    const tabId = await openTab("data:text/html,<div>x</div>");
    const r = await fetch(`${BASE}/tabs/${tabId}/viewport`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(r.status).toBe(400);
  });
});
