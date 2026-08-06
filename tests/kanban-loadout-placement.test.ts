import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// @ts-ignore — fitting server is plain ESM
import { makeRequestHandler, projectLoadoutPrefill } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore — source ESM board helpers.
import { saveBoard } from "../fittings/seed/kanban-loop/lib/board.mjs";

const roots: string[] = [];
const servers: http.Server[] = [];

function fixtureRepo() {
  const devRoot = mkdtempSync(path.join(tmpdir(), "kanban-loadout-dev-"));
  roots.push(devRoot);
  const repo = path.join(devRoot, "actual-project");
  mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "ssh://git.example/owner/actual-project.git"]);
  execFileSync("git", ["-C", repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);
  return { devRoot, repo };
}

function writeExecutionModel(root: string) {
  writeFileSync(path.join(root, "model.json"), JSON.stringify({
    version: 2,
    compositionId: "fixture",
    kanbanLists: ["code", "other"],
    selectedDuties: ["code", "other"],
    duties: {
      code: { id: "code", levels: [{ cell: { target: "agent-code" } }] },
      other: { id: "other", levels: [{ cell: { target: "codex-other" } }] }
    },
    sequences: { code: { "1": ["code"] }, other: { "1": ["other"] } },
    steps: {
      code: { "1": [{ duty: "code", targetId: "agent-code", runtime: "agent-sdk", provider: "anthropic", model: "claude-haiku-4-5", effort: "low", params: {} }] },
      other: { "1": [{ duty: "other", targetId: "codex-other", runtime: "codex", provider: "openai", model: "gpt-5.6-sol", effort: "medium", params: {} }] }
    },
    holds: {},
    gates: {}
  }));
}

