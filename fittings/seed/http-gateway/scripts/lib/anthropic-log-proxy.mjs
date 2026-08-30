// Logging proxy for exact model-visible truth (Harness brief §2).
//
// The SDK assembles the final API request internally, so the adapter-level log
// captures what Garrison SENT, not the literal bytes Anthropic received. This
// loopback proxy sits between the SDK and the API (both Claude Code and the
// Agent SDK honor a custom base URL): it forwards verbatim and appends the
// literal request and response to the SAME session log as api-domain events.
// Audit and governance, not replay: deterministic re-execution is out of scope.
//
// Off by default (config `session_log_proxy` on the http-gateway fitting).
// Payloads are capped by the log's own truncation discipline; response bodies
// stream through untouched — capture never delays the turn.

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { runLog } from "@garrison/claude-pty";
import { shapeAnthropicRequest, describeToolSearchBlocks } from "./anthropic-request-shaper.mjs";

const UPSTREAM = "https://api.anthropic.com";
// Never persist credentials: these headers are dropped from the logged copy
// (the forwarded request keeps them, obviously).
const REDACT_HEADERS = new Set(["authorization", "x-api-key", "cookie", "proxy-authorization"]);

function loggableHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    out[k.toLowerCase()] = REDACT_HEADERS.has(k.toLowerCase()) ? "[redacted]" : v;
  }
  return out;
}

// The session log caps payloads, which is right for a log and useless for
// auditing a 150k-character system prompt. GARRISON_ANTHROPIC_PROXY_DUMP=<dir>
// additionally writes each request body whole, exactly as sent. Bodies only:
// headers (and therefore credentials) never reach the dump.
function dumpDir() {
  const dir = String(process.env.GARRISON_ANTHROPIC_PROXY_DUMP ?? "").trim();
  if (!dir) return null;
  try { fs.mkdirSync(dir, { recursive: true }); return dir; } catch { return null; }
}

function tryParse(buf) {
  const text = buf.toString("utf8");
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * Start the proxy on a loopback ephemeral port. Returns {url, close} — `url`
 * goes into ANTHROPIC_BASE_URL for the runtime spawn.
 */
/**
 * Start the proxy on a loopback ephemeral port. Returns {url, close} - `url`
 * goes into ANTHROPIC_BASE_URL for the runtime spawn.
 *
 * `shape` turns the proxy from an observer into the one seam where Garrison can
 * set request fields the Agent SDK does not expose: the cache TTL that decides
 * whether six stretches share one prefix or write it six times, and deferred
 * tool loading. Off unless configured; when on, every rewrite is logged beside
 * the request it changed.
 */
export function startAnthropicLogProxy({ upstream = UPSTREAM, shape = null } = {}) {
  const upstreamUrl = new URL(upstream);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      const exchangeId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

      // Rewrite BEFORE logging and before forwarding, so the log records what
      // was actually sent rather than what the SDK handed us.
      let shaped = null;
      if (shape && req.url.includes("/v1/messages") && !req.url.includes("count_tokens")) {
        try {
          const parsed = JSON.parse(body.toString("utf8"));
          const result = shapeAnthropicRequest(parsed, shape);
          if (result.changes.cacheTtl || result.changes.toolSearch) {
            body = Buffer.from(JSON.stringify(result.body));
            shaped = result.changes;
          }
        } catch {
          // An unparseable body is forwarded untouched. Shaping is an
          // optimisation; it must never be the reason a turn fails.
        }
      }
      if (shaped) {
        runLog()?.append({ domain: "api", kind: "api-request-shaped", payload: { exchangeId, ...shaped } });
      }
      const dir = dumpDir();
      if (dir && req.url.includes("/v1/messages")) {
        try {
          fs.writeFileSync(path.join(dir, `${exchangeId}.request.json`), body.toString("utf8"));
        } catch { /* a dump is diagnostics; never fail the turn over it */ }
      }
      runLog()?.append({
        domain: "api",
        kind: "api-request",
        payload: {
          exchangeId,
          method: req.method,
          path: req.url,
          headers: loggableHeaders(req.headers),
          body: tryParse(body),
        },
      });

      const upstreamReq = https.request({
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || 443,
        path: req.url,
        method: req.method,
        // content-length is recomputed: a shaped body is a different length,
        // and a stale header truncates the request into a 400.
        headers: { ...req.headers, host: upstreamUrl.hostname, "content-length": String(body.length) },
      }, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        const respChunks = [];
        upstreamRes.on("data", (c) => {
          respChunks.push(c);
          res.write(c); // stream through — capture never delays the turn
        });
        upstreamRes.on("end", () => {
          res.end();
          const parsedResponse = tryParse(Buffer.concat(respChunks));
          const blocks = describeToolSearchBlocks(parsedResponse);
          if (blocks.serverToolUse.length || blocks.searchResults.length) {
            runLog()?.append({ domain: "api", kind: "api-tool-search", payload: { exchangeId, ...blocks } });
          }
          runLog()?.append({
            domain: "api",
            kind: "api-response",
            payload: {
              exchangeId,
              status: upstreamRes.statusCode,
              headers: loggableHeaders(upstreamRes.headers),
              body: parsedResponse,
            },
          });
        });
      });
      upstreamReq.on("error", (err) => {
        runLog()?.append({ domain: "api", kind: "api-error", payload: { exchangeId, error: String(err?.message ?? err) } });
        try { res.writeHead(502); res.end(JSON.stringify({ error: "upstream error" })); } catch {}
      });
      upstreamReq.end(body);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
