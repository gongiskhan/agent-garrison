import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setupKanbanState } from "../kanban-state-env";
import { gatewayV4ExecutionModel } from "./gateway-v4-fixture";
// @ts-ignore JavaScript service boundary
import { createTalkRouter } from "../../packages/talk/src/router.mjs";
// @ts-ignore JavaScript service boundary
import { makeRequestHandler } from "../../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore JavaScript service boundary
import { buildBoard } from "../../fittings/seed/kanban-loop/lib/resolved-model.mjs";
// @ts-ignore JavaScript service boundary
import { saveBoard } from "../../fittings/seed/kanban-loop/lib/board.mjs";

const root = path.resolve(__dirname, "../..");
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
export async function cardsHarness() {
  const home = process.env.GARRISON_HOME!;
  if (!home || !path.basename(home).startsWith("garrison-test-home-")) throw new Error("The journey harness requires the isolated test home.");
  const boardRoot = path.join(home, "board");
  process.env.GARRISON_HOME = home; process.env.GARRISON_KANBAN_DIR = boardRoot;
  process.env.GARRISON_POLICY_PATH = path.join(home, "no-policy");
  fs.mkdirSync(path.join(home, "dev", "garrison", ".git"), { recursive: true });
  fs.mkdirSync(path.join(home, ".garrison"), { recursive: true });
  fs.mkdirSync(boardRoot); fs.mkdirSync(path.join(home, "ui-fittings"));
  fs.writeFileSync(path.join(home, "dev-root"), path.join(home, "dev"));
  const state = await setupKanbanState();
  await saveBoard(buildBoard(), boardRoot);
  const model: any = gatewayV4ExecutionModel(path.basename(home));
  model.version = 3; model.dutyLadder = {}; model.cells = {}; model.targets = [{ id: "codex-astra", runtime: "codex", provider: "openai", model: "gpt-6-astra", params: {} }];
  for (const duty of ["triage", "responder", "plan", "implement", "review", "test", "validate", "report", "other", "code"]) {
    model.selectedDuties.push(duty); model.duties[duty] = { ...model.duties.other, id: duty };
    model.sequences[duty] = { "1": [duty] };
    model.steps[duty] = { "1": [{ duty, targetId: "codex-astra", runtime: "codex", provider: "openai", model: "gpt-6-astra", effort: "low", params: {} }] };
    model.cells[duty] = { "1": { target: "codex-astra", effort: "low" } };
    model.dutyLadder[duty] = { ladder: "standard", rungs: [{ ...model.targets[0], target: "codex-astra" }], defaultIndex: 0, ceilingIndex: 0 };
  }
  fs.writeFileSync(path.join(boardRoot, "model.json"), JSON.stringify(model));
  fs.writeFileSync(path.join(home, ".garrison/routing.json"), JSON.stringify({ version: 1, activeProfile: "test", roles: ["standard"], taskTypes: ["other"], tiers: ["T1-standard"], matrix: { defaults: { role: "standard" }, columns: {}, rows: {} }, exceptions: [], discipline: {}, continuations: [], targets: model.targets.map((t: any) => ({ ...t, type: "runtime-target" })), profiles: { test: { preRoute: "on", roleMap: { standard: "codex-astra" } } } }));
  const port = await new Promise<number>((done) => { const server = net.createServer().listen(0, "127.0.0.1", () => { const p = (server.address() as net.AddressInfo).port; server.close(() => done(p)); }); });
  const gatewayUrl = `http://127.0.0.1:${port}`;
  let logs = "", child: ChildProcess;
  const start = async () => {
    child = spawn(process.execPath, [path.join(root, "fittings/seed/http-gateway/scripts/gateway-pty.mjs")], { env: {
      ...process.env, GARRISON_GATEWAY_HOST: "127.0.0.1", GARRISON_GATEWAY_PORT: String(port), GARRISON_COMPOSITION_DIR: home,
      GARRISON_GATEWAY_NO_LISTEN: "0", GARRISON_PRIMARY_ENGINE: "claude-code", GARRISON_MODEL: "sonnet",
      GARRISON_GATEWAY_RUNTIME_STUB: path.join(root, "tests/fixtures/gateway-runtime-stub.mjs"),
      GARRISON_AGENT_SDK_DIR: path.join(root, "tests/fixtures/gateway-agent-sdk-runtime"),
      GARRISON_CODEX_DIR: path.join(root, "tests/fixtures/cards-runtime"), CODEX_RUNTIME_DATA: path.join(home, "lock"), CODEX_LOCK_POLL_MS: "10",
    }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk) => { logs += chunk; }); child.stderr?.on("data", (chunk) => { logs += chunk; });
    for (let i = 0; i < 200; i++) { try { if ((await (await fetch(gatewayUrl + "/health")).json()).pty_status === "ready") return; } catch {} await delay(100); }
    throw new Error(logs.slice(-4000));
  };
  let failInference = false, inferenceCalls = 0;
  const gatewayRelay = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const raw = Buffer.concat(chunks).toString();
    if (req.url === "/conversation/card-inference") {
      inferenceCalls++; res.setHeader("content-type", "application/json");
      if (failInference) { res.statusCode = 503; res.end('{"error":"Forced inference failure"}'); return; }
      const prompt = JSON.parse(raw).prompt; const ids = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((m: any) => m[1]);
      const earlier = ids.length > 10 ? "Also discussed: weekend walking routes." : "None";
      res.end(JSON.stringify({ text: JSON.stringify({ title: "Build an offline reminder preview", description: `## Task\nBuild an offline preview of reminder times.\n\n## Decisions already made\n- Keep local times.\n- Show the next three reminders.\n\n## Open questions\n${earlier}\n\n## Context\nThe calendar currently shows reminders in UTC.`, messageIds: ids, confidence: 0.92 }) })); return;
    }
    const reply = await fetch(gatewayUrl + req.url, { method: req.method, ...(raw ? { body: raw, headers: { "content-type": "application/json" } } : {}) });
    res.writeHead(reply.status, { "content-type": reply.headers.get("content-type") || "application/json" }); res.end(Buffer.from(await reply.arrayBuffer()));
  });
  await new Promise<void>((done) => gatewayRelay.listen(0, "127.0.0.1", done));
  const relayUrl = `http://127.0.0.1:${(gatewayRelay.address() as net.AddressInfo).port}`;
  const board = makeRequestHandler({ root: boardRoot, cwd: root, gatewayUrl, cap: 10 }, path.join(root, "fittings/seed/kanban-loop/dist"));
  const talk = createTalkRouter({ gatewayUrl: relayUrl });
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url!, "http://fixture.test").pathname;
    if (pathname === "/talk" || pathname === "/") {
      res.setHeader("content-type", "text/html"); res.end(fs.readFileSync(path.join(root, "fittings/seed/web-channel-default/dist/index.html"))); return;
    }
    if (pathname.startsWith("/web-channel") || ["/manifest.webmanifest", "/sw.js"].includes(pathname)) {
      const file = path.join(root, "fittings/seed/web-channel-default/dist", path.basename(pathname));
      if (fs.existsSync(file)) { res.setHeader("content-type", pathname.endsWith("css") ? "text/css" : "application/javascript"); res.end(fs.readFileSync(file)); return; }
    }
    if (pathname.startsWith("/api/")) { if (await talk(req, res)) return; }
    await board(req, res);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  process.env.GARRISON_APP_URL = base;
  fs.writeFileSync(path.join(home, "ui-fittings/kanban-loop.json"), JSON.stringify({ url: base }));
  await start();
  return { home, boardRoot, base, gatewayUrl, logs: () => logs, inferenceCalls: () => inferenceCalls, failInference: (value: boolean) => { failInference = value; },
    runtimeCalls: () => { try { return fs.readFileSync(path.join(home, "controlled-runtime/calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)); } catch { return []; } },
    async stop() {
      child.kill("SIGTERM"); await Promise.race([new Promise((done) => child.once("exit", done)), delay(1500)]); if (child.exitCode == null) child.kill("SIGKILL");
      for (const s of [server, gatewayRelay]) { s.closeAllConnections(); await new Promise<void>((done) => s.close(() => done())); } await state.stop();
    },
  };
}