async function listen(server: http.Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Kanban pre-placement Loadout surface", () => {
  it("prefills only repository facts and never guesses commands or secret names", () => {
    const { devRoot } = fixtureRepo();
    expect(projectLoadoutPrefill("actual-project", { devRoot })).toEqual({
      id: "actual-project",
      repo_remote: "ssh://git.example/owner/actual-project.git",
      default_branch: "trunk",
      setup_commands: [],
      env_vars: [],
      verify_command: ""
    });
    expect(projectLoadoutPrefill("../escape", { devRoot })).toBeNull();
  });

  it("blocks a missing descriptor and exposes the conservative editor seed", async () => {
    const { devRoot } = fixtureRepo();
    const appUrl = await listen(http.createServer((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }));
    const root = mkdtempSync(path.join(tmpdir(), "kanban-loadout-board-"));
    roots.push(root);
    writeExecutionModel(root);
    const boardUrl = await listen(http.createServer(makeRequestHandler({ root, cwd: root, devRoot, appUrl, gatewayUrl: null, cap: 10 }, root)));

    const response = await fetch(`${boardUrl}/loadouts/actual-project`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      project: "actual-project",
      ready: false,
      status: "missing",
      editor: {
        repo_remote: "ssh://git.example/owner/actual-project.git",
        default_branch: "trunk",
        setup_commands: [],
        env_vars: [],
        verify_command: ""
      }
    });
  });

  it("reports missing vault names, then ready, without returning values", async () => {
    const { devRoot } = fixtureRepo();
    let missing = ["API_TOKEN"];
    const loadout = {
      id: "actual-project",
      repo_remote: "ssh://git.example/owner/actual-project.git",
      default_branch: "trunk",
      setup_commands: ["npm ci"],
      env_vars: ["API_TOKEN"],
      verify_command: "npm test"
    };
    const appUrl = await listen(http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        loadout,
        resolved: [{ name: "API_TOKEN", source: missing.length ? null : "API_TOKEN", found: !missing.length }],
        missing
      }));
    }));
    const root = mkdtempSync(path.join(tmpdir(), "kanban-loadout-board-"));
    roots.push(root);
    const boardUrl = await listen(http.createServer(makeRequestHandler({ root, cwd: root, devRoot, appUrl, gatewayUrl: null, cap: 10 }, root)));

    let body = await (await fetch(`${boardUrl}/loadouts/actual-project`)).json();
    expect(body).toMatchObject({ ready: false, status: "missing-vault-values", missing: ["API_TOKEN"] });
    expect(JSON.stringify(body)).not.toContain("secret-value");

    missing = [];
    body = await (await fetch(`${boardUrl}/loadouts/actual-project`)).json();
    expect(body).toMatchObject({ ready: true, status: "ready", missing: [] });
  });

  it("pins the selected project id when proxying an authored Loadout", async () => {
    const { devRoot } = fixtureRepo();
    let received: any = null;
    const appUrl = await listen(http.createServer((req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        received = JSON.parse(raw);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ loadout: received }));
      });
    }));
    const root = mkdtempSync(path.join(tmpdir(), "kanban-loadout-board-"));
    roots.push(root);
    const boardUrl = await listen(http.createServer(makeRequestHandler({ root, cwd: root, devRoot, appUrl, gatewayUrl: null, cap: 10 }, root)));

    const response = await fetch(`${boardUrl}/loadouts/actual-project`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "attacker-chosen-id",
        repo_remote: "ssh://git.example/owner/actual-project.git",
        default_branch: "trunk",
        setup_commands: [],
        env_vars: [],
        verify_command: "npm test"
      })
    });
    expect(response.status).toBe(200);
    expect(received.id).toBe("actual-project");
    expect(received.env_vars).toEqual([]);
  });

  it("enforces worker and Loadout readiness on create and placement PATCH", async () => {
    const { devRoot } = fixtureRepo();
    let workerReady = true;
    let loadoutReady = true;
    let workerRuntimes = ["agent-sdk:anthropic"];
    const appUrl = await listen(http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/dispatch/machines") {
        res.end(JSON.stringify({ machines: [{
          name: "studio",
          worker: {
            state: workerReady ? "ready" : "degraded",
            ready: workerReady,
            stale: false,
            runtimes: workerRuntimes,
            detail: workerReady ? "ready" : "Sign in to Claude on this Mac"
          }
        }] }));
        return;
      }
      if (req.url?.startsWith("/api/loadouts/actual-project")) {
        if (!loadoutReady) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
        res.end(JSON.stringify({
          loadout: { id: "actual-project", repo_remote: "ssh://git.example/owner/actual-project.git", default_branch: "trunk", setup_commands: [], env_vars: [], verify_command: "npm test" },
          missing: []
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }));
    const root = mkdtempSync(path.join(tmpdir(), "kanban-loadout-board-"));
    roots.push(root);
    writeExecutionModel(root);
    await saveBoard({
      version: 3,
      lists: [
        { id: "backlog", title: "Backlog", order: 0, kind: "manual", trigger: "manual", validNext: ["plan"] },
        { id: "needs-attention", title: "Needs attention", order: 1, kind: "manual", trigger: "manual", validNext: ["backlog"] }
      ]
    }, root);
    const boardUrl = await listen(http.createServer(makeRequestHandler({ root, cwd: root, devRoot, appUrl, gatewayUrl: null, cap: 10 }, root)));

    let response = await fetch(`${boardUrl}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "remote ready", project: "actual-project", scope: "project", placement: { target: "studio" } })
    });
    expect(response.status).toBe(201);
    expect((await response.json()).card.placement).toEqual({ target: "studio" });

    workerReady = false;
    response = await fetch(`${boardUrl}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "remote blocked", project: "actual-project", scope: "project", placement: { target: "studio" } })
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "worker-not-ready", message: "Sign in to Claude on this Mac" });

    workerReady = true;
    workerRuntimes = ["codex:openai"];
    response = await fetch(`${boardUrl}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "runtime blocked", project: "actual-project", scope: "project", placement: { target: "studio" } })
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "worker-runtime-unsupported" });

    // An explicit resolved duty uses its actual phase cell, not the supported
    // default code cell.
    workerRuntimes = ["agent-sdk:anthropic"];
    response = await fetch(`${boardUrl}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "actual phase blocked", project: "actual-project", scope: "project", duty: "other", level: 1, sequence: ["other"], placement: { target: "studio" } })
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "worker-runtime-unsupported" });

    const local = await (await fetch(`${boardUrl}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "local then remote", project: "actual-project", scope: "project" })
    })).json();
    loadoutReady = false;
    response = await fetch(`${boardUrl}/cards/${local.card.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rev: local.card.rev, placement: { target: "studio" } })
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "loadout-missing" });
  });

  it("allows non-project personal placement after worker preflight", async () => {
    const { devRoot } = fixtureRepo();
    const appUrl = await listen(http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/dispatch/machines") {
        res.end(JSON.stringify({ machines: [{
          name: "studio",
          worker: { state: "ready", ready: true, stale: false, runtimes: ["agent-sdk:anthropic"], detail: "ready" }
        }] }));
      } else {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "a personal workspace must not request a project Loadout" }));
      }
    }));
    const root = mkdtempSync(path.join(tmpdir(), "kanban-personal-remote-"));
    roots.push(root);
    writeExecutionModel(root);
    await saveBoard({ version: 3, lists: [{ id: "backlog", title: "Backlog", order: 0, kind: "manual", trigger: "manual", validNext: [] }] }, root);
    const boardUrl = await listen(http.createServer(makeRequestHandler({ root, cwd: root, devRoot, appUrl, gatewayUrl: null, cap: 10 }, root)));
    const response = await fetch(`${boardUrl}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "personal remote", scope: "personal", placement: { target: "studio" } })
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ card: { scope: "personal", project: null, placement: { target: "studio" } } });
  });
});
