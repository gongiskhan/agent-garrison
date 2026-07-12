// opencode-adapter.mjs — the OpenCode RuntimeAdapter (BRIEF v4 Runtime faculty).
//
// OpenCode is a SECONDARY runtime. Unlike Codex/Gemini (per-task `exec` subprocess),
// OpenCode's natural fit is a STANDING HTTP server — `opencode serve` on
// 127.0.0.1:<port>, sessions addressed by id, prompts posted over HTTP. This adapter
// implements the same RuntimeAdapter contract; the generic pool + runtime-bridge drive
// it unchanged.
//
// Transport (verified live against opencode 1.17.15 OpenAPI, GET /doc):
//   spawn()         boots (or attaches) `opencode serve` + POST /session -> sessionID
//   sendTurn()      posts the prompt; awaitResponse() returns the reply text
//   teardown()      kills ONLY a server this adapter spawned (never one it attached to)
//
//   Per-turn transport order (documented deviation from BRIEF's "v2 first"):
//   the v2 `POST /api/session/{id}/prompt` body (PromptInput = {text,files,agents})
//   CANNOT carry per-call model/variant — verified against the live spec — while the
//   legacy `POST /session/{id}/message` body DOES (model,variant,agent,system,tools) AND
//   is send-and-await (returns the assistant message in one call). So the legacy
//   send-and-await endpoint is PRIMARY (it honors setModel/setEffort as the BRIEF
//   requires); the v2 prompt+wait+read path is the 404 fallback for server versions that
//   dropped the legacy route. The configured default model is ALSO written into the
//   scoped server config, so even the v2 path runs on the right provider/model.
//
// Stateless fallback: when the server can't boot, `opencode run "<prompt>" -m
// <provider/model> --format json --auto` runs a single subprocess and prints NDJSON
// events; parseRunJsonEvents() pulls the final text out.
import { spawn as nodeSpawn } from "node:child_process";

const DEFAULT_PORT = 7094;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_USERNAME = "opencode";

// Split "provider/model" into the server's {providerID, modelID}. The model id may
// itself contain slashes/colons (e.g. "ollama/qwen2.5:3b" or "openrouter/x/y"): split
// on the FIRST "/" only. Returns null when unset.
export function parseModel(modelStr) {
  if (!modelStr || typeof modelStr !== "string") return null;
  const idx = modelStr.indexOf("/");
  if (idx < 0) return null;
  const providerID = modelStr.slice(0, idx);
  const modelID = modelStr.slice(idx + 1);
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
}

