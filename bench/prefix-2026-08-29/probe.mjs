// probe.mjs - Task 1, boot-prefix decomposition.
//
// Two measurements at once, from the SAME spawn:
//
//   Route A: a loopback proxy between the SDK and api.anthropic.com captures the
//            LITERAL request body, so the assembled system blocks and tool
//            schemas can be counted section by section rather than guessed at.
//   Route B: the first API call's usage (input + cache_creation + cache_read)
//            is the billed prefix, which every Route A number must reconcile to.
//
// The assembly comes from the real resolveRoutedAgentSdkAssembly, not a
// hand-written approximation, so a probe is the same object a stretch spawns.
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
const OUT = path.join(HERE, "capture");
fs.mkdirSync(OUT, { recursive: true });

const { AgentSdkAdapter, resolveRoutedAgentSdkAssembly } =
  await import(path.join(FITTING, "lib", "agent-sdk-adapter.mjs"));

// ---------------------------------------------------------------- the proxy
const captures = [];
const SHAPE = process.argv.includes("--tool-search")
  ? { cacheTtl: "1h", toolSearch: { variant: "regex", keepLoaded: (process.env.KEEP_LOADED ?? "Bash,Read,Write,Edit").split(",").filter(Boolean) } }
  : null;
function startProxy() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      let parsed = null;
      try { parsed = JSON.parse(body.toString("utf8")); } catch { /* not json */ }
      // Optional: shape the request exactly as the gateway's proxy would, so a
      // probe measures the deployed configuration rather than a hypothetical.
      if (parsed && SHAPE && req.url.includes("/v1/messages") && !req.url.includes("count_tokens")) {
        const r = shapeAnthropicRequest(parsed, SHAPE);
        parsed = r.body;
        body = Buffer.from(JSON.stringify(r.body));
      }
      if (parsed && req.url.includes("/v1/messages")) {
        // Headers stay in memory for the counting pass and are never written out.
        captures.push({ at: captures.length, path: req.url, body: parsed, headers: req.headers });
      }
      const up = https.request({
        hostname: "api.anthropic.com", port: 443, path: req.url, method: req.method,
        headers: { ...req.headers, host: "api.anthropic.com", "content-length": String(body.length) },
      }, (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
      });
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

// ------------------------------------------------------------- the probes
const append = fs.readFileSync(path.join(COMP, ".garrison", "assembled-system-prompt.md"), "utf8");
const mcp = JSON.parse(fs.readFileSync(path.join(COMP, ".garrison", "mcp.json"), "utf8")).mcpServers;

const BUILTIN = ["Bash","Read","Write","Edit","MultiEdit","Glob","Grep","LS","WebFetch","WebSearch","Task","TodoWrite","NotebookEdit","BashOutput","KillBash","Skill"];
const READ_ONLY = ["Read","Grep","Glob","Bash"];

// Each probe changes exactly ONE thing from the `full` baseline, so a diff of
// two prefixes attributes tokens to that one component.
const PROBES = {
  "full-baseline":   {},
  "no-mcp":          { mcpServers: {} },
  "no-append":       { appendSystemPrompt: null },
  "lean":            { promptMode: "lean" },
  "readonly-tools":  { disallowedTools: BUILTIN.filter((t) => !READ_ONLY.includes(t)) },
  "no-tools":        { disallowedTools: BUILTIN },
  "bare":            { promptMode: "lean", mcpServers: {}, appendSystemPrompt: null },
  // The post-Task-2 shapes: a measured tool allow-list, and the garrison MCP
  // server narrowed to the one tool the trimmed capability catalogue needs.
  "after-code":      { tools: ["Bash", "Read", "Write", "Edit", "Agent"], narrowMcp: ["garrison_capability_doc"] },
  "after-read":      { tools: ["Bash", "Read", "Write"], mcpServers: {} },
  "after-read-ask":  { tools: ["Bash", "Read", "Write", "AskUserQuestion"], mcpServers: {} },
};

const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const model = process.env.PROBE_MODEL || "claude-haiku-4-5";

const proxy = await startProxy();
process.env.GARRISON_ANTHROPIC_PROXY_URL = proxy.url;
console.log(`[probe] proxy ${proxy.url}  model=${model}`);

