#!/usr/bin/env node
// Conversations engine - the own-port host used by the web-channel-default
// fitting. Everything request-shaped lives in router.mjs; this file owns what a
// standalone process needs and the shell host does not: the listening socket
// (optional TLS), the status file the runner tracks the pid through, the
// WebSocket relays (Next has no upgrade path), the static bundle, and shutdown.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import url from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import {
  STATUS_ROOT,
  createTalkRouter,
  initTalkRuntime,
  recoverStartupInputs,
  readRemoteShellInfo,
  readVoiceInfo
} from "./router.mjs";

export * from "./router.mjs";

const STATUS_FILE = path.join(STATUS_ROOT, "web-channel-default.json");

export function parseArgs(argv) {
  const out = {
    // Port precedence (house convention, same as improver/ports-default):
    // runner-projected composition config first (per-instance, e.g. main=7083
    // vs codex=27083), then the legacy explicit env (tests), then the default.
    port: Number(process.env.GARRISON_WEBCHANNELDEFAULT_PORT || process.env.WEB_CHANNEL_PORT || 7083),
    host: process.env.GARRISON_WEBCHANNELDEFAULT_BIND_HOST || process.env.WEB_CHANNEL_HOST || process.env.GARRISON_BIND_HOST || "127.0.0.1",
    gatewayUrl: process.env.GARRISON_GATEWAY_URL || "",
    tlsCert: process.env.WEB_CHANNEL_TLS_CERT || "",
    tlsKey: process.env.WEB_CHANNEL_TLS_KEY || ""
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--gateway-url") out.gatewayUrl = argv[++i];
    else if (a === "--tls-cert") out.tlsCert = argv[++i];
    else if (a === "--tls-key") out.tlsKey = argv[++i];
  }
  if (!out.gatewayUrl) {
    const h = process.env.GARRISON_GATEWAY_HOST || "127.0.0.1";
    const p = process.env.GARRISON_GATEWAY_PORT || "4777";
    out.gatewayUrl = `http://${h}:${p}`;
  }
  return out;
}

// Cap on frames buffered before the upstream voice socket opens (codex S6a
// finding: an unbounded relay buffer is a memory-DoS if the upstream stalls).
const MAX_RELAY_PENDING = 256;

function relayVoiceStream(client, voiceHttpUrl, search, subpath = "/stream") {
  const upstreamUrl = voiceHttpUrl.replace(/^http/, "ws").replace(/\/+$/, "") + subpath + (search || "");
  const upstream = new WebSocket(upstreamUrl);
  const pending = [];

  upstream.on("open", () => {
    for (const { data, isBinary } of pending) upstream.send(data, { binary: isBinary });
    pending.length = 0;
  });
  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on("close", () => { try { client.close(); } catch {} });
  upstream.on("error", () => { try { client.close(); } catch {} });

  client.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else if (pending.length >= MAX_RELAY_PENDING) {
      // Pre-open buffer overflow - upstream stalled; tear both legs down.
      try { client.close(); } catch {}
      try { upstream.close(); } catch {}
    } else pending.push({ data, isBinary });
  });
  client.on("close", () => { try { upstream.close(); } catch {} });
  client.on("error", () => { try { upstream.close(); } catch {} });
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

