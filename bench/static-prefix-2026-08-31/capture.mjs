// capture.mjs — what actually differs in the cached region between two runs.
//
// The prefix cache hashes tools -> system -> messages, so ANY byte that varies
// between two stretches forks it and every run starts cold. This captures the
// literal /v1/messages body the SDK sends, for several cwds, so the diff is
// over what was really on the wire rather than over what we believe is there.
//
// Usage: node capture.mjs <label>=<cwd> [<label>=<cwd> ...]
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shapeAnthropicRequest } from "../../fittings/seed/http-gateway/scripts/lib/anthropic-request-shaper.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const FITTING = path.join(REPO, "fittings", "seed", "agent-sdk-runtime");
const COMP = path.join(REPO, "compositions", "default");
const OUT = path.join(HERE, process.env.CAPTURE_OUT || "capture");
fs.mkdirSync(OUT, { recursive: true });

const { AgentSdkAdapter, resolveRoutedAgentSdkAssembly } =
  await import(path.join(FITTING, "lib", "agent-sdk-adapter.mjs"));

// The deployed shape: 1h TTL on the system breakpoints, every tool deferred.
// The deployed shape. STATIC_PREFIX=0 captures the pre-fix body for comparison.
const SHAPE = {
  cacheTtl: "1h",
  toolSearch: { variant: "regex", keepLoaded: [] },
  ...(/^(0|false|no|off)$/i.test(String(process.env.STATIC_PREFIX ?? "")) ? {} : { staticPrefix: true }),
};

const captures = [];
function startProxy() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      let parsed = null;
      try { parsed = JSON.parse(body.toString("utf8")); } catch { /* not json */ }
      if (parsed && req.url.includes("/v1/messages") && !req.url.includes("count_tokens")) {
        const r = shapeAnthropicRequest(parsed, SHAPE);
        parsed = r.body;
        body = Buffer.from(JSON.stringify(r.body));
        captures.push({ at: captures.length, body: parsed });
      }
      const up = https.request({
        hostname: "api.anthropic.com", port: 443, path: req.url, method: req.method,
        headers: { ...req.headers, host: "api.anthropic.com", "content-length": String(body.length) },
      }, (ur) => { res.writeHead(ur.statusCode ?? 502, ur.headers); ur.pipe(res); });
      up.on("error", (e) => { try { res.writeHead(502); res.end(String(e.message)); } catch {} });
      if (body.length) up.write(body);
      up.end();
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close(),
  })));
}

const append = fs.readFileSync(path.join(COMP, ".garrison", "assembled-system-prompt.md"), "utf8");
const mcp = JSON.parse(fs.readFileSync(path.join(COMP, ".garrison", "mcp.json"), "utf8")).mcpServers;
const model = process.env.PROBE_MODEL || "claude-haiku-4-5";

const targets = process.argv.slice(2).map((a) => {
  const i = a.indexOf("=");
  return { label: a.slice(0, i), cwd: a.slice(i + 1) };
});
if (!targets.length) { console.error("usage: capture.mjs <label>=<cwd> ..."); process.exit(1); }

const proxy = await startProxy();
console.log(`[capture] proxy ${proxy.url} model=${model}`);

for (const { label, cwd } of targets) {
  const before = captures.length;
  const cfg = {
    provider: "anthropic",
    model,
    promptMode: "full",
    appendSystemPrompt: append,
    compositionDir: cwd,
    maxTurns: 1,
    permissionMode: "bypassPermissions",
    mcpServers: mcp,
    strictMcpConfig: true,
    allowedTools: [],
  };
  const assembly = resolveRoutedAgentSdkAssembly(cfg);
  const adapter = new AgentSdkAdapter();
  const usage = [];
  let err = null;
  try {
    const session = await adapter.spawn({
      ...cfg,
      fixedAssembly: assembly,
      env: { ...process.env, GARRISON_ANTHROPIC_PROXY_URL: proxy.url },
      secrets: {},
    });
    await adapter.sendTurn(session, "Reply with the single word: ok", { onUsage: (row) => usage.push(row) });
    await adapter.awaitResponse(session);
    await adapter.teardown?.(session);
  } catch (e) {
    err = String(e?.message ?? e);
  }
  const reqs = captures.slice(before);
  // The CLI fires a small title-generation call first; the turn's real request
  // is the one carrying the tool inventory.
  const real = [...reqs].reverse().find((c) => Array.isArray(c.body?.tools) && c.body.tools.length) ?? reqs[reqs.length - 1];
  if (real) fs.writeFileSync(path.join(OUT, `${label}.json`), JSON.stringify(real.body, null, 1));
  // The billed prefix of the FIRST call: what it had to write against what it
  // could read is the whole question.
  const first = usage.find((u) => u.source === "assistant") ?? usage[0] ?? null;
  const u = first?.usage ?? {};
  console.log(
    `[capture] ${label.padEnd(14)} reqs=${reqs.length} in=${u.input_tokens ?? "-"} ` +
    `write=${u.cache_creation_input_tokens ?? "-"} read=${u.cache_read_input_tokens ?? "-"}` +
    `${err ? "  ERROR " + err : ""}  cwd=${cwd}`
  );
}
proxy.close();
process.exit(0);
