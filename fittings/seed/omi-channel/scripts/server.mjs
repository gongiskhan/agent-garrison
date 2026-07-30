#!/usr/bin/env node
// Omi channel Fitting backend — Garrison's ears (and one mouth) on the Omi
// wearable ecosystem. Bidirectional channel: webhook ingress from Omi's cloud
// (memory-creation, realtime transcript, day summary, chat tool calls),
// heartbeat triage into Kanban cards + memories, outbound Omi direct
// notifications, a wake-word live pipe, and a backfeed into Omi memories.
//
// M0 scaffold: boot, /health, status file, minimal status page. Every ingress
// endpoint answers 501 until its milestone lands. Every pipe is behind its own
// default-off flag (invariant I9); with all flags off this server is inert.
//
// Ingress routes all live under /omi/ so the public Tailscale Funnel mapping
// can mount ONLY that path prefix — /health and the status page stay
// tailnet/loopback-only. See docs/adr-omi-channel.md.

import { createServer } from "node:http";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { FITTING_ID, garrisonDir, loadConfig, omiDir, statusFilePath } from "../lib/config.mjs";
import { Counters, OmiStore, mergedCounters } from "../lib/store.mjs";
import { Ingress } from "../lib/ingress.mjs";
import { syncTriageJob } from "../lib/scheduler-jobs.mjs";
import { Notifier } from "../lib/notify.mjs";
import { OmiApi } from "../lib/omi-api.mjs";
import { WakeBus } from "../lib/wake.mjs";
import { ChatTool } from "../lib/chat.mjs";
import { Backfeed } from "../lib/backfeed.mjs";
import { boardCardUrl } from "../lib/notify.mjs";
import { inferenceRunFn } from "../lib/gateway-client.mjs";
import { BoardClient } from "../lib/board-client.mjs";
import { MemoryWriter } from "../lib/memory-writer.mjs";

const BACKFEED_INTERVAL_MS = 30 * 60 * 1000;
const BACKFEED_BOOT_DELAY_MS = 2 * 60 * 1000;

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// Read a request body with a hard cap; resolves null when over the cap.
function readBody(req, cap = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > cap) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// True when `pid` names a live process (EPERM still means alive, just not ours).
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

async function readStatusFile(env) {
  try {
    return JSON.parse(await readFile(statusFilePath(env), "utf8"));
  } catch {
    return null;
  }
}

async function writeStatusFile(cfg) {
  const file = statusFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify(
      {
        fittingId: FITTING_ID,
        port: cfg.port,
        url: `http://${cfg.bindHost === "0.0.0.0" ? "localhost" : cfg.bindHost}:${cfg.port}`,
        pid: process.pid,
        startedAt: new Date().toISOString()
      },
      null,
      2
    )
  );
}

async function clearStatusFile() {
  try {
    await unlink(statusFilePath());
  } catch {}
}

function flagSummary(cfg) {
  return {
    ingress: cfg.enabled,
    triage: cfg.triageEnabled,
    wake: cfg.wakeEnabled,
    notify: cfg.notifyEnabled,
    chat: cfg.chatEnabled,
    backfeed: cfg.backfeedEnabled,
    tips: cfg.tipsEnabled
  };
}

function secretsPresence(cfg) {
  return {
    appId: Boolean(cfg.secrets.appId),
    appSecret: Boolean(cfg.secrets.appSecret),
    importApiKey: Boolean(cfg.secrets.importApiKey),
    webhookSecret: Boolean(cfg.secrets.webhookSecret)
  };
}

