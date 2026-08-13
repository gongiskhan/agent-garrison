// Capture service — own-port server.
//
// M1 surface: websocket session ingress (lib/ingress.mjs) behind the master
// `enabled` flag, device registration, session read API, /health, status page.
// The Deepgram lane (M2), wake bus (M3), APNs (M5) and the speech sink (M5b)
// land behind their own default-off flags.
//
// Route conventions (omi-channel precedent):
//   403  implemented but disabled by its kill-switch flag (or missing secret)
//   501  not yet implemented (milestone pending)
//   404  on /ack and /notify UNTIL the sink milestones land — the kanban
//        fan-out treats 404 as "this fitting is not a sink", so the fitting
//        stays invisible to acks/notifications rather than swallowing them.
//
// Log privacy (invariant I5): no transcript text, no media bytes, no tokens
// in logs or counters — ids, seqs, counts and reasons only.

import { createServer } from "node:http";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { FITTING_ID, loadConfig } from "../lib/config.mjs";
import { CaptureStore, Counters, atomicWriteJSON, mergedCounters, readJSON } from "../lib/store.mjs";
import { CaptureIngress, bearerToken, tokenMatches } from "../lib/ingress.mjs";

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

// Read a bounded request body. On overflow it stops buffering but KEEPS
// DRAINING the socket so the caller can answer a clean 413 — destroying the
// socket would surface as a transport error on the client instead
// (ios-thing readBody pattern).
function readBody(req, cap = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (overflow) return;
      if (size > cap) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(overflow ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
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
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${v}</td></tr>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>capture-service</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;color:#222}table{border-collapse:collapse;margin:1rem 0}
td{border:1px solid #ccc;padding:.3rem .8rem}h1{font-size:1.3rem}h2{font-size:1rem}</style></head>
<body><h1>capture-service</h1>
<p>iOS companion capture channel. Secrets and transcript text are never shown here.</p>
<h2>Pipes</h2><table>${flagRows}</table>
<h2>Counters</h2><table>${counterRows || "<tr><td colspan=2>none yet</td></tr>"}</table>
</body></html>`;
}

const SESSION_PATH_RE = /^\/capture\/sessions\/([A-Za-z0-9_-]{10,40})$/;
const APNS_TOKEN_RE = /^[0-9a-fA-F]{32,200}$/;

// HTTP-side auth ladder, mirroring the websocket upgrade: flag off answers
// 403 before anything else, then missing secret, then the token compare.
function authorizeHttp(cfg, req, counters) {
  if (!cfg.enabled) {
    counters.bump("rejected_disabled");
    return { ok: false, status: 403, reason: "capture ingress disabled" };
  }
  if (!cfg.secrets.captureToken) {
    counters.bump("rejected_no_secret");
    return { ok: false, status: 403, reason: "CAPTURE_TOKEN not sealed" };
  }
  if (!tokenMatches(bearerToken(req), cfg.secrets.captureToken)) {
    counters.bump("rejected_auth");
    return { ok: false, status: 401, reason: "bad token" };
  }
  return { ok: true };
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
          liveSessions: ctx.ingress ? ctx.ingress.sessions.size : 0,
          counters: mergedCounters(store.root)
        });
      }

      if (req.method === "GET" && p === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(statusPage(cfg, mergedCounters(store.root)));
        return;
      }

      // ---- Device registration (spec §4): POST /capture/devices ----
      if (req.method === "POST" && p === "/capture/devices") {
        const auth = authorizeHttp(cfg, req, counters);
        if (!auth.ok) return json(res, auth.status, { error: auth.reason });
        const body = await readBody(req);
        if (body === null) return json(res, 413, { error: "body too large" });
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          return json(res, 400, { error: "invalid JSON" });
        }
        const token = String(parsed?.apns_token ?? "").trim();
        if (!APNS_TOKEN_RE.test(token)) {
          return json(res, 400, { error: "apns_token must be hex" });
        }
        const deviceName = String(parsed?.device_name ?? "iPhone").trim().slice(0, 64) || "iPhone";
        const registry = readJSON(store.devicesFile, { tokens: [] });
        const existing = registry.tokens.find((t) => t.token === token);
        if (existing) {
          existing.device_name = deviceName;
          counters.bump("devices_deduped");
        } else {
          registry.tokens.push({ token, device_name: deviceName, registered_at: new Date().toISOString() });
          counters.bump("devices_registered");
        }
        atomicWriteJSON(store.devicesFile, registry);
        return json(res, 200, { ok: true, count: registry.tokens.length });
      }

      // ---- Session read API (the replay client and the M2 view read these) ----
      if (req.method === "GET" && p === "/capture/sessions") {
        const auth = authorizeHttp(cfg, req, counters);
        if (!auth.ok) return json(res, auth.status, { error: auth.reason });
        const { readdirSync } = await import("node:fs");
        const sessions = readdirSync(store.dirs.sessions)
          .filter((f) => f.endsWith(".json"))
          .sort()
          .map((f) => readJSON(path.join(store.dirs.sessions, f)))
          .filter(Boolean)
          .map((s) => ({
            id: s.id,
            mode: s.mode,
            device_name: s.device_name,
            consent: s.consent,
            started_at: s.started_at,
            status: s.status,
            audio_seq: s.audio_seq,
            video_seq: s.video_seq,
            ended: s.ended
          }));
        return json(res, 200, { sessions });
      }

      const sessionMatch = req.method === "GET" ? SESSION_PATH_RE.exec(p) : null;
      if (sessionMatch) {
        const auth = authorizeHttp(cfg, req, counters);
        if (!auth.ok) return json(res, auth.status, { error: auth.reason });
        const record = readJSON(path.join(store.dirs.sessions, `${sessionMatch[1]}.json`));
        if (!record) return json(res, 404, { error: "no such session" });
        return json(res, 200, { session: record });
      }

      // Websocket endpoint reached over plain HTTP.
      if (p === "/capture/stream") {
        return json(res, 400, { error: "websocket upgrade required" });
      }

      // Anything else under /capture/ is a later milestone.
      if (p.startsWith("/capture/")) {
        counters.bump("requests_unimplemented");
        return json(res, 501, { error: "not implemented yet" });
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
  const ingress = new CaptureIngress({ cfg: live, store, counters });
  const server = createServer(makeRequestHandler({ cfg: live, store, counters, ingress }));
  server.on("upgrade", (req, socket, head) => ingress.handleUpgrade(req, socket, head));

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
    ingress.close();
    await clearStatusFile(live.statusFile);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return { server, cfg: live, store, counters, ingress };
}
