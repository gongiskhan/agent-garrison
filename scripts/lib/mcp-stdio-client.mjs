// mcp-stdio-client.mjs — a minimal MCP stdio client (newline-delimited JSON-RPC).
// Used by the U2 knowledge-MCP live verification (codegraph + serena) and its
// probe. Drives the real installed MCP servers through initialize → tools/list →
// tools/call, so "answers a query through the wired MCP" is literally exercised.

import { spawn } from "node:child_process";

export class McpStdioClient {
  constructor({ command, args = [], cwd, env, name = "mcp" } = {}) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env ?? process.env;
    this.name = name;
    this.proc = null;
    this.buf = "";
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
  }

  start() {
    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this.#onData(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (c) => {
      this.stderr += c;
      if (this.stderr.length > 20000) this.stderr = this.stderr.slice(-20000);
    });
    this.proc.on("exit", (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`${this.name} exited (code ${code})`));
      this.pending.clear();
    });
    return this;
  }

  #onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // non-JSON log line on stdout — ignore
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${this.name} rpc error: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      }
    }
  }

  #send(obj) {
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  request(method, params, timeoutMs = 60_000) {
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const t = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${this.name} ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      t.unref?.();
    });
    this.#send({ jsonrpc: "2.0", id, method, params });
    return p;
  }

  notify(method, params) {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  async initialize({ rootUri, timeoutMs = 60_000 } = {}) {
    const result = await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "garrison-knowledge-probe", version: "1.0.0" },
        ...(rootUri ? { rootUri } : {}),
      },
      timeoutMs
    );
    this.notify("notifications/initialized", {});
    return result;
  }

  listTools(timeoutMs = 60_000) {
    return this.request("tools/list", {}, timeoutMs).then((r) => r?.tools ?? []);
  }

  callTool(name, args = {}, timeoutMs = 120_000) {
    return this.request("tools/call", { name, arguments: args }, timeoutMs);
  }

  stop() {
    try {
      this.proc?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        if (this.proc?.exitCode == null) this.proc?.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 1500).unref?.();
  }
}

// Flatten an MCP tools/call result's content array to a plain string.
export function flattenContent(result) {
  const content = result?.content ?? [];
  return content
    .map((c) => (typeof c?.text === "string" ? c.text : typeof c === "string" ? c : JSON.stringify(c)))
    .join("\n");
}
