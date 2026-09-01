// Provider-two step 3: Codex as a stretch runtime. Three seams, one flag.
// The adapter mounts the SHARED Garrison MCP server into one `codex exec` via
// -c overrides (spike-proven unlocks: per-server approval mode "auto", and
// --approve-for-me on sandboxed lanes because headless exec pins the global
// approval policy to `never`, which DENIES). The launcher hands the exec lane
// the stretch's conversation identity. And a stretch that DIES parks the card
// on Needs input with the reason instead of wedging it on running - contract
// rule 2 - keeping every finding already appended.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs (single-line on purpose: @ts-ignore only covers the next line)
import { buildExecArgs, mcpServerArgs } from "../fittings/seed/codex-runtime/lib/codex-adapter.mjs";
// @ts-ignore — pure .mjs
import { runtimeCodexEnabled } from "../fittings/seed/http-gateway/scripts/lib/harness-profiles.mjs";
// @ts-ignore — pure .mjs
import { runConversation, runStretch } from "../fittings/seed/http-gateway/scripts/lib/stretch.mjs";

const ROOT = path.resolve(__dirname, "..");

describe("runtimeCodexEnabled", () => {
  it("is on unless the revert flag explicitly turns it off", () => {
    expect(runtimeCodexEnabled({})).toBe(true);
    for (const off of ["false", "0", "off", "no"]) {
      expect(runtimeCodexEnabled({ GARRISON_HTTPGATEWAY_RUNTIME_CODEX: off }), off).toBe(false);
    }
  });
});

describe("mcpServerArgs", () => {
  const server = {
    name: "garrison",
    command: "node",
    args: ["/x/gateway.mjs", "stdio"],
    env: { GARRISON_CONVERSATION_ID: "01M1X", GARRISON_STRETCH_CWD: "/repo" },
  };

  it("emits the -c overrides the spike proved, as valid TOML values", () => {
    const args = mcpServerArgs(server, { bypassed: false });
    const byFlag: Record<string, string> = {};
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-c") {
        const [k, ...rest] = args[i + 1].split("=");
        byFlag[k] = rest.join("=");
      }
    }
    expect(byFlag["mcp_servers.garrison.command"]).toBe('"node"');
    expect(byFlag["mcp_servers.garrison.args"]).toBe('["/x/gateway.mjs","stdio"]');
    expect(byFlag["mcp_servers.garrison.env"]).toContain('GARRISON_CONVERSATION_ID = "01M1X"');
    expect(byFlag["mcp_servers.garrison.default_tools_approval_mode"]).toBe('"auto"');
    expect(args).toContain("--approve-for-me");
  });

  it("drops --approve-for-me on the bypass lane, which skips approvals wholesale", () => {
    expect(mcpServerArgs(server, { bypassed: true })).not.toContain("--approve-for-me");
  });

  it("rides buildExecArgs and follows the permission mapping", () => {
    const sandboxed = buildExecArgs({ permissionMode: "acceptEdits", mcpServer: server });
    expect(sandboxed.argv).toContain("--approve-for-me");
    expect(sandboxed.argv.join(" ")).toContain("mcp_servers.garrison.command");
    const bypassed = buildExecArgs({ permissionMode: "bypassPermissions", mcpServer: server });
    expect(bypassed.argv).not.toContain("--approve-for-me");
    expect(bypassed.argv.join(" ")).toContain("mcp_servers.garrison.command");
    const plain = buildExecArgs({ permissionMode: "bypassPermissions" });
    expect(plain.argv.join(" ")).not.toContain("mcp_servers");
  });
});

describe("_stretchMcpConfig", () => {
  async function gw() {
    const mod = await import(
      pathToFileURL(path.join(ROOT, "fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs")).href
    );
    const self: any = Object.create(mod.RoutedGateway.prototype);
    self._agentSdkMcpServers = {
      garrison: {
        command: "node",
        args: ["/comp/apm_modules/_local/mcp-gateway/scripts/gateway.mjs", "stdio"],
        env: { GARRISON_COMPOSITION_DIR: "/comp", GARRISON_HTTP_GATEWAY_BASE_URL: "http://127.0.0.1:5777" },
      },
    };
    return self;
  }

  it("builds the conversation-scoped server for a codex stretch", async () => {
    const self = await gw();
    const cfg = self._stretchMcpConfig("codex", { conversationId: "01M1CONV" }, "/repo");
    expect(cfg.name).toBe("garrison");
    expect(cfg.command).toBe("node");
    expect(cfg.env.GARRISON_HTTP_GATEWAY_BASE_URL).toBe("http://127.0.0.1:5777");
    expect(cfg.env.GARRISON_CONVERSATION_ID).toBe("01M1CONV");
    expect(cfg.env.GARRISON_STRETCH_CWD).toBe("/repo");
    expect(cfg.env.GARRISON_MCP_TOOLS).toContain("garrison_finding_add");
    expect(cfg.env.GARRISON_MCP_TOOLS).toContain("garrison_conversation_fetch");
  });

  it("mounts nothing for delegations, other runtimes, or with the flag off", async () => {
    const self = await gw();
    expect(self._stretchMcpConfig("codex", {}, "/repo")).toBeNull();
    expect(self._stretchMcpConfig("gemini", { conversationId: "01M1CONV" }, "/repo")).toBeNull();
    const prev = process.env.GARRISON_HTTPGATEWAY_RUNTIME_CODEX;
    process.env.GARRISON_HTTPGATEWAY_RUNTIME_CODEX = "false";
    try {
      expect(self._stretchMcpConfig("codex", { conversationId: "01M1CONV" }, "/repo")).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.GARRISON_HTTPGATEWAY_RUNTIME_CODEX;
      else process.env.GARRISON_HTTPGATEWAY_RUNTIME_CODEX = prev;
    }
  });
});

