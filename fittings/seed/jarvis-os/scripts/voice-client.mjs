// Composition-selected voice consumer. Secret scope is delivered by the runner;
// credentials and loopback URLs stay in this server and never enter UI metadata.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import { fetchJson, proxyResponse, RequestError } from "./http-transport.mjs";

export function createVoiceClient({ statusRoot, fittingId = () => process.env.GARRISON_VOICE_FITTING_ID,
  token = () => process.env.CAPTURE_TOKEN || "", timeoutMs = 120_000, maxResponseBytes = 16 * 1024 * 1024 } = {}) {
  async function selected() {
    const id = await fittingId();
    if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) return { id: null, url: null };
    try {
      const record = JSON.parse(await readFile(path.join(statusRoot, `${id}.json`), "utf8"));
      const endpoint = new URL(record.url);
      if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error();
      // Discovered voice providers are on this node. Never forward its scoped
      // token to a stale/foreign URL persisted in a status record.
      if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) throw new Error();
      return { id, url: endpoint.href };
    } catch { return { id, url: null }; }
  }
  async function inspect() {
    const info = await selected();
    const health = info.url ? await fetchJson(info.url, "/health", Math.min(timeoutMs, 2500)) : null;
    const voice = health?.voice;
    const credential = await token();
    const needsToken = info.id === "capture-service";
    const ready = health?.ok === true && voice?.restEnabled === true && (!needsToken || Boolean(credential));
    const capabilities = {
      available: ready && (voice.stt === true || voice.tts === true), fittingId: info.id,
      stt: ready && voice?.stt === true, tts: ready && voice?.tts === true,
      maxTextChars: Number.isInteger(voice?.maxTextChars) && voice.maxTextChars > 0 ? Math.min(voice.maxTextChars, 10_000) : 600,
      ttsFormat: voice?.ttsFormat === "wav" ? "wav" : "mp3",
      wakeEvents: health?.ok === true && voice?.wakeEvents === true,
      stream: health?.ok === true && voice?.stream === true,
      ...(!ready ? { reason: !info.id ? "no voice provider selected" : !info.url || !health?.ok ? "voice provider unavailable" : needsToken && !credential ? "capture token not granted" : "voice is not ready" } : {})
    };
    return { info, credential, capabilities };
  }
  return {
    capabilities: async () => (await inspect()).capabilities,
    async proxy(req, res, subpath) {
      const { info, credential, capabilities } = await inspect();
      if (!capabilities.available || !capabilities[subpath === "/stt" ? "stt" : "tts"]) throw new RequestError(503, capabilities.reason || "voice capability unavailable");
      let body, contentType, target = new URL(subpath, info.url);
      if (subpath === "/tts") {
        const input = req.method === "GET" ? { text: new URL(req.url, "http://jarvis.invalid").searchParams.get("text") } : req.jarvisJson;
        if (typeof input?.text !== "string" || !input.text.trim()) throw new RequestError(400, "text is required");
        if (input.text.length > capabilities.maxTextChars) throw new RequestError(413, `text exceeds ${capabilities.maxTextChars} characters`);
        if (input.format !== undefined && input.format !== capabilities.ttsFormat) throw new RequestError(400, "unsupported voice format");
        body = JSON.stringify({ text: input.text, format: capabilities.ttsFormat,
          ...(typeof input.lang === "string" ? { lang: input.lang } : {}) });
        contentType = "application/json";
      } else {
        body = req.jarvisRaw;
        if (!body?.length) throw new RequestError(400, "audio is required");
        contentType = req.headers["content-type"];
        const language = new URL(req.url, "http://jarvis.invalid").searchParams.get("language");
        if (language) target.searchParams.set("language", language);
      }
      return proxyResponse(res, target, { method: "POST", body,
        headers: { "Content-Type": contentType, ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
        timeoutMs, maxBytes: maxResponseBytes });
    },
    async websocket(kind) {
      const { info, credential, capabilities } = await inspect();
      if (!capabilities.available || !capabilities[kind]) return null;
      const endpoint = new URL(kind === "wakeEvents" ? "/events" : "/stream", info.url);
      endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
      return { url: endpoint, headers: credential ? { Authorization: `Bearer ${credential}` } : {} };
    }
  };
}

export function relayVoiceStream(client, { url, headers }, search = "") {
  const target = new URL(url);
  const query = new URLSearchParams(search);
  const sampleRate = query.get("sample_rate");
  if (sampleRate && /^\d{4,6}$/.test(sampleRate)) target.searchParams.set("sample_rate", sampleRate);
  const upstream = new WebSocket(target, { headers, maxPayload: 256 * 1024, handshakeTimeout: 5000 });
  let pending = [], pendingBytes = 0, closed = false;
  const maxBytes = 1024 * 1024;
  const finish = () => {
    if (closed) return; closed = true; pending = []; pendingBytes = 0;
    clearTimeout(lifetime); clearInterval(heartbeat);
    upstream.terminate(); client.terminate();
  };
  const lifetime = setTimeout(finish, 30 * 60_000); lifetime.unref();
  let alive = true;
  const heartbeat = setInterval(() => { if (!alive) return finish(); alive = false; if (client.readyState === WebSocket.OPEN) client.ping(); }, 30_000); heartbeat.unref();
  client.on("pong", () => { alive = true; });
  function send(peer, data, binary) {
    if (peer.readyState !== WebSocket.OPEN || peer.bufferedAmount + data.length > maxBytes) return finish();
    peer.send(data, { binary }, (error) => { if (error) finish(); });
  }
  upstream.once("open", () => { for (const item of pending) send(upstream, item.data, item.binary); pending = []; pendingBytes = 0; });
  upstream.on("message", (data, binary) => send(client, data, binary));
  client.on("message", (data, binary) => {
    if (upstream.readyState === WebSocket.OPEN) return send(upstream, data, binary);
    if (upstream.readyState !== WebSocket.CONNECTING || pendingBytes + data.length > maxBytes || pending.length >= 128) return finish();
    pending.push({ data, binary }); pendingBytes += data.length;
  });
  for (const peer of [client, upstream]) { peer.once("close", finish); peer.once("error", finish); }
}
