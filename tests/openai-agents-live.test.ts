import { describe, it, expect } from "vitest";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// @ts-ignore - real SDK path (loads @openai/agents)
import { OpenAiAgentsAdapter } from "../fittings/seed/openai-agents-runtime/lib/openai-adapter.mjs";

// S2a - openai-agents-runtime proven against real OpenAI-compatible endpoints:
//   (b) a LIVE round trip vs local Ollama (skipped when Ollama is unreachable, so
//       CI / a box without Ollama stays green - the unit + mock suites cover the
//       wiring), and
//   (c) a MOCKED OpenAI-compatible endpoint driven by the REAL @openai/agents SDK
//       (always runs; no cloud key - proves "one OpenAI-compatible endpoint"
//       beyond Ollama and that the by-name Vault key reaches the endpoint
//       server-side, never in argv).
const REPO = path.resolve(__dirname, "..");
const BRIDGE = path.join(REPO, "fittings/seed/openai-agents-runtime/scripts/bridge.mjs");
const MODEL = "qwen2.5:3b";

const OLLAMA_UP = await fetch("http://localhost:11434/api/version", { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);

function runBridge(spec: unknown, env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [BRIDGE, "delegate"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.write(JSON.stringify(spec));
    child.stdin.end();
  });
}

// ── (b) LIVE Ollama round trip ───────────────────────────────────────────────
describe.skipIf(!OLLAMA_UP)("openai-agents LIVE (local Ollama, qwen2.5:3b)", () => {
  it("bridge delegate() STDIN → STDOUT returns a real {summary, artifacts}", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "openai-agents-live-"));
    const { code, out } = await runBridge(
      {
        task: "Reply with the single word: READY",
        provider: "ollama-local",
        model: MODEL,
        promptMode: "lean", // pure chat: fast + robust on a small local model
        maxTurns: 2
      },
      { OPENAI_AGENTS_RUNTIME_DATA: dataDir }
    );
    expect(code).toBe(0);
    const result = JSON.parse(out.trim());
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0); // a REAL summary from the model
    expect(Array.isArray(result.artifacts)).toBe(true);
    expect(result.artifacts[0]).toMatch(/delegations/); // full output landed in the artifact store
  }, 120_000);

  it("a full-mode tool round trip actually calls read_file and reports the file's marker", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openai-agents-tool-"));
    const marker = "517342";
    writeFileSync(path.join(cwd, "probe.txt"), `garrison probe marker ${marker}\nsecond line\n`, "utf8");
    const adapter = new OpenAiAgentsAdapter();
    const s = await adapter.spawn({ provider: "ollama-local", model: MODEL, promptMode: "full", compositionDir: cwd, maxTurns: 6 });
    await adapter.awaitReady(s);
    await adapter.sendTurn(
      s,
      `Use the read_file tool to read "probe.txt" in your working directory, then reply with the numeric marker it contains.`
    );
    const r = await adapter.awaitResponse(s);
    await adapter.teardown(s);
    expect(r.toolUses.map((t: any) => t.name)).toContain("read_file"); // the agentic loop + file tool fired
    expect(r.text).toContain(marker); // and it read + reported the real content
    expect(s.usedTokens).toBeGreaterThan(0);
  }, 120_000);
});

// ── (c) MOCKED OpenAI-compatible endpoint (real SDK, no cloud key) ────────────
describe("openai-agents vs a MOCKED OpenAI-compatible endpoint (real SDK)", () => {
  it("drives /v1/chat/completions and carries the by-name key as a Bearer header (server-side only)", async () => {
    const captured: any[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        captured.push({ url: req.url, method: req.method, auth: req.headers["authorization"], model: parsed.model });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion",
            created: 1,
            model: "mock-model",
            choices: [{ index: 0, message: { role: "assistant", content: "MOCK_SUMMARY_OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
          })
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;

    try {
      const adapter = new OpenAiAgentsAdapter();
      const s = await adapter.spawn({
        provider: "openai-compat",
        model: "mock-model",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        promptMode: "lean",
        compositionDir: tmpdir(),
        secrets: { OPENAI_API_KEY: "sk-test-mock" } // by-name Vault key
      });
      await adapter.sendTurn(s, "produce a summary");
      const r = await adapter.awaitResponse(s);

      expect(r.text).toBe("MOCK_SUMMARY_OK"); // the OpenAI-compatible endpoint answered
      expect(s.usedTokens).toBe(8); // usage parsed from the endpoint
      expect(captured).toHaveLength(1);
      expect(captured[0].url).toBe("/v1/chat/completions");
      expect(captured[0].model).toBe("mock-model");
      // the by-name Vault key reached the endpoint as a Bearer header - server-side,
      // never in argv / the browser
      expect(captured[0].auth).toBe("Bearer sk-test-mock");
    } finally {
      server.close();
    }
  }, 30_000);
});