async function readStatusFile() {
  try {
    return JSON.parse(await readFile(STATUS_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function writeStatusFile(opts) {
  await mkdir(STATUS_ROOT, { recursive: true });
  await writeFile(STATUS_FILE, JSON.stringify({
    fittingId: "web-channel-default",
    port: opts.port,
    url: `${opts.scheme ?? "http"}://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`,
    pid: process.pid,
    startedAt: new Date().toISOString()
  }, null, 2));
}

async function clearStatusFile() {
  try { await unlink(STATUS_FILE); } catch {}
}

// The fitting's static bundle. The default resolves the seed checkout; an
// installed copy under apm_modules passes its own dist through scripts/start.mjs.
export function defaultDistDir() {
  return path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..", "..", "fittings", "seed", "web-channel-default", "dist");
}

export async function startServer(opts = parseArgs(process.argv.slice(2)), { distDir = defaultDistDir() } = {}) {
  // Port discipline: never overwrite a status file whose pid is a LIVE other
  // process - a second spawn must fail loudly instead of silently stealing the
  // tracking slot and orphaning the first instance (the two-generations bug).
  const existing = await readStatusFile();
  if (existing && Number.isInteger(existing.pid) && existing.pid !== process.pid && pidAlive(existing.pid)) {
    console.error(
      `[web-channel] refusing to start: ${STATUS_FILE} tracks a live instance ` +
      `(pid ${existing.pid}, ${existing.url ?? `port ${existing.port}`}) - stop it first`
    );
    process.exit(1);
  }

  // Runtime ownership is process-local. Any durable starting/running/stopping
  // input left by the previous process is therefore uncertain and must never be
  // replayed. Reconcile before this process can accept requests; the queued
  // tail's workers are scheduled after bind.
  const startupInputs = await initTalkRuntime();

  // Optional TLS so mobile browsers get a secure context (getUserMedia / mic
  // capture is blocked on plain http over a LAN IP). When tls_cert/tls_key are
  // configured and readable, serve https; otherwise plain http (localhost is a
  // secure context, so desktop dev and Playwright are unaffected).
  let tls = null;
  if (opts.tlsCert && opts.tlsKey && existsSync(opts.tlsCert) && existsSync(opts.tlsKey)) {
    try {
      tls = { cert: readFileSync(opts.tlsCert), key: readFileSync(opts.tlsKey) };
    } catch (err) {
      console.error(`[web-channel] failed to read TLS cert/key, falling back to http: ${err.message}`);
      tls = null;
    }
  }
  const liveOpts = { ...opts, scheme: tls ? "https" : "http" };
  const requestHandler = createTalkRouter(liveOpts, { distDir });

  const server = tls
    ? https.createServer(tls, requestHandler)
    : http.createServer(requestHandler);
  const recoveryController = new AbortController();
  server.once("close", () => recoveryController.abort());

  // Streaming voice: pure passthrough WS relay browser ⇄ voice Fitting.
  // /api/voice/stream → the Fitting's STT /stream; /api/voice/tts-stream → its
  // read-aloud /tts-stream. No parsing - all Deepgram logic stays in the voice
  // Fitting; the key never reaches the browser. The page connects with wss when
  // this server is TLS, and we forward the query (sample_rate, etc.) verbatim.
  const VOICE_WS_ROUTES = {
    "/api/voice/stream": "/stream",
    "/api/voice/tts-stream": "/tts-stream"
  };
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const parsed = url.parse(request.url || "/", true);
    // Terminal stream for remote-shell threads: same passthrough relay as
    // voice, pointed at the remote-shell fitting's /io.
    if (parsed.pathname === "/remote-shell/io") {
      const rsh = readRemoteShellInfo();
      if (!rsh?.url) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (client) => relayVoiceStream(client, rsh.url, parsed.search || "", "/io"));
      return;
    }
    const subpath = VOICE_WS_ROUTES[parsed.pathname || ""];
    if (!subpath) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const info = readVoiceInfo();
    if (!info?.url) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => relayVoiceStream(client, info.url, parsed.search || "", subpath));
  });

  // Bind the CONFIGURED port only - no findFreePort auto-shift. A busy port is a
  // hard, loud failure so the runner surfaces the conflict instead of the server
  // silently splitting brain across two ports.
  server.on("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      console.error(`[web-channel] port ${liveOpts.port} on ${liveOpts.host} is already in use - refusing to auto-shift; free the port or change the configured port`);
    } else {
      console.error(`[web-channel] server error: ${err.message}`);
    }
    process.exit(1);
  });

  server.listen(liveOpts.port, liveOpts.host, async () => {
    await writeStatusFile(liveOpts);
    void recoverStartupInputs(startupInputs, liveOpts, { signal: recoveryController.signal });
    console.log(`[web-channel] listening on ${liveOpts.scheme}://${liveOpts.host}:${liveOpts.port} (gateway=${liveOpts.gatewayUrl})`);
  });

  const shutdown = async (signal) => {
    console.log(`[web-channel] shutdown (${signal})`);
    await clearStatusFile();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return { server, options: liveOpts };
}

const isDirect = (() => {
  if (!import.meta.url) return false;
  try {
    return path.resolve(url.fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || "");
  } catch {
    return false;
  }
})();

if (isDirect) {
  startServer().catch((err) => {
    console.error("[web-channel] failed to start:", err);
    process.exit(1);
  });
}
