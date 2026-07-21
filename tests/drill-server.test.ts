import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Drill fitting skeleton (Phase 2): own-port server + Drill Book/page CRUD
// REST API, writing into a target app repo (R6), not ~/.garrison.

const REPO = path.resolve(__dirname, "..");
const START = path.join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");
const PORT = 7221; // unique across the suite — 7199 is z1-end-to-end.test.ts's BROWSER_PORT
const BASE = `http://127.0.0.1:${PORT}`;

let ghome: string;
let target: string;
let srv: ChildProcess | null = null;

async function waitHealthy(timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

beforeEach(async () => {
  ghome = mkdtempSync(path.join(tmpdir(), "garrison-drill-home-"));
  target = mkdtempSync(path.join(tmpdir(), "garrison-drill-target-"));
  srv = spawn("node", [START], {
    stdio: "ignore",
    env: { ...process.env, GARRISON_HOME: ghome, GARRISON_DRILL_TARGET_REPO: target, DRILL_UI_PORT: String(PORT), DRILL_UI_HOST: "127.0.0.1" }
  });
  const ok = await waitHealthy(8000);
  expect(ok).toBe(true);
});

afterEach(() => {
  if (srv && !srv.killed) srv.kill("SIGKILL");
  srv = null;
  rmSync(ghome, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

describe("Drill own-port server", () => {
  it("health reports the target repo and writes a status file", async () => {
    const health = await (await fetch(`${BASE}/health`)).json();
    expect(health).toMatchObject({ status: "ok", fittingId: "drill", targetRepo: target });
    const status = JSON.parse(readFileSync(path.join(ghome, "ui-fittings", "drill.json"), "utf8"));
    expect(status).toMatchObject({ fittingId: "drill", port: PORT });
  });

  it("drillbook: GET returns defaults, PATCH merges and persists", async () => {
    const before = await (await fetch(`${BASE}/api/drillbook`)).json();
    expect(before.book).toMatchObject({ fullDrill: false, autonomy: "gated" });
    const after = await (
      await fetch(`${BASE}/api/drillbook`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ app: { name: "ekoa", url: "http://localhost:3000" } })
      })
    ).json();
    expect(after.book).toMatchObject({ app: { name: "ekoa", url: "http://localhost:3000" } });
    const reGet = await (await fetch(`${BASE}/api/drillbook`)).json();
    expect(reGet.book).toEqual(after.book);
  });

  it("pages: PUT creates, GET reads, DELETE removes, all rooted in the target repo", async () => {
    const put = await (
      await fetch(`${BASE}/api/pages/chat`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Chat", path: "/chat" })
      })
    ).json();
    expect(put.page).toMatchObject({ id: "chat", title: "Chat", path: "/chat" });

    const list = await (await fetch(`${BASE}/api/pages`)).json();
    expect(list.pages.map((p: any) => p.id)).toEqual(["chat"]);

    const { existsSync } = await import("node:fs");
    expect(existsSync(path.join(target, "drills", "pages", "chat.yml"))).toBe(true);

    const del = await (await fetch(`${BASE}/api/pages/chat`, { method: "DELETE" })).json();
    expect(del.deleted).toBe(true);
    const after = await fetch(`${BASE}/api/pages/chat`);
    expect(after.status).toBe(404);
  });

  it("serves the SPA index for an unknown non-api route", async () => {
    const r = await fetch(`${BASE}/authoring`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("<title>Drill</title>");
  });

  it("rejects a cross-origin request (CSRF guard)", async () => {
    const res = await fetch(`${BASE}/api/drillbook`, { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    const ok = await fetch(`${BASE}/health`, { headers: { origin: `http://127.0.0.1:${PORT}` } });
    expect(ok.status).toBe(200);
  });
});
