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
import { FITTING_ID, garrisonDir, loadConfig, statusFilePath } from "../lib/config.mjs";

function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function notImplemented(res, pipe) {
  jsonRes(res, 501, { error: `omi-channel ${pipe} is not implemented yet` });
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

export function makeRequestHandler(cfg) {
  return async (req, res) => {
    try {
      const parsed = url.parse(req.url || "/", true);
      const pathname = parsed.pathname || "/";
      const method = req.method || "GET";

      if (pathname === "/health" || pathname === "/api/health") {
        return jsonRes(res, 200, {
          ok: true,
          fittingId: FITTING_ID,
          port: cfg.port,
          pid: process.pid,
          flags: flagSummary(cfg),
          secrets: secretsPresence(cfg),
          gatewayConfigured: Boolean(cfg.gatewayUrl)
        });
      }

      if (pathname === "/" && method === "GET") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.end(statusPage(cfg));
      }

      // Ingress surface (M1+): memory / realtime / day-summary webhooks, chat
      // tool call + manifest. 501 until each milestone lands.
      if (pathname === "/omi/memory" && method === "POST") return notImplemented(res, "memory webhook");
      if (pathname === "/omi/realtime" && method === "POST") return notImplemented(res, "realtime webhook");
      if (pathname === "/omi/day-summary" && method === "POST") return notImplemented(res, "day-summary webhook");
      if (pathname === "/omi/chat" && method === "POST") return notImplemented(res, "chat tool");
      if (pathname === "/omi/tools-manifest" && method === "GET") return notImplemented(res, "chat tools manifest");

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
  const server = createServer(makeRequestHandler(live));

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

  const shutdown = async (signal) => {
    console.log(`[omi-channel] ${signal} received; shutting down`);
    await clearStatusFile();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return server;
}
