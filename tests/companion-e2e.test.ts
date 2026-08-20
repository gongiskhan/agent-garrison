// Companion E2E (M7): the WHOLE loop against a sandboxed instance with EVERY
// flag on and every external boundary mocked — run via `npm run e2e:companion`.
//
//   phone (replay client subprocess + an in-test app socket)
//     -> websocket ingress (auth, acks, resume)
//     -> mock Deepgram (the env-only GARRISON_CAPTURESERVICE_DG_URL hook)
//     -> live transcript
//     -> wake gate -> stub gateway (pinned classify) -> card on the stub
//        kanban board with companion origin
//     -> notifier -> mock APNs (h2c http2 server via the env hook)
//     -> POST /ack -> spoken through the in-test speech sink (the app
//        stand-in replies {spoken}), echo registered BEFORE speak and the
//        returning echo SUPPRESSED FROM THE STORED TRANSCRIPT
//     -> session end -> capture_event emitted
//     -> the shared triage tick (run directly, as omi's e2e does — the cron
//        CADENCE itself is the scheduler's, not under test here; production
//        wait-windows must exceed it, per the runbook) -> memory persisted
//        with provenance + card_created push
//     -> the ask template out through /notify -> mock APNs.
//
// Coverage limits, stated so green is not mistaken for more: Deepgram and
// APNs are mocks (the env-gated real-key smoke and TestFlight cover the live
// halves); the phone's encoder is the device's job; the scheduler daemon is
// not running (the tick is invoked directly).

import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import http2 from "node:http2";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import WebSocket, { WebSocketServer } from "ws";
import { loadConfig } from "../fittings/seed/capture-service/lib/config.mjs";
import { startServer } from "../fittings/seed/capture-service/scripts/server.mjs";
import { encodeMediaFrame } from "../fittings/seed/capture-service/lib/ingress.mjs";

const execFileAsync = promisify(execFile);
const TOKEN = "e2e-companion-token";
const WAKE_TEXT = "Zeca, cria uma tarefa de teste chamada olá companion.";
const REAL_TEXT = "Amanhã tenho de enviar o relatório final à Ana.";
const ACK_TEXT = "Created a task, olá companion.";
const FITTING = path.join(__dirname, "..", "fittings", "seed", "capture-service");

const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const P8_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function dgResults(text: string, isFinal: boolean, start = 0, duration = 2) {
  return JSON.stringify({
    type: "Results",
    start,
    duration,
    is_final: isFinal,
    channel: {
      alternatives: [
        { transcript: text, confidence: 0.97, words: text.split(/\s+/).map((w, i) => ({ word: w, start: start + i * 0.2, end: start + i * 0.2 + 0.19, speaker: 0 })) }
      ]
    }
  });
}

async function waitFor(pred: () => boolean, ms = 15000, label = "condition") {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!pred()) throw new Error(`timed out waiting for ${label}`);
}

