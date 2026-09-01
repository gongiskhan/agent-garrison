// Does tool search actually work on the models Garrison routes to, and what
// does the prefix cost with it on? The compatibility table on
// platform.claude.com lists Sonnet 4.6 and Haiku 4.5 but NOT claude-sonnet-5,
// which is the model two of our duties run on - so this asks the API instead of
// believing the table either way.
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
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
const cfg = { provider: "anthropic", model: "claude-haiku-4-5", promptMode: "lean",
  compositionDir: path.join(REPO, "compositions", "default"), maxTurns: 1,
  permissionMode: "bypassPermissions", mcpServers: {}, strictMcpConfig: true, allowedTools: [] };
const adapter = new AgentSdkAdapter();
const s = await adapter.spawn({ ...cfg, fixedAssembly: resolveRoutedAgentSdkAssembly(cfg),
  env: { ...process.env, GARRISON_ANTHROPIC_PROXY_URL: proxyUrl }, secrets: {} });
await adapter.sendTurn(s, "ok", {});
await adapter.awaitResponse(s);
if (!harvested) { console.error("no auth harvested"); process.exit(3); }

const KEEP = ["authorization", "x-api-key", "anthropic-version", "anthropic-beta", "user-agent"];
const h = {}; for (const k of KEEP) if (harvested[k]) h[k] = harvested[k];

function post(pathname, body, extraHeaders = {}) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = https.request({ hostname: "api.anthropic.com", port: 443, path: pathname, method: "POST",
      headers: { ...h, ...extraHeaders, "content-type": "application/json", "content-length": payload.length, "accept-encoding": "identity" } },
      (res) => { const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString("utf8") })); });
    req.on("error", (e) => resolve({ status: 0, body: String(e.message) }));
    req.write(payload); req.end();
  });
}

// Ten fat fake tools, so the with/without difference is unmistakable.
const fat = (i) => ({
  name: `garrison_fake_tool_${i}`,
  description: `A deliberately verbose tool description number ${i}. ${"It exists purely to occupy tokens in the tools array so the difference between an inlined schema and a deferred one is measurable. ".repeat(6)}`,
  input_schema: { type: "object", properties: Object.fromEntries(
    Array.from({ length: 8 }, (_, j) => [`argument_number_${j}`, { type: "string", description: `Argument ${j}: ${"a long argument description that also costs tokens. ".repeat(4)}` }])), required: [] },
});
const TOOLS = Array.from({ length: 10 }, (_, i) => fat(i));
const SEARCH = { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" };
const msgs = [{ role: "user", content: "hello" }];

for (const model of ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"]) {
  // count_tokens rejects server tools ("Use the /v1/messages endpoint instead"),
  // so both sides are measured on a real 1-token completion and read off usage.
  const plain = await post("/v1/messages", { model, max_tokens: 1, messages: msgs, tools: TOOLS });
  const deferred = await post("/v1/messages", { model, max_tokens: 1, messages: msgs,
    tools: [SEARCH, ...TOOLS.map((t) => ({ ...t, defer_loading: true }))] });
  const p = (r) => { try { const j = JSON.parse(r.body); const u = j.usage; return u ? (u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)) : `HTTP ${r.status} ${JSON.stringify(j).slice(0, 230)}`; } catch { return `HTTP ${r.status}: ${r.body.slice(0, 230)}`; } };
  console.log(`${model}\n   inlined  = ${p(plain)}\n   deferred = ${p(deferred)}`);
}
server.close();
process.exit(0);
