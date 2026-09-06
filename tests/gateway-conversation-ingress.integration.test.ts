import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gatewayV4ExecutionModel } from "./helpers/gateway-v4-fixture";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATEWAY = path.join(ROOT, "fittings/seed/http-gateway/scripts/gateway-pty.mjs");

describe("normal conversation ingress through a real gateway process", () => {
  let child: ChildProcess | undefined;
  let home: string;
  let port: number;
  let logs = "";
  const pins = { target: "codex-astra", duty: "responder", level: 1, effort: "xhigh", project: "repo-a" };

  function rows(file: string): any[] {
    try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
    catch { return []; }
  }
  const ledger = (id: string) => rows(path.join(home, "conversations", id, "log.jsonl"));
  const calls = () => rows(path.join(home, "runtime-calls.jsonl"));
  async function until(predicate: () => boolean | Promise<boolean>, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`gateway test condition timed out\n${logs.slice(-6000)}`);
  }
  async function post(door: string, body: object) {
    const response = await fetch(`http://127.0.0.1:${port}/conversation/${door}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    return { status: response.status, body: await response.json() };
  }
  const message = (id: string, request: string, text: string, extra: object = {}) => post("message", {
    conversationId: id, clientRequestId: request, message: text, routing: pins, ...extra,
  });
  async function start() {
    child = spawn(process.execPath, [GATEWAY], {
      env: {
        ...process.env, GARRISON_GATEWAY_HOST: "127.0.0.1", GARRISON_GATEWAY_PORT: String(port),
        GARRISON_HOME: home, GARRISON_COMPOSITION_DIR: home, GARRISON_KANBAN_DIR: path.join(home, "board"),
        GARRISON_GATEWAY_NO_LISTEN: "0", GARRISON_PRIMARY_ENGINE: "claude-code", GARRISON_MODEL: "sonnet",
        GARRISON_GATEWAY_RUNTIME_STUB: path.join(ROOT, "tests/fixtures/gateway-runtime-stub.mjs"),
        GARRISON_AGENT_SDK_DIR: path.join(ROOT, "tests/fixtures/gateway-agent-sdk-runtime"),
        GARRISON_CODEX_DIR: path.join(ROOT, "tests/fixtures/gateway-conversation-codex"),
        CODEX_RUNTIME_DATA: path.join(home, "codex-lock"),
        CODEX_LOCK_POLL_MS: "10",
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => { logs += chunk; });
    child.stderr?.on("data", (chunk) => { logs += chunk; });
    await until(async () => {
      try { return (await (await fetch(`http://127.0.0.1:${port}/health`)).json()).pty_status === "ready"; }
      catch { return false; }
    }, 20000);
  }
  async function stop() {
    if (!child || child.exitCode != null) return;
    const processToStop = child;
    const exited = new Promise<void>((resolve) => processToStop.once("exit", () => resolve()));
    processToStop.kill("SIGTERM");
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(() => {
      processToStop.kill("SIGKILL"); resolve();
    }, 1000).unref())]);
  }
  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "garrison-conversation-http-"));
    fs.mkdirSync(path.join(home, ".garrison"));
    fs.mkdirSync(path.join(home, "board"));
    fs.mkdirSync(path.join(home, "dev", "repo-a", ".git"), { recursive: true });
    fs.writeFileSync(path.join(home, "dev-root"), path.join(home, "dev"));
    const model: any = gatewayV4ExecutionModel(path.basename(home));
    for (const duty of ["triage", "responder"]) {
      model.selectedDuties.push(duty);
      model.duties[duty] = { ...model.duties.other, id: duty };
      model.sequences[duty] = { "1": [duty] };
      model.steps[duty] = { "1": [{ ...model.steps.other["1"][0], duty }] };
    }
    fs.writeFileSync(path.join(home, "board", "model.json"), JSON.stringify(model));
    fs.writeFileSync(path.join(home, ".garrison", "routing.json"), JSON.stringify({
      version: 1, activeProfile: "test", roles: ["standard"], taskTypes: ["other"], tiers: ["T1-standard"],
      matrix: { defaults: { role: "standard" }, columns: {}, rows: {} }, exceptions: [], discipline: {}, continuations: [],
      targets: [
        { id: "cc-haiku-low", type: "runtime-target", runtime: "claude-code", provider: "anthropic-plan", model: "haiku" },
        { id: "codex-astra", type: "runtime-target", runtime: "codex", provider: "openai", model: "gpt-6-astra" },
      ], profiles: { test: { preRoute: "on", roleMap: { standard: "cc-haiku-low" } } },
    }));
    port = await new Promise<number>((resolve) => {
      const server = net.createServer().listen(0, "127.0.0.1", () => {
        const selected = (server.address() as net.AddressInfo).port;
        server.close(() => resolve(selected));
      });
    });
    await start();
  }, 30000);
  afterAll(async () => { await stop(); fs.rmSync(home, { recursive: true, force: true }); });

  it("admits twenty concurrent identical requests once across request-opened stores and after restart", async () => {
    const id = "http-concurrent";
    const admitted = await Promise.all(Array.from({ length: 20 }, () => message(id, "once", "Answer this isolated question")));
    expect(admitted.every((reply) => reply.status === 202)).toBe(true);
    expect(admitted.filter((reply) => reply.body.duplicate === true)).toHaveLength(19);
    await until(() => ledger(id).some((row) => row.kind === "stretch-ended"));
    expect(ledger(id).filter((row) => row.kind === "user-message")).toHaveLength(1);
    expect(ledger(id).filter((row) => row.kind === "stretch-started")).toHaveLength(1);
    expect(calls().filter((row) => row.kind === "turn")).toHaveLength(1);
    expect(calls()[0]).toMatchObject({ model: "gpt-6-astra", effort: "xhigh", cwd: path.join(home, "dev", "repo-a") });
    expect(ledger(id).find((row) => row.kind === "stretch-started").payload).toMatchObject({
      chosenBy: "pin", duty: "responder", target: { model: "gpt-6-astra", effort: "xhigh" },
    });
    const conflict = await message(id, "once", "Different text");
    expect(conflict.status).toBe(409);
    await stop(); await start();
    expect(await message(id, "once", "Answer this isolated question")).toMatchObject({ status: 202, body: { duplicate: true } });
    expect(calls().filter((row) => row.kind === "turn")).toHaveLength(1);
  }, 30000);

  it("cancels the active normal stretch, keeps a retry stopped, and accepts a subsequent message", async () => {
    const id = "http-stop";
    expect((await message(id, "hold", "HOLD_HTTP_TEST")).status).toBe(202);
    await until(() => calls().some((row) => row.kind === "turn" && row.brief.includes("HOLD_HTTP_TEST")));
    expect(await post("cancel", { conversationId: id })).toMatchObject({ status: 202, body: { cancelled: true } });
    await until(() => ledger(id).some((row) => row.kind === "stretch-ended"));
    expect(calls().filter((row) => row.kind === "cancel")).toHaveLength(1);
    await until(async () => (await post("cancel", { conversationId: id })).status === 404);
    expect(await message(id, "hold", "HOLD_HTTP_TEST")).toMatchObject({ status: 202, body: { duplicate: true } });
    expect(ledger(id).filter((row) => row.kind === "stretch-started")).toHaveLength(1);
    expect((await message(id, "next", "A subsequent independent question")).status).toBe(202);
    await until(() => ledger(id).filter((row) => row.kind === "stretch-ended").length === 2);
    expect(ledger(id).filter((row) => row.kind === "user-message")).toHaveLength(2);
  }, 15000);

  it("does not admit work after Stop while waiting for the machine-wide Codex lock", async () => {
    const id = "http-lock-stop";
    const lock = path.join(home, "codex-lock", "codex.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: "wx" });
    const before = calls().length;
    try {
      expect((await message(id, "locked", "This request must never reach Codex")).status).toBe(202);
      await until(() => ledger(id).some((row) => row.kind === "stretch-started"));
      expect(await post("cancel", { conversationId: id })).toMatchObject({ status: 202, body: { cancelled: true } });
    } finally { fs.rmSync(lock, { force: true }); }
    await until(() => ledger(id).some((row) => row.kind === "stretch-ended"));
    expect(ledger(id).find((row) => row.kind === "stretch-ended").payload).toMatchObject({ stoppedReason: "cancelled" });
    expect(calls().length).toBe(before);
  });

  it.each([{ project: "../../etc" }, { target: "missing" }, { effort: "unbounded" }, { duty: "missing" }])(
    "refuses unsupported pins %j visibly before any runtime side effect", async (invalid) => {
      const id = `http-refused-${Object.keys(invalid)[0]}`;
      const before = calls().length;
      expect((await message(id, "invalid", "Never run these settings", { routing: { ...pins, ...invalid } })).status).toBe(202);
      await until(() => ledger(id).some((row) => row.kind === "routing-rejected"));
      expect(ledger(id).some((row) => row.kind === "note" && row.payload.text.includes("The conversation did not start"))).toBe(true);
      expect(ledger(id).filter((row) => row.kind === "stretch-started")).toHaveLength(0);
      expect(calls().length).toBe(before);
    },
  );
});