describe("companion E2E — all flags on, external boundaries mocked", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "companion-e2e-"));
  // The memory writer refuses to invent a missing vault (basic-memory is an
  // optional-one dependency); the sandbox provides one like the prod host does.
  const vaultDir = path.join(home, "obsidian-vault");
  mkdirSync(vaultDir, { recursive: true });
  const cleanups: Array<() => void> = [];
  afterAll(() => {
    while (cleanups.length) cleanups.pop()!();
    rmSync(home, { recursive: true, force: true });
  });

  // ---- external boundaries, all local ----

  // Mock Deepgram: scriptable per-connection; the driver pushes messages.
  const dgScript: Array<{ afterFrames: number; message: string }> = [];
  const dg = new WebSocketServer({ port: 0 });
  dg.on("connection", (ws) => {
    let frames = 0;
    const fired = new Set<number>();
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        frames += 1;
        dgScript.forEach((step, i) => {
          if (!fired.has(i) && frames >= step.afterFrames) {
            fired.add(i);
            ws.send(step.message);
          }
        });
        return;
      }
      if (JSON.parse(data.toString()).type === "CloseStream") ws.close(1000);
    });
  });
  const dgUrl = `ws://127.0.0.1:${(dg.address() as { port: number }).port}`;
  cleanups.push(() => dg.close());

  // Mock APNs: a plain h2c HTTP/2 server recording every push.
  const pushes: Array<{ path: string; topic: string; payload: any }> = [];
  const apns = http2.createServer();
  apns.on("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (c) => (body += c));
    stream.on("end", () => {
      pushes.push({ path: String(headers[":path"]), topic: String(headers["apns-topic"]), payload: JSON.parse(body || "{}") });
      stream.respond({ ":status": 200 });
      stream.end("{}");
    });
  });
  apns.listen(0, "127.0.0.1");
  cleanups.push(() => apns.close());

  // Stub kanban board, discovered via the sandbox status file.
  const cards: any[] = [];
  const board = createHttpServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/health") return respond(200, { ok: true });
    if (url.pathname === "/projects") return respond(200, { projects: ["garrison"] });
    if (url.pathname === "/cards" && req.method === "GET") {
      return respond(200, { cards: cards.filter((c) => c.origin_id === url.searchParams.get("origin_id")) });
    }
    if (url.pathname === "/cards" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const card = { id: `01CARD${String(cards.length + 1).padStart(4, "0")}`, list: "backlog", ...JSON.parse(body) };
        cards.push(card);
        respond(200, { card });
      });
      return;
    }
    respond(404, { error: "not found" });
  });
  board.listen(0, "127.0.0.1");
  cleanups.push(() => board.close());

  // Stub gateway answering BOTH prompt kinds (the omi e2e pattern).
  const gatewayCalls: Array<{ body: any }> = [];
  const gateway = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      gatewayCalls.push({ body: parsed });
      const prompt = String(parsed.message ?? "");
      let reply = "";
      if (prompt.includes("spoken wake-word command")) {
        reply = JSON.stringify({ intent: "create_task", title: "olá companion", description: "Tarefa de teste do companion.", project: "garrison" });
      } else if (prompt.includes("capture-inbox triage step")) {
        const eventId = /### Event (\S+)/.exec(prompt)?.[1] ?? "";
        reply = JSON.stringify({
          cards: [{ event_id: eventId, action_index: 0, title: "Enviar o relatório à Ana", description: "Enviar o relatório final.", project: "garrison" }],
          memories: [{ event_id: eventId, title: "A Ana recebe o relatório final", content: "O relatório final vai para a Ana.", tags: ["work"] }],
          tips: []
        });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ reply }));
    });
  });
  board.on("error", () => {});
  gateway.listen(0, "127.0.0.1");
  cleanups.push(() => gateway.close());

  let handle: Awaited<ReturnType<typeof startServer>>;
  let base = "";
  const SESSION = "01E2ESESSION0001";

  it("boots the sandboxed instance with every flag on", async () => {
    mkdirSync(path.join(home, "ui-fittings"), { recursive: true });
    writeFileSync(
      path.join(home, "ui-fittings", "kanban-loop.json"),
      JSON.stringify({ fittingId: "kanban-loop", port: (board.address() as any).port, url: `http://127.0.0.1:${(board.address() as any).port}`, pid: process.pid })
    );
    const env = {
      GARRISON_HOME: home,
      CAPTURE_TOKEN: TOKEN,
      DEEPGRAM_API_KEY: "e2e-mock-key",
      APNS_TEAM_ID: "N3AN3Z32JN",
      APNS_KEY_ID: "E2EKEY0001",
      APNS_P8: P8_PEM,
      GARRISON_CAPTURESERVICE_DG_URL: dgUrl,
      GARRISON_CAPTURESERVICE_APNS_URL: `http://127.0.0.1:${(apns.address() as any).port}`
    };
    const cfg = loadConfig(env);
    handle = await startServer({
      ...cfg,
      env,
      port: 0,
      enabled: true,
      transcribeEnabled: true,
      wakeEnabled: true,
      notifyEnabled: true,
      speakEnabled: true,
      gatewayUrl: `http://127.0.0.1:${(gateway.address() as any).port}`,
      wakeSilenceCloseMs: 200,
      wakeSettledCloseMs: 80,
      wakeMaxCaptureMs: 3000
    });
    cleanups.push(() => {
      handle.ingress.close();
      handle.server.close();
    });
    base = `http://127.0.0.1:${handle.cfg.port}`;

    const health = await fetch(`${base}/health`).then((r) => r.json());
    expect(health.flags).toEqual({
      ingress: true,
      transcribe: true,
      wake: true,
      notify: true,
      speak: true,
      // Pendant Direct additions: present, off by default, policy at its
      // wake_only default - the companion loop ignores both.
      pendant: false,
      capturePolicy: "wake_only"
    });
    expect(health.secrets).toMatchObject({ captureToken: true, deepgramApiKey: true, apnsP8: true });
  });

  it("registers the phone and proves the wire protocol with the replay client", async () => {
    const register = await fetch(`${base}/capture/devices`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ apns_token: "ab".repeat(32), device_name: "e2e-iPhone" })
    });
    expect(register.status).toBe(200);

    // The replay client (the committed E2E driver) runs as a real subprocess:
    // fixture streaming, a mid-stream drop with resume, and the dedupe pass.
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(FITTING, "scripts", "replay-client.mjs"), "run", "--fixture", "pt-command", "--twice", "--drop-at", "80", "--base", base, "--token", TOKEN],
      { timeout: 60000 }
    );
    expect(stdout).toContain("every frame deduped");
    expect(stdout).toContain("high-water matches the fixture packet count");
  }, 90000);

  it("hears the wake command live, cards it with companion identity, and pushes the confirmation", async () => {
    // The app stand-in: session socket that answers speaks with receipts.
    const ws = new WebSocket(base.replace("http", "ws") + "/capture/stream", {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    const spoken: string[] = [];
    const queue: any[] = [];
    const waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString());
      if (msg.type === "speak") {
        spoken.push(msg.ack.text);
        ws.send(JSON.stringify({ type: "spoken", spoken: msg.ack.id, ok: true }));
        return;
      }
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
      else queue.push(msg);
    });
    const next = (pred: (m: any) => boolean): Promise<any> => {
      const i = queue.findIndex(pred);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        waiters.push({ pred, resolve });
        setTimeout(() => reject(new Error("socket message timeout")), 15000).unref();
      });
    };
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    ws.send(JSON.stringify({ type: "session_start", session_id: SESSION, mode: "audio", device_name: "e2e-iPhone", consent: "shown", started_at: "2026-08-13T10:00:00.000Z" }));
    await next((m) => m.type === "session_started");

    // Script the mock transcriber: the spoken command arrives as a live final.
    dgScript.push({ afterFrames: 4, message: dgResults(WAKE_TEXT, true, 0, 3) });
    for (let seq = 1; seq <= 8; seq++) {
      ws.send(encodeMediaFrame(0, seq, seq * 20, Buffer.from(`opus-${seq}`)));
      await next((m) => m.type === "ack" && m.seq === seq);
    }

    // Wake -> pinned classify on the stub gateway -> card -> APNs push.
    await waitFor(() => cards.some((c) => c.origin_id?.startsWith("companion:wake:")), 15000, "wake card");
    const wakeCard = cards.find((c) => c.origin_id?.startsWith("companion:wake:"))!;
    expect(wakeCard.title).toBe("olá companion");
    expect(wakeCard.origin).toBe("companion");
    expect(wakeCard.originChannel).toEqual({ channel: "companion", threadId: "companion-reports" });
    const classify = gatewayCalls.find((c) => String(c.body.message).includes("spoken wake-word command"))!;
    expect(classify.body.routing).toEqual({ target: "cc-haiku-low" });
    await waitFor(() => pushes.length >= 1, 10000, "wake confirmation push");
    expect(pushes[0].topic).toBe("com.gomes.garrison");
    expect(pushes[0].payload.aps.alert.body).toContain("olá companion");

    // The kanban ack arrives (as fanOutAck would): echo registers FIRST,
    // the sink speaks it, the receipt lands.
    const ackRes = await fetch(`${base}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "ack-e2e-1", kind: "created", severity: "info", templateId: "card.created", text: ACK_TEXT, idempotencyKey: "e2e-card-1" })
    }).then((r) => r.json());
    expect(ackRes.delivered).toBe("socket");
    await waitFor(() => spoken.length === 1, 8000, "spoken ack");
    expect(spoken[0]).toBe(ACK_TEXT);
    await waitFor(() => handle.counters.read().speaks_confirmed === 1, 8000, "spoken receipt");

    // The app's own voice comes back through the mic (fragmented) plus real
    // speech; then the session ends.
    dgScript.push({ afterFrames: 12, message: dgResults("created a task olá companion", true, 4, 1.2) });
    dgScript.push({ afterFrames: 16, message: dgResults(REAL_TEXT, true, 6, 2.5) });
    for (let seq = 9; seq <= 18; seq++) {
      ws.send(encodeMediaFrame(0, seq, seq * 20, Buffer.from(`opus-${seq}`)));
      await next((m) => m.type === "ack" && m.seq === seq);
    }
    await waitFor(() => handle.counters.read().realtime_echo_suppressed >= 1, 8000, "echo suppression");
    ws.send(JSON.stringify({ type: "session_end", reason: "user" }));
    await next((m) => m.type === "session_ended");
    ws.close();

    // The STORED transcript keeps the operator's words, never the app's own.
    const transcript = JSON.parse(readFileSync(path.join(home, "capture", "transcripts", `${SESSION}.json`), "utf8"));
    const texts = transcript.segments.map((s: any) => s.text);
    expect(texts).toContain(WAKE_TEXT);
    expect(texts).toContain(REAL_TEXT);
    expect(texts).not.toContain("created a task olá companion");
  }, 60000);

  it("triages the ended session in ONE model call: card, memory with provenance, push", async () => {
    const events = readdirSync(path.join(home, "capture", "events")).map((f) =>
      JSON.parse(readFileSync(path.join(home, "capture", "events", f), "utf8"))
    );
    const sessionEvent = events.find((e) => e.kind === "session")!;
    expect(sessionEvent.status).toBe("pending");
    expect(sessionEvent.provenance).toMatchObject({ companion_session_id: SESSION, consent: "shown" });

    // The shared tick, exactly as the scheduler job runs it (one shot).
    const gatewayCallsBefore = gatewayCalls.length;
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(__dirname, "..", "fittings", "seed", "omi-channel", "scripts", "triage.mjs"), "--tick"],
      {
        timeout: 60000,
        env: {
          ...process.env,
          GARRISON_HOME: home,
          GARRISON_OMI_DIR: path.join(home, "omi"),
          GARRISON_CAPTURE_DIR: path.join(home, "capture"),
          GARRISON_GATEWAY_URL: `http://127.0.0.1:${(gateway.address() as any).port}`,
          GARRISON_OMICHANNEL_TRIAGE_ENABLED: "true",
          BASIC_MEMORY_VAULT_DIR: vaultDir,
          BASIC_MEMORY_MEMORY_DIR: "Memory"
        }
      }
    );
    expect(stdout).toContain('"modelCalls":1');
    expect(gatewayCalls.length).toBe(gatewayCallsBefore + 1);

    const triageCard = cards.find((c) => c.origin_id === `companion:${SESSION}:0`)!;
    expect(triageCard.title).toBe("Enviar o relatório à Ana");
    expect(triageCard.origin).toBe("companion");
    expect(triageCard.description).toContain("Provenance: companion session " + SESSION);

    // Memory persisted with companion provenance under the companion prefix.
    const memoryFiles = readdirSync(path.join(vaultDir, "Memory"));
    expect(memoryFiles.length).toBe(1);
    expect(memoryFiles[0]).toMatch(/^companion-/);
    const memory = readFileSync(path.join(vaultDir, "Memory", memoryFiles[0]), "utf8");
    expect(memory).toContain("source**: companion-ios");
    expect(memory).toContain("companion session**: " + SESSION);

    // The triage relay handed card_created to this fitting's /notify -> APNs.
    await waitFor(() => pushes.some((p) => p.payload.aps.alert.body.includes("Enviar o relatório à Ana")), 10000, "triage card push");

    // Re-run: origin dedupe means zero duplicates.
    const capEvents = readdirSync(path.join(home, "capture", "events")).map((f) =>
      JSON.parse(readFileSync(path.join(home, "capture", "events", f), "utf8"))
    );
    expect(capEvents.find((e) => e.kind === "session")!.status).toBe("triaged");
  }, 90000);

  it("exercises the ask template out through /notify and reads every pipe on /health", async () => {
    const pushesBefore = pushes.length;
    const askReceipts = await fetch(`${base}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Zeca asks", text: "Qual dos dois relatórios devo enviar?", tag: "ask", idempotencyKey: "e2e-ask-1" })
    }).then((r) => r.json());
    expect(askReceipts[0]).toMatchObject({ means: "companion-push", ok: true });
    await waitFor(() => pushes.length === pushesBefore + 1, 8000, "ask push");
    expect(pushes.at(-1)!.payload.aps.alert.body).toContain("Qual dos dois relatórios");

    const health = await fetch(`${base}/health`).then((r) => r.json());
    const c = health.counters;
    // Every pipe moved: ingress, transcription, wake, cards, echo, speech,
    // acks, pushes, emission.
    expect(c.sessions_started).toBeGreaterThanOrEqual(2);
    expect(c.audio_frames_in).toBeGreaterThan(200);
    expect(c.audio_frames_deduped).toBeGreaterThan(190); // the --twice pass
    expect(c.transcribe_segments_final).toBeGreaterThanOrEqual(2);
    expect(c.wake_hits).toBe(1);
    expect(c.wake_dispatches).toBe(1);
    expect(c.wake_cards_created).toBe(1);
    expect(c.realtime_echo_suppressed).toBeGreaterThanOrEqual(1);
    expect(c.echo_registered).toBeGreaterThanOrEqual(1);
    expect(c.acks_in).toBe(1);
    expect(c.speaks_forwarded).toBe(1);
    expect(c.speaks_confirmed).toBe(1);
    expect(c.notifications_sent).toBeGreaterThanOrEqual(3); // wake + triage + ask
    expect(c.events_emitted).toBeGreaterThanOrEqual(1);
    expect(c.wake_capture_ms_count).toBe(1);
    expect(c.wake_notify_ms_count).toBe(1);
  });
});