function statusPage(cfg) {
  const flags = flagSummary(cfg);
  const secrets = secretsPresence(cfg);
  const row = (k, v) =>
    `<tr><td>${k}</td><td class="${v ? "on" : "off"}">${v ? "on" : "off"}</td></tr>`;
  const srow = (k, v) =>
    `<tr><td>${k}</td><td class="${v ? "on" : "off"}">${v ? "sealed" : "missing"}</td></tr>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Omi channel</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #101418; color: #d7dde3; margin: 2rem; }
  h1 { font-size: 1.1rem; } h2 { font-size: 0.95rem; margin-top: 1.6rem; }
  table { border-collapse: collapse; } td { padding: 2px 14px 2px 0; }
  .on { color: #7dcf85; } .off { color: #8a939c; }
  p.note { color: #8a939c; max-width: 46rem; }
</style></head>
<body>
<h1>Omi channel</h1>
<p class="note">Bidirectional Omi wearable channel. Pipes are independently
flag-gated and default off; enable them per pipe in the fitting config.
Ingress endpoints live under /omi/.</p>
<h2>Pipes</h2>
<table>
${row("ingress (webhooks)", flags.ingress)}
${row("triage (heartbeat)", flags.triage)}
${row("wake bus", flags.wake)}
${row("outbound notifications", flags.notify)}
${row("chat tool (ask_gary)", flags.chat)}
${row("backfeed", flags.backfeed)}
${row("tips", flags.tips)}
</table>
<h2>Vault secrets</h2>
<table>
${srow("OMI_APP_ID", secrets.appId)}
${srow("OMI_APP_SECRET", secrets.appSecret)}
${srow("OMI_IMPORT_API_KEY", secrets.importApiKey)}
${srow("OMI_WEBHOOK_SECRET", secrets.webhookSecret)}
</table>
</body></html>`;
}

