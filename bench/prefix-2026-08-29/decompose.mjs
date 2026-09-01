#!/usr/bin/env node
// Decompose REAL captured requests (the ones the gateway's logging proxy dumped
// during a live conversation) into per-section token counts.
//
// Credentials: one trivial SDK query is spawned through a local proxy purely to
// harvest a live set of auth headers in memory; they are reused for the free
// count_tokens calls and never written anywhere.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { countSections, countToolSubsets } from "./count-sections.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const FITTING = path.join(REPO, "fittings", "seed", "agent-sdk-runtime");
const COMP = path.join(REPO, "compositions", "default");
const CAP = path.join(HERE, "live-capture");
const OUT = path.join(HERE, "decomposed");
fs.mkdirSync(OUT, { recursive: true });

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
process.env.GARRISON_ANTHROPIC_PROXY_URL = proxyUrl;

const { AgentSdkAdapter, resolveRoutedAgentSdkAssembly } = await import(path.join(FITTING, "lib", "agent-sdk-adapter.mjs"));
const cfg = { provider: "anthropic", model: "claude-haiku-4-5", promptMode: "lean", compositionDir: COMP,
  maxTurns: 1, permissionMode: "bypassPermissions", mcpServers: {}, strictMcpConfig: true, allowedTools: [] };
const adapter = new AgentSdkAdapter();
const session = await adapter.spawn({ ...cfg, fixedAssembly: resolveRoutedAgentSdkAssembly(cfg),
  env: { ...process.env, GARRISON_ANTHROPIC_PROXY_URL: proxyUrl }, secrets: {} });
await adapter.sendTurn(session, "ok", {});
await adapter.awaitResponse(session);
if (!harvested) { console.error("no auth headers harvested"); process.exit(3); }
console.log("[decompose] harvested live auth headers");

const appendText = fs.readFileSync(path.join(COMP, ".garrison", "assembled-system-prompt.md"), "utf8");

// One decomposition per distinct model, using that model's LARGEST captured
// request (the small ones are the CLI's own title-generation calls).
const files = fs.readdirSync(CAP).filter((f) => f.endsWith(".request.json"));
const byModel = new Map();
for (const f of files) {
  const body = JSON.parse(fs.readFileSync(path.join(CAP, f), "utf8"));
  if (!Array.isArray(body.tools) || !body.tools.length) continue;
  const size = fs.statSync(path.join(CAP, f)).size;
  const cur = byModel.get(body.model);
  // Smallest tool-carrying request per model = the FIRST call of a stretch,
  // before any tool results have accumulated. That is the boot prefix.
  if (!cur || size < cur.size) byModel.set(body.model, { f, body, size });
}

const report = {};
for (const [model, { f, body }] of byModel) {
  console.log(`[decompose] ${model}  <- ${f}`);
  const sections = await countSections({ headers: harvested, body, appendText });
  const MEASURED = ["Bash", "Read", "Write", "Edit", "Agent", "ToolSearch", "TaskOutput", "AskUserQuestion"];
  const subsets = await countToolSubsets({ headers: harvested, body, subsets: {
    "measured-allowlist": MEASURED,
    "coding-core": ["Bash", "Read", "Write", "Edit"],
    "coding-plus-agent": ["Bash", "Read", "Write", "Edit", "Agent"],
    "mcp-only": body.tools.filter((t) => t.name.startsWith("mcp__")).map((t) => t.name),
  } });
  report[model] = { file: f, sections, toolSubsets: subsets, toolCount: body.tools.length,
    toolNames: body.tools.map((t) => t.name) };
  console.log(`   whole=${sections.sections.whole} system=${sections.sections.systemAll} tools=${sections.sections.toolsAll} messages=${sections.sections.messages}`);
}
fs.writeFileSync(path.join(OUT, "live-decomposition.json"), JSON.stringify(report, null, 1));
server.close();
console.log("[decompose] done");
process.exit(0);
