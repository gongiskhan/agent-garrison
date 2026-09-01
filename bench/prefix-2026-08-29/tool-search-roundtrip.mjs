#!/usr/bin/env node
// THE SPIKE THAT DECIDES THE ROUTE.
//
// The proxy can inject tool search into the outgoing body. The question is the
// RETURN path: the response carries `server_tool_use` and
// `tool_search_tool_result` blocks, and the conversation only continues if the
// Agent SDK passes them back unchanged on the next request. If it drops blocks
// it does not recognise, the API rejects the follow-up and the proxy route is
// dead - which is the honest trigger for a narrow direct-Messages lane.
//
// So: drive a REAL two-turn Agent SDK session through the shaping proxy, force
// a tool the model must search for, and read what the SECOND request contains.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shapeAnthropicRequest, describeToolSearchBlocks } from "../../fittings/seed/http-gateway/scripts/lib/anthropic-request-shaper.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const COMP = path.join(REPO, "compositions", "default");
const OUT = path.join(HERE, "roundtrip");
fs.mkdirSync(OUT, { recursive: true });

const KEEP = (process.env.KEEP_LOADED ?? "Bash,Read,Write,Edit").split(",").filter(Boolean);
const shape = { cacheTtl: "1h", toolSearch: { variant: "regex", keepLoaded: KEEP } };

const exchanges = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = Buffer.concat(chunks);
    let sent = null;
    let changes = null;
    if (req.url.includes("/v1/messages") && !req.url.includes("count_tokens")) {
      try {
        const parsed = JSON.parse(body.toString("utf8"));
        const r = shapeAnthropicRequest(parsed, shape);
        changes = r.changes;
        sent = r.body;
        body = Buffer.from(JSON.stringify(r.body));
      } catch { /* forward untouched */ }
    }
    const up = https.request({
      hostname: "api.anthropic.com", port: 443, path: req.url, method: req.method,
      headers: { ...req.headers, host: "api.anthropic.com", "content-length": String(body.length) },
    }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      const rc = [];
      ur.on("data", (c) => { rc.push(c); res.write(c); });
      ur.on("end", () => {
        res.end();
        const raw = Buffer.concat(rc).toString("utf8");
        if (sent) {
          exchanges.push({
            n: exchanges.length,
            status: ur.statusCode,
            changes,
            // What the SDK HANDED US this turn - the evidence for round-tripping.
            sentMessages: (sent.messages ?? []).map((m) => ({
              role: m.role,
              blocks: Array.isArray(m.content) ? m.content.map((b) => b?.type) : typeof m.content,
            })),
            toolCount: (sent.tools ?? []).length,
            deferred: (sent.tools ?? []).filter((t) => t.defer_loading).length,
            responseHead: raw.slice(0, 400),
            // What came BACK, so a search that happened is visible even if the
            // SDK then drops it on the next request.
            responseBlocks: (() => {
              try { return (JSON.parse(raw).content ?? []).map((b) => b?.type); }
              catch { return raw.split("\n").filter((l) => l.startsWith("data: ")).map((l) => { try { return JSON.parse(l.slice(6))?.content_block?.type; } catch { return null; } }).filter(Boolean); }
            })(),
          });
        }
      });
    });
    up.on("error", (e) => { try { res.writeHead(502); res.end(String(e.message)); } catch {} });
    if (body.length) up.write(body);
    up.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const proxyUrl = `http://127.0.0.1:${server.address().port}`;
console.log(`[spike] proxy ${proxyUrl}  keepLoaded=${KEEP.join(",")}`);

const { AgentSdkAdapter, resolveRoutedAgentSdkAssembly } =
  await import(path.join(REPO, "fittings/seed/agent-sdk-runtime/lib/agent-sdk-adapter.mjs"));

const cfg = {
  provider: "anthropic",
  model: process.env.PROBE_MODEL || "claude-haiku-4-5",
  promptMode: "full",
  compositionDir: COMP,
  maxTurns: 6,
  permissionMode: "bypassPermissions",
  mcpServers: {},
  strictMcpConfig: true,
  allowedTools: [],
  // The shared block, minus the tools we keep loaded, so the model MUST search.
  tools: ["Bash", "Read", "Write", "Edit", "Agent", "TaskOutput", "AskUserQuestion"],
};
const adapter = new AgentSdkAdapter();
const usage = [];
let reply = "";
let err = null;
try {
  const session = await adapter.spawn({
    ...cfg,
    fixedAssembly: resolveRoutedAgentSdkAssembly(cfg),
    env: { ...process.env, GARRISON_ANTHROPIC_PROXY_URL: proxyUrl },
    secrets: {},
  });
  // A prompt that needs a tool NOT in keepLoaded, so search is the only route.
  await adapter.sendTurn(
    session,
    process.env.SPIKE_PROMPT ??
      "Run the shell command `echo garrison-roundtrip-ok` and tell me exactly what it printed. " +
      "You must actually run it. If you have no tool for running shell commands, search for one first.",
    { onUsage: (r) => usage.push(r) }
  );
  reply = await adapter.awaitResponse(session);
} catch (e) {
  err = String(e?.stack ?? e?.message ?? e);
}

fs.writeFileSync(path.join(OUT, "exchanges.json"), JSON.stringify(exchanges, null, 1));
console.log(`\n[spike] ${exchanges.length} request(s) through the proxy`);
for (const x of exchanges) {
  console.log(`  #${x.n} http=${x.status} tools=${x.toolCount} deferred=${x.deferred} ttl=${JSON.stringify(x.changes?.cacheTtl)} search=${JSON.stringify(x.changes?.toolSearch?.deferred ?? null)}`);
  for (const m of x.sentMessages) console.log(`       sent ${m.role}: ${JSON.stringify(m.blocks)}`);
  console.log(`       got: ${JSON.stringify([...new Set(x.responseBlocks ?? [])])}`);
  if (x.status !== 200) console.log(`       BODY ${x.responseHead}`);
}
const sawSearch = exchanges.some((x) => x.sentMessages.some((m) => m.blocks.includes?.("server_tool_use") || m.blocks.includes?.("tool_search_tool_result")));
console.log(`\n[spike] SDK sent tool-search blocks back on a later request: ${sawSearch ? "YES - the proxy route works" : "NO"}`);
console.log(`[spike] every request returned 200: ${exchanges.every((x) => x.status === 200)}`);
console.log(`[spike] reply: ${JSON.stringify(reply?.reply ?? reply).slice(0, 300)}`);
if (err) console.log(`[spike] ERROR ${err.slice(0, 600)}`);
server.close();
process.exit(0);