// Basic-auth header for the server password (unset => no auth, unsecured localhost).
export function authHeader(password, username = DEFAULT_USERNAME) {
  if (!password) return {};
  const token = Buffer.from(`${username}:${password}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

// Build the stateless `opencode run` invocation — OPTIONS only (the prompt is appended
// as a trailing positional at exec time so it is NEVER baked into these static args).
// model via -m provider/model, --format json (machine-readable events), --auto
// (auto-approve permissions), --variant for reasoning effort, --agent, --dir cwd.
export function buildRunArgs(config = {}) {
  const argv = ["run"];
  if (config.model) argv.push("-m", config.model);
  argv.push("--format", "json");
  argv.push("--auto"); // headless: auto-approve permissions not explicitly denied
  if (config.effort) argv.push("--variant", config.effort);
  if (config.agent) argv.push("--agent", config.agent);
  if (config.compositionDir) argv.push("--dir", config.compositionDir);
  return { bin: config.bin || "opencode", argv };
}

// Pull the final assistant text out of `opencode run --format json` output. The format
// is NDJSON (one JSON event per line); tolerant of the exact event schema (not verified
// live — no credentials on this box). Collects text from any assistant text part /
// text-bearing event, in order, and returns the concatenation. Non-JSON lines are
// ignored (the CLI may interleave plain log lines on some paths).
export function parseRunJsonEvents(stdout) {
  const chunks = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || (t[0] !== "{" && t[0] !== "[")) continue;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    collectText(ev, chunks);
  }
  return chunks.join("");
}

function collectText(ev, chunks) {
  if (!ev || typeof ev !== "object") return;
  // A full message envelope { info, parts } (assistant only).
  if (ev.parts && Array.isArray(ev.parts)) {
    if (!ev.info || ev.info.role === "assistant") pushParts(ev.parts, chunks);
    return;
  }
  // A single part event { type:"text", text } (skip synthetic/ignored scaffolding).
  if (ev.type === "text" && typeof ev.text === "string" && !ev.synthetic && !ev.ignored) {
    chunks.push(ev.text);
    return;
  }
  // A nested { part: {...} } streaming event.
  if (ev.part) collectText(ev.part, chunks);
}

function pushParts(parts, chunks) {
  for (const p of parts) {
    if (p && p.type === "text" && typeof p.text === "string" && !p.synthetic && !p.ignored) {
      chunks.push(p.text);
    }
  }
}

// Extract the assistant reply text from a server payload — either the legacy
// send-and-await response { info, parts } or a message LIST [{info,parts}, …] (v2 path,
// where we take the LAST assistant message).
export function extractAssistantText(payload) {
  if (Array.isArray(payload)) {
    for (let i = payload.length - 1; i >= 0; i--) {
      const m = payload[i];
      if (m && m.info && m.info.role === "assistant" && Array.isArray(m.parts)) {
        return partsText(m.parts);
      }
    }
    return "";
  }
  if (payload && Array.isArray(payload.parts)) return partsText(payload.parts);
  return "";
}

function partsText(parts) {
  const chunks = [];
  pushParts(parts, chunks);
  return chunks.join("");
}

// Default HTTP transport (global fetch) — injectable for tests.
function defaultFetch(...args) {
  return globalThis.fetch(...args);
}

// Default `opencode run` subprocess runner (prompt via trailing argv positional; args
// array => execve, no shell => injection-safe under bypassPermissions).
function defaultRunExec({ bin, argv, env, cwd }) {
  return new Promise((resolve) => {
    const child = nodeSpawn(bin, argv, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
    child.on("error", (e) => resolve({ code: -1, stdout: out, stderr: String(e?.message || e) }));
  });
}

export class OpenCodeAdapter {
  constructor(opts = {}) {
    this.id = "opencode";
    this._fetch = opts.fetchImpl ?? defaultFetch;
    this._bootServer = opts.bootServer ?? null; // async (config) -> {baseUrl,password,proc,owns}
    this._runExec = opts.runExec ?? defaultRunExec;
    this._mode = opts.mode ?? "auto"; // "server" | "run" | "auto"
    this._pollMs = opts.pollMs ?? 250;
    this._bootTimeoutMs = opts.bootTimeoutMs ?? 20_000;
    this._pending = new WeakMap();
  }

  async spawn(config = {}) {
    if (this._mode === "run") {
      return { config, mode: "run", alive: true };
    }
    // server / auto: attach to a running server, or boot our own.
    try {
      const server = await this._resolveServer(config);
      const sessionID = await this._createSession(server, config);
      return {
        config,
        mode: "server",
        baseUrl: server.baseUrl,
        password: server.password,
        proc: server.proc ?? null,
        ownsServer: !!server.owns,
        sessionID,
        alive: true
      };
    } catch (err) {
      if (this._mode === "server") throw err;
      // auto: degrade to the stateless `opencode run` fallback.
      return { config, mode: "run", alive: true, degradedFrom: String(err?.message || err) };
    }
  }

  async _resolveServer(config) {
    if (config.attachUrl) {
      // Attach to an already-running server — we do NOT own it, so teardown won't kill it.
      return { baseUrl: config.attachUrl.replace(/\/$/, ""), password: config.serverPassword ?? null, proc: null, owns: false };
    }
    if (!this._bootServer) throw new Error("no server to attach to and no bootServer provided");
    const server = await this._bootServer(config);
    return { baseUrl: server.baseUrl.replace(/\/$/, ""), password: server.password ?? null, proc: server.proc ?? null, owns: server.owns !== false };
  }

  async _createSession(server, config) {
    if (config.sessionID) return config.sessionID; // resume path
    const res = await this._fetch(`${server.baseUrl}/session`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeader(server.password, config.serverUsername) },
      body: JSON.stringify({})
    });
    if (!res.ok) throw new Error(`POST /session failed: ${res.status}`);
    const body = await res.json();
    if (!body?.id) throw new Error("POST /session returned no session id");
    return body.id;
  }

  async awaitReady(session) {
    if (session.mode !== "server") return; // run mode has no persistent process
    const deadline = Date.now() + this._bootTimeoutMs;
    for (;;) {
      try {
        const res = await this._fetch(`${session.baseUrl}/global/health`, {
          headers: authHeader(session.password, session.config.serverUsername)
        });
        if (res.ok) {
          const h = await res.json();
          if (h?.healthy) return;
        }
      } catch {
        /* server still coming up */
      }
      if (Date.now() > deadline) throw new Error(`opencode server not healthy after ${this._bootTimeoutMs}ms`);
      await sleep(this._pollMs);
    }
  }

  async sendTurn(session, text) {
    if (session.mode === "run") {
      this._pending.set(session, this._runTurn(session, text));
    } else {
      this._pending.set(session, this._serverTurn(session, text));
    }
  }

  async awaitResponse(session) {
    const p = this._pending.get(session);
    if (!p) throw new Error("OpenCodeAdapter: awaitResponse without a pending sendTurn");
    this._pending.delete(session);
    return p;
  }

  // Stateless subprocess turn: `opencode run <options> <prompt>` (prompt as trailing
  // positional; NEVER in the static argv). Parses the NDJSON events for the final text.
  async _runTurn(session, text) {
    const { bin, argv } = buildRunArgs(session.config);
    const r = await this._runExec({
      bin,
      argv: [...argv, text],
      env: session.config.env ?? process.env,
      cwd: session.config.compositionDir
    });
    if (r.code !== 0) throw new Error(`opencode run exited ${r.code}: ${String(r.stderr).slice(0, 200)}`);
    return { text: parseRunJsonEvents(r.stdout ?? ""), artifacts: [] };
  }

  // HTTP turn against the standing server. Legacy send-and-await primary (carries
  // per-call model/variant); v2 prompt+wait+read on 404.
  async _serverTurn(session, text) {
    const headers = { "content-type": "application/json", ...authHeader(session.password, session.config.serverUsername) };
    const legacy = await this._fetch(`${session.baseUrl}/session/${session.sessionID}/message`, {
      method: "POST",
      headers,
      body: JSON.stringify(this._messageBody(session, text))
    });
    if (legacy.status !== 404) {
      if (!legacy.ok) throw new Error(`POST /session/{id}/message failed: ${legacy.status}`);
      return { text: extractAssistantText(await legacy.json()), artifacts: [] };
    }
    // Fallback: v2 prompt (fire-and-admit) -> wait (block to idle) -> read messages.
    const admit = await this._fetch(`${session.baseUrl}/api/session/${session.sessionID}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: { text } })
    });
    if (!admit.ok) throw new Error(`POST /api/session/{id}/prompt failed: ${admit.status}`);
    const waited = await this._fetch(`${session.baseUrl}/api/session/${session.sessionID}/wait`, { method: "POST", headers });
    if (!waited.ok && waited.status !== 204) throw new Error(`POST /api/session/{id}/wait failed: ${waited.status}`);
    const list = await this._fetch(`${session.baseUrl}/session/${session.sessionID}/message`, { headers });
    if (!list.ok) throw new Error(`GET /session/{id}/message failed: ${list.status}`);
    return { text: extractAssistantText(await list.json()), artifacts: [] };
  }

  _messageBody(session, text) {
    const body = { parts: [{ type: "text", text }] };
    const model = parseModel(session.config.model);
    if (model) body.model = model;
    if (session.config.effort) body.variant = session.config.effort;
    if (session.config.agent) body.agent = session.config.agent;
    return body;
  }

  async setModel(session, model) {
    session.config = { ...session.config, model };
  }

  async setEffort(session, effort) {
    session.config = { ...session.config, effort };
  }

  // Re-attach a prior conversation by session id (no new POST /session).
  async resume(config = {}) {
    return this.spawn({ ...config, sessionID: config.sessionID, resume: true });
  }

  async teardown(session) {
    session.alive = false;
    // Kill ONLY a server we spawned. Never kill one we merely attached to.
    if (session.mode === "server" && session.ownsServer && session.proc && typeof session.proc.kill === "function") {
      try {
        session.proc.kill("SIGTERM");
      } catch {
        /* best-effort */
      }
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