export function makeRequestHandler(ctx) {
  const { cfg, store, counters, ingress, notifier = null, chatTool = null } = ctx;
  return async (req, res) => {
    try {
      const parsed = url.parse(req.url || "/", true);
      const pathname = parsed.pathname || "/";
      const method = req.method || "GET";
      const query = parsed.query || {};

      if (pathname === "/health" || pathname === "/api/health") {
        const pinned = store.pinnedUid();
        return jsonRes(res, 200, {
          ok: true,
          fittingId: FITTING_ID,
          port: cfg.port,
          pid: process.pid,
          flags: flagSummary(cfg),
          secrets: secretsPresence(cfg),
          gatewayConfigured: Boolean(cfg.gatewayUrl),
          pinnedUid: pinned ? `${pinned.slice(0, 4)}...` : null,
          counters: mergedCounters(store.root)
        });
      }

      if (pathname === "/" && method === "GET") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.end(statusPage(cfg));
      }

      // ---- Ingress surface. Everything under /omi/ (the public Funnel mount
      // path); ?key= shared secret + pinned uid on every route (I8). ----
      if (pathname === "/omi/memory" && method === "POST") {
        const auth = ingress.authorize(query);
        if (!auth.ok) return jsonRes(res, auth.status, { error: auth.reason });
        const bodyText = await readBody(req);
        if (bodyText === null) return jsonRes(res, 413, { error: "body too large" });
        // Ack fast (I7): enqueue is one small file write; normalization runs
        // on the serialized drain chain after the response.
        ingress.accept({ kind: "conversation", uid: auth.uid, bodyText });
        return jsonRes(res, 200, { ok: true });
      }

      if (pathname === "/omi/day-summary" && method === "POST") {
        const auth = ingress.authorize(query);
        if (!auth.ok) return jsonRes(res, auth.status, { error: auth.reason });
        const bodyText = await readBody(req);
        if (bodyText === null) return jsonRes(res, 413, { error: "body too large" });
        ingress.accept({ kind: "day_summary", uid: auth.uid, bodyText });
        return jsonRes(res, 200, { ok: true });
      }

      if (pathname === "/omi/realtime" && method === "POST") {
        const auth = ingress.authorize(query);
        if (!auth.ok) return jsonRes(res, auth.status, { error: auth.reason });
        const bodyText = await readBody(req);
        if (bodyText === null) return jsonRes(res, 413, { error: "body too large" });
        // In-memory only (I5) - counted, never persisted, never logged.
        ingress.acceptRealtime({ bodyText, sessionId: query.session_id });
        return jsonRes(res, 200, { ok: true });
      }

      // ---- Thread-append contract (NOT under /omi/ - never on the public
      // funnel mount; reachable loopback/tailnet like every fitting API).
      // This is how other Garrison surfaces (kanban notify-origin) hand this
      // channel a system notification: stored for inspection, relayed to the
      // wearer via the Notifier's omi-push -> web-channel degrade chain.
      if (pathname === "/api/threads" && method === "POST") {
        const bodyText = await readBody(req);
        if (bodyText === null) return jsonRes(res, 413, { error: "body too large" });
        let body = null;
        try {
          body = JSON.parse(bodyText);
        } catch {
          return jsonRes(res, 400, { error: "invalid JSON" });
        }
        if (!body?.id) return jsonRes(res, 400, { error: "missing thread id" });
        const thread = store.ensureThread({ id: body.id, title: body.title ?? null, source: body.source ?? null });
        return jsonRes(res, 200, { ok: true, thread: { id: thread.id, title: thread.title } });
      }

      {
        const m = pathname.match(/^\/api\/threads\/([^/]+)\/messages$/);
        if (m && method === "POST") {
          const bodyText = await readBody(req);
          if (bodyText === null) return jsonRes(res, 413, { error: "body too large" });
          let body = null;
          try {
            body = JSON.parse(bodyText);
          } catch {
            return jsonRes(res, 400, { error: "invalid JSON" });
          }
          const threadId = decodeURIComponent(m[1]);
          const appended = store.appendThreadMessages(threadId, body?.messages);
          counters.bump("thread_messages_in", appended.length || 0);
          // Ack first, relay after - the caller (kanban) is fire-and-forget.
          jsonRes(res, 200, { ok: true, appended: appended.length });
          if (notifier) {
            for (const msg of appended) {
              void notifier
                .send({ template: "relay", params: { text: msg.text } })
                .catch((err) => console.error(`[omi-channel] relay failed: ${err?.message ?? err}`));
            }
          }
          return;
        }
      }

      // ---- ask_gary chat tool (M5). Own auth (chat_enabled + key + app_id +
      // pinned uid from the BODY - Omi tool calls carry uid in the payload).
      if (pathname === "/omi/chat" && method === "POST" && chatTool) {
        const bodyText = await readBody(req);
        if (bodyText === null) return jsonRes(res, 413, { error: "body too large" });
        let body = null;
        try {
          body = JSON.parse(bodyText);
        } catch {
          return jsonRes(res, 400, { error: "Invalid request." });
        }
        const outcome = await chatTool.handle(query, body);
        return jsonRes(res, outcome.status, outcome.body);
      }
      if (pathname === "/omi/tools-manifest" && method === "GET" && chatTool) {
        const outcome = chatTool.manifest(query);
        return jsonRes(res, outcome.status, outcome.body);
      }

      return jsonRes(res, 404, { error: "not found" });
    } catch (err) {
      console.error(`[omi-channel] request error: ${err?.stack || err}`);
      if (!res.headersSent) jsonRes(res, 500, { error: "internal error" });
      else res.end();
    }
  };
}

