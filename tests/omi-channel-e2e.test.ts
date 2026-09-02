// Omi channel M7 — the full local end-to-end demo on fixtures with ALL flags
// on (spec acceptance). Every pipe runs against the real server + real
// modules; only the external boundaries are stubbed: the Omi cloud API, the
// kanban board, the web channel, and the gateway (which answers the three
// prompt kinds like the operative would).
//
// Flow: fixtures replayed twice (idempotent) -> heartbeat triage (one model
// call, cards + memories + tips) -> wake command spoken -> card + confirmation
// -> ask_zeca chat answer -> kanban lifecycle relay -> backfeed into Omi.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const FIXTURES = path.resolve(__dirname, "..", "fittings", "seed", "omi-channel", "fixtures");
const SECRET = "e2e-webhook-secret";
const UID = "omi_test_user_1";

const home = mkdtempSync(path.join(os.tmpdir(), "omi-e2e-"));
const vaultDir = path.join(home, "obsidian-vault");

type Recorded = { method: string; path: string; body: unknown };

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

async function readBody(req: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString();
  try {
    return JSON.parse(text || "{}");
  } catch {
    return { raw: text };
  }
}

// ---- Omi cloud stub (notifications + import) --------------------------------
const omiCloud = { received: [] as Recorded[] };
const omiCloudServer = createServer(async (req, res) => {
  omiCloud.received.push({ method: req.method ?? "", path: req.url ?? "", body: await readBody(req) });
  res.statusCode = 200;
  res.end("{}");
});

// ---- kanban board stub -------------------------------------------------------
const board = { cards: [] as Array<Record<string, unknown>>, nextId: 1 };
const boardServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/health") return json(200, { ok: true });
  if (url.pathname === "/projects") return json(200, { projects: ["garrison"] });
  if (url.pathname === "/cards" && req.method === "GET") {
    const originId = url.searchParams.get("origin_id");
    const cards = originId ? board.cards.filter((c) => c.origin_id === originId) : board.cards;
    return json(200, { cards });
  }
  if (url.pathname === "/cards" && req.method === "POST") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const card = { id: `01E2ECARD${String(board.nextId++).padStart(3, "0")}`, list: "backlog", ...body };
    board.cards.push(card);
    return json(201, { card });
  }
  const detail = url.pathname.match(/^\/cards\/([^/]+)$/);
  if (detail && req.method === "GET") {
    const card = board.cards.find((c) => c.id === decodeURIComponent(detail[1]));
    return card ? json(200, { card }) : json(404, { error: "no card" });
  }
  return json(404, { error: "not found" });
});

// ---- web channel stub ----------------------------------------------------------
const webChannel = { received: [] as Recorded[] };
const webChannelServer = createServer(async (req, res) => {
  webChannel.received.push({ method: req.method ?? "", path: req.url ?? "", body: await readBody(req) });
  res.statusCode = 200;
  res.end("{}");
});

// ---- gateway stub: answers the three prompt kinds like the operative would ----
const gateway = { calls: [] as string[] };
const gatewayServer = createServer(async (req, res) => {
  const body = (await readBody(req)) as { message?: string };
  const prompt = String(body.message ?? "");
  gateway.calls.push(prompt);
  let reply = "";
  if (prompt.includes("capture-inbox triage step")) {
    // Build candidates from the ACTUAL event blocks in the prompt (the
    // per-event `- source:` line sits between kind and task-eligible).
    const events = [...prompt.matchAll(/### Event (\S+)\n- kind: (\S+)\n- source: [^\n]+\n- task-eligible: (yes|no)/g)].map((m) => ({
      id: m[1],
      kind: m[2],
      taskEligible: m[3] === "yes"
    }));
    const firstEligible = events.find((e) => e.taskEligible);
    reply = JSON.stringify({
      cards: firstEligible
        ? [
            {
              event_id: firstEligible.id,
              action_index: 0,
              title: "Send the pricing page draft to Rita",
              description: "Prepare and send the pricing page draft.",
              project: "garrison"
            }
          ]
        : [],
      memories: events.slice(0, 1).map((e) => ({
        event_id: e.id,
        title: "Launch prep is on",
        content: "The launch checklist is split between Goncalo and Rita this week.",
        tags: ["work"]
      })),
      tips: firstEligible ? [{ event_id: firstEligible.id, text: "Send beta invites on Tuesday morning." }] : []
    });
  } else if (prompt.includes("spoken wake-word command")) {
    reply = JSON.stringify({
      intent: "create_task",
      title: "Create a test task called hello garrison",
      description: "Create the hello garrison test task.",
      project: "garrison"
    });
  } else {
    reply = "You have open cards on the board; the beta email is due Friday.";
  }
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ reply, session_id: "e2e" }));
});

