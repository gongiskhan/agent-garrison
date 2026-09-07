// Bounded HTTP primitives for the standalone Jarvis fitting. No host state is
// touched on import; production and ephemeral tests use the same transport.
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

export class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function jsonRes(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
function trustedHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host.endsWith(".ts.net")) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return isIP(host) === 6 && /^(?:f[cd]|fe[89ab])/i.test(host);
}
export function originAllowed(req) {
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  if (req.headers.origin === undefined) return true;
  try {
    const source = new URL(req.headers.origin);
    const target = new URL(`http://${req.headers.host || ""}`);
    return /^https?:$/.test(source.protocol) && source.origin === req.headers.origin &&
      source.host.toLowerCase() === target.host.toLowerCase() && trustedHost(target.hostname);
  } catch { return false; }
}
export function validatePost(req, audio = false) {
  if (!originAllowed(req)) throw new RequestError(403, "same-host Origin required");
  const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (audio ? !(type.startsWith("audio/") || type === "application/octet-stream") : type !== "application/json") {
    throw new RequestError(415, audio ? "audio Content-Type required" : "application/json required");
  }
  if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") throw new RequestError(415, "encoded body not supported");
}
export function readBody(req, { limit = 256 * 1024, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    let bytes = 0, chunks = [], settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); chunks = [];
      req.off("data", data); req.off("end", end); req.off("error", failed); req.off("aborted", aborted);
      if (error) { req.once("error", () => {}); req.resume(); reject(error); } else resolve(value);
    };
    const data = (chunk) => { bytes += chunk.length; if (bytes > limit) finish(new RequestError(413, "request body too large")); else chunks.push(chunk); };
    const end = () => finish(null, Buffer.concat(chunks));
    const failed = () => finish(new RequestError(400, "request body failed"));
    const aborted = () => finish(new RequestError(400, "request aborted"));
    const timer = setTimeout(() => finish(new RequestError(408, "request body timed out")), timeoutMs); timer.unref();
    req.on("data", data); req.once("end", end); req.once("error", failed); req.once("aborted", aborted);
    if (Number(req.headers["content-length"]) > limit) finish(new RequestError(413, "request body too large"));
    else if (req.aborted || req.destroyed) aborted();
  });
}
function transport(target) {
  if (target.protocol === "https:") return https;
  if (target.protocol === "http:") return http;
  throw new RequestError(502, "unsupported upstream protocol");
}
export function proxyResponse(res, target, { method = "GET", body, headers = {}, timeoutMs = 15_000,
  maxBytes = 2 * 1024 * 1024, sse = false, headersTimeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let upstream, response, settled = false, bytes = 0;
    const finish = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(headerTimer);
      res.off("close", clientClose); res.off("finish", done);
      if (error) {
        response?.destroy(); upstream?.destroy();
        if (res.headersSent) { res.destroy(); resolve(); } else reject(error);
      } else resolve();
    };
    const done = () => finish();
    const clientClose = () => { if (!res.writableFinished) { response?.destroy(); upstream?.destroy(); } finish(); };
    const timer = setTimeout(() => finish(new RequestError(504, "upstream deadline exceeded")), timeoutMs); timer.unref();
    const headerTimer = setTimeout(() => finish(new RequestError(504, "upstream did not respond")), Math.min(headersTimeoutMs, timeoutMs)); headerTimer.unref();
    res.once("close", clientClose); res.once("finish", done);
    try {
      if (res.destroyed) return clientClose();
      const requestHeaders = { ...headers };
      if (body !== undefined) requestHeaders["Content-Length"] = Buffer.byteLength(body);
      upstream = transport(target).request(target, { method, headers: requestHeaders }, (up) => {
        response = up; clearTimeout(headerTimer);
        if (Number(up.headers["content-length"]) > maxBytes) return finish(new RequestError(502, "upstream response too large"));
        res.statusCode = up.statusCode || 502;
        res.setHeader("Content-Type", up.headers["content-type"] || (sse ? "text/event-stream" : "application/json"));
        res.setHeader("Cache-Control", sse ? "no-cache, no-transform" : "no-store");
        if (sse) res.setHeader("X-Accel-Buffering", "no");
        up.on("data", (chunk) => { bytes += chunk.length; if (bytes > maxBytes) finish(new RequestError(502, "upstream response too large")); });
        up.once("aborted", () => finish(new RequestError(502, "upstream response interrupted")));
        up.once("error", () => finish(new RequestError(502, "upstream response failed")));
        up.pipe(res); // Node's pipe provides backpressure; no unbounded SSE queue.
      });
      upstream.once("error", () => finish(new RequestError(502, "upstream unavailable")));
      upstream.end(body);
    } catch (error) { finish(error instanceof RequestError ? error : new RequestError(503, "upstream unavailable")); }
  });
}
export function fetchJson(base, subpath, timeoutMs = 2500, maxBytes = 1024 * 1024) {
  return new Promise((resolve) => {
    let req, up, settled = false, bytes = 0, chunks = [];
    const finish = (value) => {
      if (settled) return; settled = true; clearTimeout(timer); chunks = [];
      up?.destroy(); req?.destroy(); resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs); timer.unref();
    try {
      const target = new URL(subpath, base);
      req = transport(target).get(target, { headers: { Accept: "application/json" } }, (response) => {
        up = response;
        if (up.statusCode !== 200 || Number(up.headers["content-length"]) > maxBytes) return finish(null);
        up.on("data", (chunk) => { bytes += chunk.length; if (bytes > maxBytes) finish(null); else chunks.push(chunk); });
        up.once("end", () => { try { finish(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { finish(null); } });
        up.once("error", () => finish(null)); up.once("aborted", () => finish(null));
      });
      req.once("error", () => finish(null));
    } catch { finish(null); }
  });
}
