// Capture service — own-port server (M0 scaffold).
//
// M0 surface: status file with a live-pid guard, /health, a status page, and
// honest 501s on every not-yet-implemented milestone surface. The websocket
// ingress (M1), Deepgram lane (M2), wake bus (M3), APNs (M5) and the speech
// sink (M5b) land behind their own default-off flags.
//
// Route conventions (omi-channel precedent):
//   501  not yet implemented (milestone pending)
//   403  implemented but disabled by its kill-switch flag
//   404  on /ack and /notify UNTIL the sink milestones land — the kanban
//        fan-out treats 404 as "this fitting is not a sink", so the fitting
//        stays invisible to acks/notifications rather than swallowing them.

import { createServer } from "node:http";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { FITTING_ID, loadConfig } from "../lib/config.mjs";
import { CaptureStore, Counters, mergedCounters } from "../lib/store.mjs";

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

async function readStatusFile(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeStatusFile(cfg) {
  const file = cfg.statusFile;
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

async function clearStatusFile(file) {
  try {
    await unlink(file);
  } catch {}
}

function flagSummary(cfg) {
  return {
    ingress: cfg.enabled,
    transcribe: cfg.transcribeEnabled,
    wake: cfg.wakeEnabled,
    notify: cfg.notifyEnabled,
    speak: cfg.speakEnabled
  };
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function statusPage(cfg, counters) {
  const flags = flagSummary(cfg);
  const flagRows = Object.entries(flags)
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${v ? "on" : "off"}</td></tr>`)
    .join("");
  const counterRows = Object.entries(counters)
    .filter(([, v]) => typeof v === "number")
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${v}</td></tr>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>capture-service</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;color:#222}table{border-collapse:collapse;margin:1rem 0}
td{border:1px solid #ccc;padding:.3rem .8rem}h1{font-size:1.3rem}h2{font-size:1rem}</style></head>
<body><h1>capture-service</h1>
<p>iOS companion capture channel. Session ingress lands at M1; this is the M0 scaffold.</p>
<h2>Pipes</h2><table>${flagRows}</table>
<h2>Counters</h2><table>${counterRows || "<tr><td colspan=2>none yet</td></tr>"}</table>
</body></html>`;
}

export function makeRequestHandler(ctx) {
  const { cfg, store, counters } = ctx;
  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const p = url.pathname;

    try {
      if (req.method === "GET" && (p === "/health" || p === "/api/health")) {
        return json(res, 200, {
          ok: true,
          fittingId: FITTING_ID,
          port: cfg.port,
          pid: process.pid,
          flags: flagSummary(cfg),
          secrets: {
            deepgramApiKey: Boolean(cfg.secrets.deepgramApiKey),
            captureToken: Boolean(cfg.secrets.captureToken),
            apnsTeamId: Boolean(cfg.secrets.apnsTeamId),
            apnsKeyId: Boolean(cfg.secrets.apnsKeyId),
            apnsP8: Boolean(cfg.secrets.apnsP8)
          },
          gatewayConfigured: Boolean(cfg.gatewayUrl),
          counters: mergedCounters(store.root)
        });
      }

      if (req.method === "GET" && p === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(statusPage(cfg, mergedCounters(store.root)));
        return;
      }

      // Milestone surfaces, in landing order. 501 = not yet implemented; the
      // flag-off answer becomes 403 when each milestone lands.
      if (p === "/capture/stream" || p.startsWith("/capture/")) {
        counters.bump("requests_unimplemented");
        return json(res, 501, { error: "not implemented yet", milestone: p === "/capture/stream" ? "M1" : "M1+" });
      }

      // NOT a sink yet — 404 keeps the kanban ack/notify fan-out treating this
      // fitting as "not for you" until M5b/M5 land the real handlers.
      return json(res, 404, { error: "not found" });
    } catch (err) {
      console.error(`[capture-service] handler error: ${err?.stack || err}`);
      return json(res, 500, { error: "internal error" });
    }
  };
}

export async function startServer(cfg = loadConfig()) {
  // Port discipline: never overwrite a status file whose pid is a LIVE other
  // process — a second spawn must fail loudly instead of silently stealing
  // the tracking slot and orphaning the first instance.
  const existing = await readStatusFile(cfg.statusFile);
  if (existing && Number.isInteger(existing.pid) && existing.pid !== process.pid && pidAlive(existing.pid)) {
    console.error(
      `[capture-service] refusing to start: ${cfg.statusFile} tracks a live instance ` +
        `(pid ${existing.pid}, ${existing.url ?? `port ${existing.port}`}) - stop it first`
    );
    process.exit(1);
  }

  // `live` is what handlers read; port is corrected to the actually-bound one
  // after listen (tests pass port 0 for an ephemeral bind).
  const live = { ...cfg };
  const store = new CaptureStore(live.stateDir);
  const counters = new Counters(store.root, "server");
  const server = createServer(makeRequestHandler({ cfg: live, store, counters }));

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[capture-service] port ${cfg.port} in use; refusing to start on a shifted port (the configured port is canonical)`
      );
      process.exit(1);
    }
    console.error(`[capture-service] server error: ${err?.stack || err}`);
    process.exit(1);
  });

  await new Promise((resolve) => server.listen(cfg.port, cfg.bindHost, resolve));
  live.port = server.address().port;
  await writeStatusFile(live);
  console.log(
    `[capture-service] listening on http://${live.bindHost}:${live.port} ` +
      `(home ${live.home}; flags ${JSON.stringify(flagSummary(live))})`
  );
  if (!cfg.gatewayUrl) {
    console.log("[capture-service] no gateway URL in env; gateway-dependent pipes will skip with a reason");
  }

  const shutdown = async (signal) => {
    console.log(`[capture-service] ${signal} received; shutting down`);
    await clearStatusFile(live.statusFile);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return { server, cfg: live, store, counters };
}
