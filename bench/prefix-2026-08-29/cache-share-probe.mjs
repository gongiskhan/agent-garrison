// Two byte-identical requests, back to back, in separate processes' worth of
// separation. Does the second READ the first's 1-hour cache write?
//
// Everything else is controlled: same tools array, same system blocks, same
// breakpoints. If this reads, cross-stretch sharing works and whatever blocks
// it lives in the gateway path. If it does not, the 1h write is not shareable
// the way the docs describe and the whole lever is void.
import http from "node:http";
import https from "node:https";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const COMP = path.join(REPO, "compositions", "default");

let harvested = null;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (!harvested && req.url.includes("/v1/messages")) harvested = req.headers;
    const body = Buffer.concat(chunks);
    const up = https.request({ hostname: "api.anthropic.com", port: 443, path: req.url, method: req.method,
      headers: { ...req.headers, host: "api.anthropic.com" } }, (ur) => { res.writeHead(ur.statusCode ?? 502, ur.headers); ur.pipe(res); });
    up.on("error", () => { try { res.writeHead(502); res.end(); } catch {} });
    if (body.length) up.write(body);
    up.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const proxyUrl = `http://127.0.0.1:${server.address().port}`;
const { AgentSdkAdapter, resolveRoutedAgentSdkAssembly } =
  await import(path.join(REPO, "fittings/seed/agent-sdk-runtime/lib/agent-sdk-adapter.mjs"));
const cfg = { provider: "anthropic", model: "claude-haiku-4-5", promptMode: "lean", compositionDir: COMP,
  maxTurns: 1, permissionMode: "bypassPermissions", mcpServers: {}, strictMcpConfig: true, allowedTools: [] };
const adapter = new AgentSdkAdapter();
const s = await adapter.spawn({ ...cfg, fixedAssembly: resolveRoutedAgentSdkAssembly(cfg),
  env: { ...process.env, GARRISON_ANTHROPIC_PROXY_URL: proxyUrl }, secrets: {} });
await adapter.sendTurn(s, "ok", {});
await adapter.awaitResponse(s);
server.close();
if (!harvested) { console.error("no auth"); process.exit(3); }
const KEEP = ["authorization", "x-api-key", "anthropic-version", "anthropic-beta", "user-agent"];
const h = {}; for (const k of KEEP) if (harvested[k]) h[k] = harvested[k];

function post(body, extra = {}) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = https.request({ hostname: "api.anthropic.com", port: 443, path: "/v1/messages", method: "POST",
      headers: { ...h, ...extra, "content-type": "application/json", "content-length": payload.length, "accept-encoding": "identity" } },
      (res) => { const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString("utf8") })); });
    req.on("error", (e) => resolve({ status: 0, body: String(e.message) }));
    req.write(payload); req.end();
  });
}

// A system prompt comfortably over every model's minimum cacheable length.
const big = fs.readFileSync(path.join(COMP, ".garrison", "assembled-system-prompt.md"), "utf8");
const marker = process.env.MARKER ?? "cache-share-probe-v1";
// The gateway's real shape: a tools array (some of it deferred behind tool
// search) and TWO system breakpoints, not one.
const TOOLS = [
  { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
  ...["Bash", "Read", "Write", "Edit"].map((n) => ({ name: n, description: `the ${n} tool`, input_schema: { type: "object", properties: { x: { type: "string" } } } })),
  ...["Agent", "TaskOutput", "AskUserQuestion"].map((n) => ({ name: n, description: `the ${n} tool`, input_schema: { type: "object", properties: { x: { type: "string" } } }, defer_loading: true })),
];
const mk = (ttl, userText, withTools, sessionId) => ({
  model: process.env.PROBE_MODEL || "claude-haiku-4-5",
  max_tokens: 1,
  // The gateway sends this on every request; the session id inside it is stable
  // WITHIN a stretch and different BETWEEN stretches - the exact shape of the
  // observed "reads inside a stretch, never across" behaviour.
  ...(sessionId ? { metadata: { user_id: JSON.stringify({ device_id: "probe-device", account_uuid: "", session_id: sessionId }) } } : {}),
  ...(withTools ? { tools: TOOLS } : {}),
  system: [
    { type: "text", text: "x-anthropic-billing-header-lookalike", },
    { type: "text", text: marker, cache_control: { type: "ephemeral", ...(ttl ? { ttl } : {}) } },
    { type: "text", text: big, cache_control: { type: "ephemeral", ...(ttl ? { ttl } : {}) } },
  ],
  messages: [{ role: "user", content: userText }],
});

const read = (r) => { try { const u = JSON.parse(r.body).usage; return u ? `write5m=${u.cache_creation?.ephemeral_5m_input_tokens ?? 0} write1h=${u.cache_creation?.ephemeral_1h_input_tokens ?? 0} read=${u.cache_read_input_tokens ?? 0} input=${u.input_tokens}` : `HTTP ${r.status} ${r.body.slice(0, 200)}`; } catch { return `HTTP ${r.status} ${r.body.slice(0, 200)}`; } };

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
for (const [label, idA, idB] of [
  ["no metadata at all", null, null],
  ["SAME session_id (one stretch, two calls)", S1, S1],
  ["DIFFERENT session_id (two stretches)", S1, S2],
]) {
  console.log(`\n=== ${label} ===`);
  const a = await post(mk("1h", `first ${label}`, true, idA));
  console.log("  1st:", read(a));
  const b = await post(mk("1h", `second, entirely different tail ${label}`, true, idB));
  console.log("  2nd:", read(b));
}
process.exit(0);
