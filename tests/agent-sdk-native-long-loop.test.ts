import { expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
// @ts-ignore — real pinned SDK wrapper
import { createSdkClient } from "../fittings/seed/agent-sdk-runtime/lib/sdk-client.mjs";
// @ts-ignore — resolved production assembly
import { resolveRoutedAgentSdkAssembly } from "../fittings/seed/agent-sdk-runtime/lib/agent-sdk-adapter.mjs";
// @ts-ignore — production triage policy
import { applyDutyHarnessProfile } from "../fittings/seed/http-gateway/scripts/lib/harness-profiles.mjs";

it("completes ten real native tool iterations with the default triage assembly", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-long-loop-"));
  const file = path.join(root, "evidence.txt");
  fs.writeFileSync(file, "read-only local fixture\n");
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method === "HEAD") { res.writeHead(200).end(); return; }
    if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) { res.writeHead(404).end(); return; }
    for await (const _chunk of req) { /* consume the local provider request */ }
    const sequence = ++requests;
    const tool = sequence <= 10;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("message_start", { type: "message_start", message: { id: `long_${sequence}`, type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } });
    send("content_block_start", { type: "content_block_start", index: 0, content_block: tool
      ? { type: "tool_use", id: `read_${sequence}`, name: "Read", input: {} }
      : { type: "text", text: "" } });
    send("content_block_delta", { type: "content_block_delta", index: 0, delta: tool
      ? { type: "input_json_delta", partial_json: JSON.stringify({ file_path: file }) }
      : { type: "text_delta", text: "Completed after ten reads." } });
    send("content_block_stop", { type: "content_block_stop", index: 0 });
    send("message_delta", { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
    send("message_stop", { type: "message_stop" }); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let client: any;
  try {
    const route = applyDutyHarnessProfile({ target: { runtime: "agent-sdk", model: "claude-sonnet-4-6", provider: "anthropic" } }, "triage");
    const assembly = resolveRoutedAgentSdkAssembly(route.target);
    expect(assembly.maxTurns).toBe(800);
    client = createSdkClient({ prompt: "Perform the fixture reads.", options: {
      cwd: root, model: assembly.model, systemPrompt: "Local fixture only.",
      tools: assembly.tools, settingSources: assembly.settingSources,
      maxTurns: assembly.maxTurns, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
      mcpServers: {}, strictMcpConfig: true,
      env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        ANTHROPIC_API_KEY: "local-fixture-only", ANTHROPIC_AUTH_TOKEN: "local-fixture-only",
        CLAUDE_CONFIG_DIR: path.join(root, "config"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    } });
    const results: any[] = [];
    const toolResults: any[] = [];
    for await (const message of client) {
      if (message.type === "result") results.push(message);
      if (message.type === "user") toolResults.push(...(message.message?.content ?? []).filter((b: any) => b.type === "tool_result"));
    }
    expect(requests).toBe(11);
    expect(toolResults).toHaveLength(10);
    expect(toolResults.every((r) => !r.is_error)).toBe(true);
    expect(results).toMatchObject([{ subtype: "success", result: "Completed after ten reads." }]);
  } finally {
    client?.close?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 45_000);