const results = [];
for (const [name, override] of Object.entries(PROBES)) {
  if (only.length && !only.includes(name)) continue;
  const before = captures.length;
  const cfg = {
    provider: "anthropic",
    model,
    promptMode: "full",
    appendSystemPrompt: append,
    compositionDir: COMP,
    maxTurns: 1,
    permissionMode: "bypassPermissions",
    mcpServers: mcp,
    strictMcpConfig: true,
    allowedTools: [],
    ...override,
  };
  if (cfg.appendSystemPrompt === null) delete cfg.appendSystemPrompt;
  if (Array.isArray(cfg.narrowMcp)) {
    const allow = cfg.narrowMcp.join(",");
    cfg.mcpServers = Object.fromEntries(Object.entries(cfg.mcpServers ?? {}).map(([n, c]) =>
      [n, { ...c, env: { ...(c.env ?? {}), GARRISON_MCP_TOOLS: allow } }]));
    delete cfg.narrowMcp;
  }
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
    await adapter.sendTurn(session, "Reply with the single word: ok", {
      onUsage: (row) => usage.push(row),
    });
    await adapter.awaitResponse(session);
    await adapter.teardown?.(session);
  } catch (e) {
    err = String(e?.message ?? e);
  }
  const reqs = captures.slice(before);
  const first = usage.find((u) => u.source === "assistant") ?? usage[0] ?? null;
  const u = first?.usage ?? {};
  const prefix = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const rec = { name, model, prefix, usage: u, error: err, requests: reqs.length };
  results.push(rec);
  // The CLI fires a small title-generation call first; the turn's real request
  // is the one carrying the tool inventory. Keep every request so the split is
  // visible rather than assumed.
  reqs.forEach((r, i) => {
    fs.writeFileSync(path.join(OUT, `req-${name}-${i}.json`), JSON.stringify(r.body, null, 1));
  });
  console.log(`[probe] ${name.padEnd(16)} prefix=${String(prefix).padStart(7)}  in=${u.input_tokens ?? "-"} write=${u.cache_creation_input_tokens ?? "-"} read=${u.cache_read_input_tokens ?? "-"} reqs=${reqs.length}${err ? "  ERROR " + err : ""}`);
}

fs.writeFileSync(path.join(OUT, `probes-${model}.json`), JSON.stringify(results, null, 1));

// Exact attribution, provider-side. The last captured request carrying a tool
// inventory is the real turn; the small one before it is the CLI's own
// title-generation call.
if (process.argv.includes("--count")) {
  const { countSections } = await import("./count-sections.mjs");
  const real = [...captures].reverse().find((c) => Array.isArray(c.body?.tools) && c.body.tools.length);
  if (!real) {
    console.log("[count] no request with a tool inventory was captured");
  } else {
    try {
      const sections = await countSections({ headers: real.headers, body: real.body, appendText: append });
      fs.writeFileSync(path.join(OUT, `sections-${model}.json`), JSON.stringify(sections, null, 1));
      console.log("[count] wrote sections; whole =", sections.sections.whole);
    } catch (e) {
      console.log("[count] FAILED:", String(e?.message ?? e));
    }
    // The measured allowlist, from what duties actually invoked (see
    // tool-usage.json) - plus the sets a profile might plausibly keep.
    try {
      const { countToolSubsets } = await import("./count-sections.mjs");
      const MEASURED = ["Bash", "Read", "Write", "Edit", "Agent", "ToolSearch", "TaskOutput", "AskUserQuestion"];
      const subsets = {
        "measured-allowlist": MEASURED,
        "coding-core": ["Bash", "Read", "Write", "Edit"],
        "coding-plus-agent": ["Bash", "Read", "Write", "Edit", "Agent"],
        "read-only": ["Read", "Bash"],
        "mcp-only": real.body.tools.filter((t) => t.name.startsWith("mcp__")).map((t) => t.name),
        "non-mcp-only": real.body.tools.filter((t) => !t.name.startsWith("mcp__")).map((t) => t.name),
      };
      const sub = await countToolSubsets({ headers: real.headers, body: real.body, subsets });
      fs.writeFileSync(path.join(OUT, `tool-subsets-${model}.json`), JSON.stringify(sub, null, 1));
      console.log("[count] tool subsets: all =", sub.all);
      for (const [k, v] of Object.entries(sub.subsets)) console.log(`         ${k.padEnd(20)} ${String(v.tokens).padStart(6)}  (${v.kept.length} tools${v.missing.length ? ", missing " + v.missing.join(",") : ""})`);
    } catch (e) {
      console.log("[count] subsets FAILED:", String(e?.message ?? e));
    }
    // Break the composition's own assembled prompt into its top-level sections:
    // the capability catalogue is the part worth arguing about.
    try {
      const { countTexts } = await import("./count-sections.mjs");
      const secs = {};
      const lines = append.split("\n");
      let cur = "(preamble)";
      let buf = [];
      for (const line of lines) {
        if (/^## /.test(line)) { secs[cur] = (secs[cur] ?? "") + buf.join("\n"); cur = line.trim(); buf = [line]; }
        else buf.push(line);
      }
      secs[cur] = (secs[cur] ?? "") + buf.join("\n");
      const counted = await countTexts({ headers: real.headers, body: real.body, texts: secs });
      fs.writeFileSync(path.join(OUT, `append-sections-${model}.json`), JSON.stringify(counted, null, 1));
      console.log("[count] appended-prompt sections:");
      for (const [k, v] of Object.entries(counted.sections).sort((a, b) => b[1].tokens - a[1].tokens)) {
        console.log(`         ${String(v.tokens).padStart(6)} tok  ${String(v.chars).padStart(7)} chars  ${k.slice(0, 70)}`);
      }
    } catch (e) {
      console.log("[count] append sections FAILED:", String(e?.message ?? e));
    }
  }
}
proxy.close();
console.log("[probe] done");
process.exit(0);
