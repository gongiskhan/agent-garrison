// Same bytes, two models. The live decomposition showed the byte-identical
// Garrison prompt counting 33,493 tokens under haiku and 46,309 under
// sonnet-5, which is either a different tokenizer or a mistake in the split.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { countTexts } from "./count-sections.mjs";

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
  await import(path.join(REPO, "fittings", "seed", "agent-sdk-runtime", "lib", "agent-sdk-adapter.mjs"));
const cfg = { provider: "anthropic", model: "claude-haiku-4-5", promptMode: "lean", compositionDir: COMP,
  maxTurns: 1, permissionMode: "bypassPermissions", mcpServers: {}, strictMcpConfig: true, allowedTools: [] };
const adapter = new AgentSdkAdapter();
const s = await adapter.spawn({ ...cfg, fixedAssembly: resolveRoutedAgentSdkAssembly(cfg),
  env: { ...process.env, GARRISON_ANTHROPIC_PROXY_URL: proxyUrl }, secrets: {} });
await adapter.sendTurn(s, "ok", {});
await adapter.awaitResponse(s);

const text = fs.readFileSync(path.join(COMP, ".garrison", "assembled-system-prompt.md"), "utf8");
const sample = "The quick brown fox jumps over the lazy dog. ".repeat(200);
const out = {};
for (const model of ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5", "claude-opus-4-8"]) {
  const r = await countTexts({ headers: harvested, body: { model }, texts: { assembled: text, sample } });
  out[model] = r.sections;
  console.log(`${model.padEnd(20)} assembled=${String(r.sections.assembled.tokens).padStart(7)}  sample=${String(r.sections.sample.tokens).padStart(6)}`);
}
fs.writeFileSync(path.join(HERE, "decomposed", "tokenizer-ab.json"), JSON.stringify(out, null, 1));
server.close();
process.exit(0);
