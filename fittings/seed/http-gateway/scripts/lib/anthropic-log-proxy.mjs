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
import { runLog } from "@garrison/claude-pty";

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

function tryParse(buf) {
  const text = buf.toString("utf8");
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * Start the proxy on a loopback ephemeral port. Returns {url, close} — `url`
 * goes into ANTHROPIC_BASE_URL for the runtime spawn.
 */
export function startAnthropicLogProxy({ upstream = UPSTREAM } = {}) {
  const upstreamUrl = new URL(upstream);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const exchangeId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
        headers: { ...req.headers, host: upstreamUrl.hostname },
      }, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        const respChunks = [];
        upstreamRes.on("data", (c) => {
          respChunks.push(c);
          res.write(c); // stream through — capture never delays the turn
        });
        upstreamRes.on("end", () => {
          res.end();
          runLog()?.append({
            domain: "api",
            kind: "api-response",
            payload: {
              exchangeId,
              status: upstreamRes.statusCode,
              headers: loggableHeaders(upstreamRes.headers),
              body: tryParse(Buffer.concat(respChunks)),
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