describe("runStretch hands the exec lane the stretch identity", () => {
  it("passes conversationId and stretchId to runSecondaryTurn", async () => {
    let seen: any = null;
    const gateway = {
      async runSecondaryTurn(_route: any, _brief: string, opts: any) {
        seen = opts;
        return { reply: "ok", usage: [] };
      },
    };
    const route = { targetId: "t", target: { runtime: "codex", model: "gpt-5.6-sol" } };
    const out = await runStretch(gateway as never, {
      route,
      brief: "b",
      stretchId: "st_1",
      conversationId: "01M1CONV",
      cwd: "/repo",
    });
    expect(out.ok).toBe(true);
    expect(seen.conversationId).toBe("01M1CONV");
    expect(seen.stretchId).toBe("st_1");
    expect(seen.cwd).toBe("/repo");
  });
});

describe("a dead runtime parks the card wearing its own reason", () => {
  const CARD = "01M1CODEXCRASH000000000001";
  let tmp: string;
  let env: Record<string, string>;
  let server: Server | undefined;
  let patches: any[];
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "codex-crash-"));
    env = { GARRISON_HOME: tmp };
    patches = [];
    mkdirSync(path.join(tmp, "ui-fittings"), { recursive: true });
    prevHome = process.env.GARRISON_HOME;
    process.env.GARRISON_HOME = tmp;
  });

  afterEach(() => {
    process.env.GARRISON_HOME = prevHome;
    server?.close();
    server = undefined;
    rmSync(tmp, { recursive: true, force: true });
  });

  function startBoard(): Promise<number> {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.method === "PATCH") patches.push(JSON.parse(body || "{}"));
        res.end(JSON.stringify({
          ok: true,
          card: { id: CARD, rev: 1, title: "t", list: "running", status: "running", conversationId: CARD, autonomous: true },
          checklist: [],
          attachments: [],
        }));
      });
    });
    return new Promise((resolve) => server!.listen(0, "127.0.0.1", () => resolve((server!.address() as { port: number }).port)));
  }

  function crashingGateway() {
    const LADDER = {
      ladder: "standard",
      rungs: [{ id: "floor", target: "sdk-haiku", runtime: "agent-sdk", provider: "anthropic", model: "haiku", params: {} }],
      defaultIndex: 0,
      ceilingIndex: 0,
    };
    return {
      compositionDir: tmp,
      logFn: () => {},
      _laneQueues: new Map(),
      _onLane(key: string, fn: () => Promise<unknown>) {
        const prev = this._laneQueues.get(key) ?? Promise.resolve();
        const run = prev.catch(() => {}).then(fn);
        this._laneQueues.set(key, run.catch(() => {}));
        return run;
      },
      async executionModel() {
        return { version: 3, selectedDuties: ["triage"], duties: {}, dutyLadder: { triage: LADDER } };
      },
      async executionRouteFor({ duty, level }: any) {
        return { targetId: "t", target: { id: "t", runtime: "agent-sdk", provider: "anthropic", model: "haiku", effort: "low", type: "runtime-target" }, duty, level, skill: null };
      },
      async runAgentSdkTurn() {
        throw new Error("codex exec exited 1: You've hit your usage limit");
      },
      async releaseConversationSessions() { return 1; },
    };
  }

  it("ends needs-input with the runtime's own reason on the ledger AND the card", async () => {
    const port = await startBoard();
    writeFileSync(path.join(tmp, "ui-fittings", "kanban-loop.json"), JSON.stringify({ url: `http://127.0.0.1:${port}` }));
    const out = await runConversation(crashingGateway() as never, { conversationId: CARD, task: "do it", env });
    expect(out.terminal).toBe("needs-input");
    // @ts-ignore — pure .mjs
    const { openConversation } = await import("../packages/claude-pty/src/conversation-store.mjs");
    const store = openConversation(CARD, { role: "test", env });
    const ended = store.tail(5, { kinds: ["stretch-ended"] }).map((e: any) => e.payload);
    expect(ended.some((p: any) => p.outcome === "error" && /usage limit/.test(p.error))).toBe(true);
    // The synthesized handoff carries the runtime's reason, and
    // writeCardTransition copies it onto the card - the reader never has to
    // dig the ledger for WHY the card parked.
    const handoff = store.tail(3, { kinds: ["handoff"] }).map((e: any) => e.payload).find((h: any) => h.synthesized);
    expect(handoff.summary).toContain("usage limit");
    const park = patches.find((p) => p.list === "needs-attention");
    expect(park).toBeTruthy();
    expect(park.attentionReason).toContain("usage limit");
  });

  it("with the flag off the card parks with the old generic line", async () => {
    const port = await startBoard();
    writeFileSync(path.join(tmp, "ui-fittings", "kanban-loop.json"), JSON.stringify({ url: `http://127.0.0.1:${port}` }));
    const out = await runConversation(crashingGateway() as never, {
      conversationId: CARD,
      task: "do it",
      env: { ...env, GARRISON_HTTPGATEWAY_RUNTIME_CODEX: "false" },
    });
    expect(out.terminal).toBe("needs-input");
    const park = patches.find((p) => p.list === "needs-attention");
    expect(park).toBeTruthy();
    expect(park.attentionReason).not.toContain("usage limit");
    expect(park.attentionReason).toContain("no valid handoff");
  });
});
