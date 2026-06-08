import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addMcpServer,
  updateMcpServer,
  removeMcpServer,
  listMcpServers,
  getMcpServer,
  normalizeServerConfig
} from "@/lib/mcp-writer";

let claudeRoot: string;
let priorClaude: string | undefined;

function mcpFile(): string {
  return path.join(claudeRoot, "mcp.json");
}
function readMcp(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(mcpFile(), "utf8"));
}
function writeMcp(doc: unknown): void {
  fs.writeFileSync(mcpFile(), JSON.stringify(doc, null, 2));
}

beforeEach(() => {
  priorClaude = process.env.GARRISON_CLAUDE_HOME;
  claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gar-mcp-"));
  process.env.GARRISON_CLAUDE_HOME = claudeRoot;
});
afterEach(() => {
  if (priorClaude === undefined) delete process.env.GARRISON_CLAUDE_HOME;
  else process.env.GARRISON_CLAUDE_HOME = priorClaude;
  fs.rmSync(claudeRoot, { recursive: true, force: true });
});

describe("mcp-writer CRUD", () => {
  it("adds a stdio server to a missing file (wrapped shape by default)", async () => {
    const r = await addMcpServer("ctx", { command: "npx", args: ["-y", "ctx-mcp"] });
    expect(r.ok).toBe(true);
    const doc = readMcp();
    expect(doc.mcpServers).toBeTruthy();
    expect((doc.mcpServers as Record<string, unknown>).ctx).toEqual({ command: "npx", args: ["-y", "ctx-mcp"] });
  });

  it("refuses to clobber an existing server (create is not update)", async () => {
    await addMcpServer("ctx", { command: "a" });
    const r = await addMcpServer("ctx", { command: "b" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("exists");
    // original untouched
    expect((await getMcpServer("ctx"))?.command).toBe("a");
  });

  it("preserves a BARE top-level map shape on write", async () => {
    writeMcp({ existing: { command: "old" } }); // no mcpServers wrapper
    const r = await addMcpServer("added", { command: "new" });
    expect(r.ok).toBe(true);
    const doc = readMcp();
    expect(doc.mcpServers).toBeUndefined(); // stayed bare
    expect(doc.existing).toEqual({ command: "old" });
    expect(doc.added).toEqual({ command: "new" });
  });

  it("preserves sibling keys under the wrapped shape", async () => {
    writeMcp({ $schema: "x", mcpServers: { a: { command: "a" } } });
    await addMcpServer("b", { command: "b" });
    const doc = readMcp();
    expect(doc.$schema).toBe("x");
    expect(Object.keys(doc.mcpServers as object)).toEqual(["a", "b"]);
  });

  it("round-trips an http/sse transport (url + headers, no command)", async () => {
    const r = await addMcpServer("remote", {
      type: "http",
      url: "https://mcp.example.com/sse",
      headers: { Authorization: "Bearer t" }
    });
    expect(r.ok).toBe(true);
    const cfg = await getMcpServer("remote");
    expect(cfg).toEqual({ type: "http", url: "https://mcp.example.com/sse", headers: { Authorization: "Bearer t" } });
    expect(cfg?.command).toBeUndefined();
  });

  it("updates a server in place and supports rename without collision", async () => {
    await addMcpServer("old", { command: "x" });
    await addMcpServer("keep", { command: "k" });
    const r = await updateMcpServer("old", { command: "y", args: ["--flag"] }, undefined, "new");
    expect(r.ok).toBe(true);
    const servers = await listMcpServers();
    expect(Object.keys(servers).sort()).toEqual(["keep", "new"]);
    expect(servers.new).toEqual({ command: "y", args: ["--flag"] });
  });

  it("refuses a rename onto an existing name", async () => {
    await addMcpServer("a", { command: "a" });
    await addMcpServer("b", { command: "b" });
    const r = await updateMcpServer("a", { command: "a2" }, undefined, "b");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("exists");
  });

  it("removes a server and reports not-found for a missing one", async () => {
    await addMcpServer("gone", { command: "g" });
    const ok = await removeMcpServer("gone");
    expect(ok.ok).toBe(true);
    expect(await getMcpServer("gone")).toBeNull();
    const missing = await removeMcpServer("nope");
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe("not-found");
  });

  it("validates name + transport requirements", async () => {
    expect((await addMcpServer("", { command: "x" })).code).toBe("invalid");
    expect((await addMcpServer("bad name", { command: "x" })).code).toBe("invalid");
    expect((await addMcpServer("nope", {})).code).toBe("invalid"); // neither command nor url
  });

  it("normalizeServerConfig drops cross-transport fields + empties but keeps bespoke keys", () => {
    const clean = normalizeServerConfig({
      type: "http",
      url: "https://x",
      command: "should-drop",
      args: ["should-drop"],
      env: { A: "1" },
      headers: { H: "v" },
      bespoke: 42
    });
    expect(clean.command).toBeUndefined();
    expect(clean.args).toBeUndefined();
    expect(clean.env).toBeUndefined();
    expect(clean.url).toBe("https://x");
    expect(clean.headers).toEqual({ H: "v" });
    expect(clean.bespoke).toBe(42);
  });
});
