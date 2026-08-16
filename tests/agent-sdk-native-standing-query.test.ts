import { expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
// @ts-ignore — the fitting intentionally exposes a plain ESM wrapper.
import { createSdkClient } from "../fittings/seed/agent-sdk-runtime/lib/sdk-client.mjs";

class NativeInputQueue {
  private values: unknown[] = [];
  private waiter: ((result: IteratorResult<unknown>) => void) | null = null;
  private closed = false;

  push(value: unknown) {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ done: false, value });
    } else {
      this.values.push(value);
    }
  }

  close() {
    this.closed = true;
    this.waiter?.({ done: true, value: undefined });
    this.waiter = null;
  }

  async next(): Promise<IteratorResult<unknown>> {
    if (this.values.length) return { done: false, value: this.values.shift() };
    if (this.closed) return { done: true, value: undefined };
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  [Symbol.asyncIterator]() {
    return this;
  }
}

function user(text: string) {
  return {
    type: "user",
    session_id: "",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  };
}

function writeAnthropicText(res: http.ServerResponse, sequence: number) {
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send("message_start", {
    type: "message_start",
    message: {
      id: `msg_native_${sequence}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 3,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
        service_tier: "standard",
      },
    },
  });
  send("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "", citations: null },
  });
  send("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: `native-${sequence}` },
  });
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 3 },
  });
  send("message_stop", { type: "message_stop" });
  res.end();
}

it("keeps the pinned native Query usable beyond maxTurns streamed inputs without idle markers", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === "HEAD") {
      res.writeHead(200).end();
      return;
    }
    if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, body: JSON.parse(raw || "{}") });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    writeAnthropicText(res, requests.length);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const compositionDir = fs.mkdtempSync(path.join(os.tmpdir(), "garrison-native-standing-"));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "garrison-native-config-"));
  const input = new NativeInputQueue();
  const messages: any[] = [];
  let query: any = null;
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    query = createSdkClient({
      prompt: input,
      options: {
        cwd: compositionDir,
        model: "claude-sonnet-4-6",
        systemPrompt: "Return the local fixture text.",
        tools: [],
        settingSources: [],
        maxTurns: 2,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_API_KEY: "local-fixture-only",
          ANTHROPIC_AUTH_TOKEN: "local-fixture-only",
          CLAUDE_CONFIG_DIR: configDir,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      },
    });

    const pump = (async () => {
      for await (const message of query) {
        messages.push(message);
        if (message?.type !== "result") continue;
        if (requests.length < 3) input.push(user(`turn-${requests.length + 1}`));
        else {
          input.close();
          query.close();
        }
      }
    })();
    input.push(user("turn-1"));
    await pump;

    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.url === "/v1/messages?beta=true")).toBe(true);
    expect(messages.filter((message) => message?.type === "result").map((message) => message.result)).toEqual([
      "native-1",
      "native-2",
      "native-3",
    ]);
    expect(messages.filter((message) =>
      message?.type === "system" && message?.subtype === "session_state_changed"
    )).toEqual([]);
  } finally {
    input.close();
    try { query?.close?.(); } catch {}
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(compositionDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}, 30_000);
