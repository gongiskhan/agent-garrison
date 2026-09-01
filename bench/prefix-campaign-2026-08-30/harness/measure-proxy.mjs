#!/usr/bin/env node
// The measurement instrument for the benchmark campaign.
//
// Sits between a Claude Code session and api.anthropic.com and records one
// JSONL row per /v1/messages exchange: the model, how many tools the request
// carried, and the provider's own usage block off the response. Streaming
// responses report usage across two events - `message_start` carries input and
// cache tokens, `message_delta` carries the settled output count - so both are
// parsed and merged rather than trusting either alone.
//
//   usage: measure-proxy.mjs <port> <out.jsonl>
import http from "node:http";
import https from "node:https";
import fs from "node:fs";

const port = Number(process.argv[2]);
const out = process.argv[3];
if (!port || !out) { console.error("usage: measure-proxy.mjs <port> <out.jsonl>"); process.exit(2); }
fs.writeFileSync(out, "");

let seq = 0;

function usageFromBody(text) {
  // Non-streaming: one JSON object with a usage field.
  try {
    const j = JSON.parse(text);
    if (j?.usage) return {
      usage: j.usage, model: j.model ?? null, stop: j.stop_reason ?? null,
      blocks: (j.content ?? []).map((b) => (b?.type === "tool_use" || b?.type === "server_tool_use") ? `${b.type}:${b.name}` : b?.type),
    };
  } catch { /* streaming */ }
  // Streaming: merge message_start's input/cache with message_delta's output.
  let usage = null;
  let model = null;
  let stop = null;
  const blocks = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    let ev;
    try { ev = JSON.parse(line.slice(6)); } catch { continue; }
    if (ev.type === "message_start" && ev.message) {
      usage = { ...(ev.message.usage ?? {}) };
      model = ev.message.model ?? model;
    } else if (ev.type === "message_delta") {
      if (ev.usage) usage = { ...(usage ?? {}), ...ev.usage };
      stop = ev.delta?.stop_reason ?? stop;
    } else if (ev.type === "content_block_start" && ev.content_block?.type) {
      blocks.push(ev.content_block.type === "tool_use"
        ? `tool_use:${ev.content_block.name}`
        : ev.content_block.type === "server_tool_use"
          ? `server_tool_use:${ev.content_block.name}`
          : ev.content_block.type);
    }
  }
  return usage ? { usage, model, stop, blocks } : null;
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const started = Date.now();
    const n = seq++;
    let request = null;
    if (req.url.includes("/v1/messages") && !req.url.includes("count_tokens")) {
      try {
        const p = JSON.parse(body.toString("utf8"));
        request = {
          model: p.model ?? null,
          tools: Array.isArray(p.tools) ? p.tools.length : 0,
          deferred: Array.isArray(p.tools) ? p.tools.filter((t) => t.defer_loading).length : 0,
          messages: Array.isArray(p.messages) ? p.messages.length : 0,
          stream: p.stream === true,
        };
      } catch { /* not a messages call */ }
    }
    const up = https.request({
      hostname: "api.anthropic.com", port: 443, path: req.url, method: req.method,
      // Ask for identity encoding: a gzip/br body cannot be parsed for usage,
      // and the client is streaming SSE anyway so there is nothing to save.
      headers: { ...req.headers, host: "api.anthropic.com", "accept-encoding": "identity" },
    }, (ur) => {
      const outHeaders = { ...ur.headers };
      delete outHeaders["content-encoding"];
      res.writeHead(ur.statusCode ?? 502, outHeaders);
      const rc = [];
      ur.on("data", (c) => { rc.push(c); res.write(c); });
      ur.on("end", () => {
        res.end();
        if (!request) return;
        const raw = Buffer.concat(rc).toString("utf8");
        const got = usageFromBody(raw);
        fs.appendFileSync(out, `${JSON.stringify({
          n, at: new Date(started).toISOString(), ms: Date.now() - started,
          status: ur.statusCode, path: req.url, request,
          model: got?.model ?? request.model, stop: got?.stop ?? null,
          usage: got?.usage ?? null, blocks: got?.blocks ?? [],
          error: got ? null : raw.slice(0, 300),
        })}\n`);
      });
    });
    up.on("error", (e) => {
      fs.appendFileSync(out, `${JSON.stringify({ n, at: new Date(started).toISOString(), transportError: String(e.message) })}\n`);
      try { res.writeHead(502); res.end(); } catch { /* client gone */ }
    });
    if (body.length) up.write(body);
    up.end();
  });
});
server.listen(port, "127.0.0.1", () => console.log(`[measure] :${port} -> ${out}`));