let omiServer: Server | null = null;
let base = "";
const prevEnv: Record<string, string | undefined> = {};

async function waitFor(predicate: () => boolean, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  if (!predicate()) throw new Error("waitFor timed out");
}

describe("omi-channel end-to-end demo (all flags on, fixtures only)", () => {
  beforeAll(async () => {
    const omiCloudPort = await listen(omiCloudServer);
    const boardPort = await listen(boardServer);
    const webPort = await listen(webChannelServer);
    const gatewayPort = await listen(gatewayServer);

    for (const [k, v] of Object.entries({
      GARRISON_HOME: home,
      BASIC_MEMORY_VAULT_DIR: vaultDir,
      OMI_API_BASE_URL: `http://127.0.0.1:${omiCloudPort}`
    })) {
      prevEnv[k] = process.env[k];
      process.env[k] = v;
    }
    // The server's notifier reads process.env: an app named by the runner (a
    // dev-env shell projects GARRISON_APP_URL) would win over the web-channel
    // stub below and post the fallback into the real Conversations store.
    prevEnv.GARRISON_APP_URL = process.env.GARRISON_APP_URL;
    delete process.env.GARRISON_APP_URL;
    mkdirSync(vaultDir, { recursive: true });
    mkdirSync(path.join(home, "ui-fittings"), { recursive: true });
    writeFileSync(
      path.join(home, "ui-fittings", "kanban-loop.json"),
      JSON.stringify({ fittingId: "kanban-loop", port: boardPort, url: `http://127.0.0.1:${boardPort}` })
    );
    writeFileSync(
      path.join(home, "ui-fittings", "web-channel-default.json"),
      JSON.stringify({ fittingId: "web-channel-default", port: webPort, url: `http://127.0.0.1:${webPort}` })
    );

    // Dynamic imports AFTER the env is in place (OMI_API_BASE_URL is read at
    // module load).
    const { loadConfig } = await import("../fittings/seed/omi-channel/lib/config.mjs");
    const { startServer } = await import("../fittings/seed/omi-channel/scripts/server.mjs");
    const cfg = {
      ...loadConfig(process.env as Record<string, string>),
      port: 0,
      syncJobs: false,
      gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
      enabled: true,
      triageEnabled: true,
      wakeEnabled: true,
      notifyEnabled: true,
      chatEnabled: true,
      backfeedEnabled: true,
      tipsEnabled: true,
      wakeSilenceCloseMs: 60,
      wakeMaxCaptureMs: 2000,
      secrets: { appId: "app_e2e", appSecret: "app_secret", importApiKey: "sk_import", webhookSecret: SECRET }
    };
    omiServer = await startServer(cfg);
    const addr = omiServer.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  }, 20000);

  afterAll(async () => {
    for (const server of [omiServer, omiCloudServer, boardServer, webChannelServer, gatewayServer]) {
      if (server) await new Promise<void>((r) => server.close(() => r()));
    }
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("ingests the fixture set idempotently", async () => {
    const { replayFixtures } = await import("../fittings/seed/omi-channel/scripts/replay.mjs");
    for (let round = 1; round <= 2; round++) {
      const results = await replayFixtures({ base, key: SECRET, uid: UID, dir: FIXTURES });
      for (const r of results) expect(r.status, `${r.file} round ${round}`).toBe(200);
    }
    await waitFor(() => existsSync(path.join(home, "omi", "events")) && readdirSync(path.join(home, "omi", "events")).length === 6);
  });

  it("triages the inbox with ONE model call: cards, memories, tips delivered", async () => {
    const { loadConfig } = await import("../fittings/seed/omi-channel/lib/config.mjs");
    const { OmiStore, Counters } = await import("../fittings/seed/omi-channel/lib/store.mjs");
    const { runTriageTick } = await import("../fittings/seed/omi-channel/lib/triage.mjs");
    const { inferenceRunFn } = await import("../fittings/seed/omi-channel/lib/gateway-client.mjs");
    const { BoardClient } = await import("../fittings/seed/omi-channel/lib/board-client.mjs");
    const { MemoryWriter } = await import("../fittings/seed/omi-channel/lib/memory-writer.mjs");
    const { Notifier } = await import("../fittings/seed/omi-channel/lib/notify.mjs");
    const { OmiApi } = await import("../fittings/seed/omi-channel/lib/omi-api.mjs");

    const health = await fetch(`${base}/health`).then((r) => r.json());
    expect(health.gatewayConfigured).toBe(true);

    const store = new OmiStore(path.join(home, "omi"));
    const counters = new Counters(store.root, "triage");
    const fullCfg = {
      ...loadConfig(process.env as Record<string, string>),
      triageEnabled: true,
      tipsEnabled: true,
      notifyEnabled: true,
      gatewayUrl: `http://127.0.0.1:${(gatewayServer.address() as { port: number }).port}`
    };
    const notifier = new Notifier({
      cfg: fullCfg,
      store,
      counters,
      omiApi: new OmiApi({ appId: "app_e2e", appSecret: "app_secret", importApiKey: "sk_import" })
    });
    const gatewayCallsBefore = gateway.calls.length;
    const summary = await runTriageTick({
      cfg: fullCfg,
      store,
      counters,
      runFn: inferenceRunFn(fullCfg.gatewayUrl as string),
      board: new BoardClient(),
      memoryWriter: new MemoryWriter(),
      notifier
    });
    await notifier.drainTips();

    expect(summary.modelCalls).toBe(1);
    expect(gateway.calls.length).toBe(gatewayCallsBefore + 1);
    expect(summary.dropped).toBeGreaterThanOrEqual(1); // the discarded fixture
    expect(summary.cardsCreated).toBe(1);
    expect(summary.memoriesWritten).toBe(1);
    expect(summary.tipsQueued).toBe(1);

    // Card on the board with provenance + origin dedupe key.
    const triageCard = board.cards.find((c) => String(c.origin_id ?? "").startsWith("omi:conv_"));
    expect(triageCard).toBeTruthy();
    expect(String(triageCard!.description)).toContain("Source (Omi):");

    // Memory in the vault with provenance.
    const notes = readdirSync(path.join(vaultDir, "Memory"));
    expect(notes.some((f) => f.startsWith("omi-"))).toBe(true);

    // card_created + tip notifications reached the Omi cloud stub.
    const pushes = omiCloud.received.filter((r) => r.path.includes("/notification"));
    expect(pushes.length).toBeGreaterThanOrEqual(2);
    // An empty second tick makes zero model calls (I3).
    const before = gateway.calls.length;
    const empty = await runTriageTick({
      cfg: fullCfg,
      store,
      counters,
      runFn: inferenceRunFn(fullCfg.gatewayUrl as string),
      board: new BoardClient(),
      memoryWriter: new MemoryWriter(),
      notifier
    });
    expect(empty.modelCalls).toBe(0);
    expect(gateway.calls.length).toBe(before);
  }, 15000);

  it("handles a spoken wake command end to end", async () => {
    const pushesBefore = omiCloud.received.filter((r) => r.path.includes("/notification")).length;
    const res = await fetch(`${base}/omi/realtime?key=${SECRET}&uid=${UID}&session_id=live1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { text: "ok so anyway", speaker: "SPEAKER_00", speakerId: 0, is_user: true, start: 1, end: 2 },
        { text: "Zeca, create a test task called hello garrison", speaker: "SPEAKER_00", speakerId: 0, is_user: true, start: 3, end: 6 }
      ])
    });
    expect(res.status).toBe(200);

    await waitFor(() => omiCloud.received.filter((r) => r.path.includes("/notification")).length > pushesBefore);
    const wakeCard = board.cards.find((c) => String(c.origin_id ?? "").startsWith("omi:wake:"));
    expect(wakeCard).toBeTruthy();
    expect(wakeCard!.title).toContain("hello garrison");

    const confirmation = omiCloud.received
      .filter((r) => r.path.includes("/notification"))
      .map((r) => decodeURIComponent(String(new URL(r.path, "http://x").searchParams.get("message"))))
      .find((m) => m.includes("Card created"));
    expect(confirmation).toBeTruthy();

    const health = await fetch(`${base}/health`).then((r) => r.json());
    expect(health.counters.wake_hits).toBe(1);
    expect(health.counters.wake_hit_to_notification_ms_count).toBe(1);
  }, 15000);

  it("answers ask_zeca within budget through the live route", async () => {
    const res = await fetch(`${base}/omi/chat?key=${SECRET}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uid: UID, app_id: "app_e2e", tool_name: "ask_zeca", query: "how is the board?" })
    });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(String(payload.result)).toContain("beta email");
  });

  it("relays a kanban lifecycle message to the wearer via the thread contract", async () => {
    const pushesBefore = omiCloud.received.filter((r) => r.path.includes("/notification")).length;
    const res = await fetch(`${base}/api/threads/omi-reports/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "assistant", text: "Run complete - Send the pricing page draft." }] })
    });
    expect(res.status).toBe(200);
    await waitFor(() => omiCloud.received.filter((r) => r.path.includes("/notification")).length > pushesBefore);
  });

  it("backfeeds completed cards and decisions into Omi, idempotently", async () => {
    const { loadConfig } = await import("../fittings/seed/omi-channel/lib/config.mjs");
    const { OmiStore, Counters } = await import("../fittings/seed/omi-channel/lib/store.mjs");
    const { Backfeed } = await import("../fittings/seed/omi-channel/lib/backfeed.mjs");
    const { OmiApi } = await import("../fittings/seed/omi-channel/lib/omi-api.mjs");
    const { BoardClient } = await import("../fittings/seed/omi-channel/lib/board-client.mjs");

    // The wake card finished meanwhile.
    const wakeCard = board.cards.find((c) => String(c.origin_id ?? "").startsWith("omi:wake:"))!;
    wakeCard.list = "done";
    wakeCard.updated = new Date().toISOString();
    wakeCard.lastReply = "Created and verified the hello garrison task.";

    const store = new OmiStore(path.join(home, "omi"));
    const backfeed = new Backfeed({
      cfg: { ...loadConfig(process.env as Record<string, string>), backfeedEnabled: true },
      store,
      counters: new Counters(store.root, "backfeed"),
      omiApi: new OmiApi({ appId: "app_e2e", appSecret: "app_secret", importApiKey: "sk_import" }),
      board: new BoardClient(),
      cardUrlFn: async (id: string) => `http://127.0.0.1/#/cards/${id}`,
      log: { log: () => {}, error: () => {} }
    });
    const first = await backfeed.runOnce();
    expect(first.sent).toBeGreaterThanOrEqual(2); // done card + fixture decision
    const second = await backfeed.runOnce();
    expect(second.sent).toBe(0);

    const imports = omiCloud.received.filter((r) => r.path.includes("/user/memories"));
    expect(imports.length).toBe(first.sent);
    expect(JSON.stringify(imports.map((i) => i.body))).toContain("Garrison completed");
  });

  it("surfaces every pipe's counters on /health", async () => {
    const health = await fetch(`${base}/health`).then((r) => r.json());
    const c = health.counters;
    expect(c.events_in).toBeGreaterThanOrEqual(5);
    expect(c.dropped_by_rule).toBeGreaterThanOrEqual(1);
    expect(c.cards_created).toBeGreaterThanOrEqual(1);
    expect(c.wake_hits).toBe(1);
    expect(c.notifications_sent).toBeGreaterThanOrEqual(3);
    expect(c.chat_calls).toBeGreaterThanOrEqual(1);
    expect(c.backfeed_sent).toBeGreaterThanOrEqual(2);
    const page = await fetch(`${base}/`).then((r) => r.text());
    expect(page).toContain("wake_hits");
  });
});