export async function startServer(cfg = loadConfig()) {
  // Port discipline: never overwrite a status file whose pid is a LIVE other
  // process — a second spawn must fail loudly instead of silently stealing the
  // tracking slot and orphaning the first instance.
  const existing = await readStatusFile();
  if (existing && Number.isInteger(existing.pid) && existing.pid !== process.pid && pidAlive(existing.pid)) {
    console.error(
      `[omi-channel] refusing to start: ${statusFilePath()} tracks a live instance ` +
        `(pid ${existing.pid}, ${existing.url ?? `port ${existing.port}`}) - stop it first`
    );
    process.exit(1);
  }

  // `live` is what handlers read; port is corrected to the actually-bound one
  // after listen (tests pass port 0 for an ephemeral bind).
  const live = { ...cfg };
  const store = new OmiStore(omiDir());
  const counters = new Counters(store.root, "server");
  const notifier = new Notifier({
    cfg: live,
    store,
    counters,
    omiApi: new OmiApi({ appId: live.secrets.appId, appSecret: live.secrets.appSecret })
  });
  const wakeBus = new WakeBus({
    cfg: live,
    store,
    counters,
    runFn: live.gatewayUrl ? inferenceRunFn(live.gatewayUrl) : null,
    board: new BoardClient(),
    memoryWriter: new MemoryWriter(),
    notifier
  });
  const ingress = new Ingress({ cfg: live, store, counters, wakeBus });
  const chatTool = new ChatTool({
    cfg: live,
    store,
    counters,
    // Bounded fast path: the fetch aborts just past the answer deadline so a
    // hung gateway can never hold the Omi chat UI hostage.
    runFn: live.gatewayUrl ? inferenceRunFn(live.gatewayUrl, { timeoutMs: 9500 }) : null
  });
  // Crash recovery: drain any raw payloads a previous process left queued.
  ingress.scheduleDrain();
  const server = createServer(makeRequestHandler({ cfg: live, store, counters, ingress, notifier, chatTool }));

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[omi-channel] port ${cfg.port} in use; refusing to start on a shifted port (the configured port is canonical)`
      );
      process.exit(1);
    }
    console.error(`[omi-channel] server error: ${err?.stack || err}`);
    process.exit(1);
  });

  await new Promise((resolve) => server.listen(cfg.port, cfg.bindHost, resolve));
  live.port = server.address().port;
  await writeStatusFile(live);
  console.log(
    `[omi-channel] listening on http://${live.bindHost}:${live.port} ` +
      `(home ${garrisonDir()}; flags ${JSON.stringify(flagSummary(live))})`
  );
  if (!cfg.gatewayUrl) {
    console.log("[omi-channel] no gateway URL in env; gateway-dependent pipes will skip with a reason");
  }

  // Boot-time scheduler-job sync (kanban server precedent: the server has the
  // gateway URL in scope, the setup hook does not). triage_enabled=true
  // registers the idempotent omi-triage job; false removes it. Tests pass
  // syncJobs: false via cfg to keep sandboxed boots from spawning the CLI.
  if (cfg.syncJobs !== false) {
    try {
      syncTriageJob(live);
    } catch (err) {
      console.error(`[omi-channel] scheduler job sync failed (non-fatal): ${err?.message ?? err}`);
    }
  }

  // Backfeed (M6): in-process interval - the sources (board, triaged events)
  // share this fitting's lifecycle, so a scheduler job would only ever fire
  // into a dead board. Flag off (the default) = nothing scheduled.
  let backfeedTimers = [];
  if (live.backfeedEnabled) {
    const backfeed = new Backfeed({
      cfg: live,
      store,
      counters,
      omiApi: new OmiApi({
        appId: live.secrets.appId,
        appSecret: live.secrets.appSecret,
        importApiKey: live.secrets.importApiKey
      }),
      board: new BoardClient(),
      cardUrlFn: (id) => boardCardUrl(id)
    });
    const run = () =>
      void backfeed
        .runOnce()
        .then((s) => console.log(`[omi-channel] backfeed: ${JSON.stringify(s)}`))
        .catch((err) => console.error(`[omi-channel] backfeed error: ${err?.message ?? err}`));
    const boot = setTimeout(run, BACKFEED_BOOT_DELAY_MS);
    const interval = setInterval(run, BACKFEED_INTERVAL_MS);
    boot.unref?.();
    interval.unref?.();
    backfeedTimers = [boot, interval];
  }

  const shutdown = async (signal) => {
    console.log(`[omi-channel] ${signal} received; shutting down`);
    for (const t of backfeedTimers) clearTimeout(t);
    await clearStatusFile();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return server;
}
