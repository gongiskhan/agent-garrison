// Omi channel M5 — ask_gary chat tool acceptance (build spec): mocked calls
// return within budget; overruns abort into a friendly partial answer; the
// manifest validates against the documented ChatTools format; auth covers app
// id + uid (+ the URL shared secret, since Omi sends no credential on tool
// calls).

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../fittings/seed/omi-channel/lib/config.mjs";
import { OmiStore, Counters } from "../fittings/seed/omi-channel/lib/store.mjs";
import { ChatTool, buildManifest, buildAskPrompt } from "../fittings/seed/omi-channel/lib/chat.mjs";
import { startServer } from "../fittings/seed/omi-channel/scripts/server.mjs";

const SECRET = "chat-secret";
const UID = "omi_test_user_1";

function makeTool(home: string, opts: { runFn?: unknown; deadlineMs?: number; cfg?: Record<string, unknown> } = {}) {
  const store = new OmiStore(path.join(home, "omi"));
  const counters = new Counters(store.root, "chat");
  const cfg = {
    ...loadConfig({ GARRISON_HOME: home }),
    chatEnabled: true,
    publicBaseUrl: "https://box.ts.net:8443",
    secrets: { appId: "app_123", appSecret: "s", importApiKey: "", webhookSecret: SECRET },
    ...(opts.cfg ?? {})
  };
  const tool = new ChatTool({
    cfg,
    store,
    counters,
    runFn: (opts.runFn ?? (async () => ({ reply: "All quiet on the board." }))) as never,
    deadlineMs: opts.deadlineMs ?? 500,
    log: { log: () => {}, error: () => {} }
  });
  return { tool, store, counters, cfg };
}

function body(overrides: Record<string, unknown> = {}) {
  return { uid: UID, app_id: "app_123", tool_name: "ask_gary", query: "how is the board?", ...overrides };
}

describe("ask_gary manifest", () => {
  it("validates against the documented ChatTools format", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-chat-man-"));
    try {
      const { cfg } = makeTool(home);
      const manifest = buildManifest(cfg);
      expect(Array.isArray(manifest.tools)).toBe(true);
      expect(manifest.tools).toHaveLength(1);
      const tool = manifest.tools[0];
      expect(tool.name).toBe("ask_gary");
      expect(tool.method).toBe("POST");
      expect(tool.description.length).toBeGreaterThan(80);
      expect(tool.parameters).toEqual({
        properties: { query: { type: "string", description: expect.any(String) } },
        required: ["query"]
      });
      expect(tool.auth_required).toBe(false);
      expect(typeof tool.status_message).toBe("string");
      // Absolute endpoint from public_base_url, carrying the URL secret (I8).
      expect(tool.endpoint).toBe(`https://box.ts.net:8443/omi/chat?key=${SECRET}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("falls back to a relative endpoint when no public base is configured", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-chat-rel-"));
    try {
      const { cfg } = makeTool(home, { cfg: { publicBaseUrl: "" } });
      expect(buildManifest(cfg).tools[0].endpoint).toBe(`/omi/chat?key=${SECRET}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("requires the key on the manifest route itself", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-chat-mankey-"));
    try {
      const { tool } = makeTool(home);
      expect(tool.manifest({ key: "wrong" }).status).toBe(401);
      expect(tool.manifest({ key: SECRET }).status).toBe(200);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("ask_gary handler", () => {
  it("answers within budget with the orchestrator's reply", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-chat-ok-"));
    try {
      const prompts: string[] = [];
      const { tool, counters } = makeTool(home, {
        runFn: async ({ prompt }: { prompt: string }) => {
          prompts.push(prompt);
          return { reply: "3 cards open; the beta email is due Friday." };
        }
      });
      const started = Date.now();
      const outcome = await tool.handle({ key: SECRET }, body());
      expect(Date.now() - started).toBeLessThan(500);
      expect(outcome.status).toBe(200);
      expect(outcome.body.result).toContain("3 cards open");
      expect(prompts[0]).toContain("how is the board?");
      expect(counters.read().chat_answered).toBe(1);
      expect(counters.read().chat_answer_ms_count).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("aborts an overrun into a friendly partial answer (still HTTP 200)", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-chat-slow-"));
    try {
      const { tool, counters } = makeTool(home, {
        deadlineMs: 30,
        runFn: () => new Promise((resolve) => setTimeout(() => resolve({ reply: "too late" }), 500))
      });
      const outcome = await tool.handle({ key: SECRET }, body());
      expect(outcome.status).toBe(200);
      expect(String(outcome.body.result)).toContain("Ask again in a moment");
      expect(String(outcome.body.result)).not.toContain("too late");
      expect(counters.read().chat_overruns).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("degrades gracefully when the gateway call throws", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-chat-err-"));
    try {
      const { tool } = makeTool(home, {
        runFn: async () => {
          throw new Error("ECONNREFUSED");
        }
      });
      const outcome = await tool.handle({ key: SECRET }, body());
      expect(outcome.status).toBe(200);
      expect(String(outcome.body.result)).toContain("Ask again in a moment");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("authenticates key, app id, and pinned uid; counts rejections", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-chat-auth-"));
    try {
      const { tool, counters } = makeTool(home);
      expect((await tool.handle({ key: "wrong" }, body())).status).toBe(401);
      expect((await tool.handle({ key: SECRET }, body({ app_id: "someone-else" }))).status).toBe(401);
      // First valid call pins the uid...
      expect((await tool.handle({ key: SECRET }, body())).status).toBe(200);
      // ...and a foreign uid is rejected afterwards.
      expect((await tool.handle({ key: SECRET }, body({ uid: "intruder" }))).status).toBe(403);
      expect((await tool.handle({ key: SECRET }, body({ query: "" }))).status).toBe(400);
      const c = counters.read();
      expect(c.chat_rejected_auth).toBe(1);
      expect(c.chat_rejected_app).toBe(1);
      expect(c.chat_rejected_uid).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is disabled by default (403 with the flag off)", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-chat-off-"));
    try {
      const { tool } = makeTool(home, { cfg: { chatEnabled: false } });
      expect((await tool.handle({ key: SECRET }, body())).status).toBe(403);
      expect(tool.manifest({ key: SECRET }).status).toBe(403);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("buildAskPrompt keeps the question verbatim and bounds the answer", () => {
    const prompt = buildAskPrompt("qual e o estado do board?");
    expect(prompt).toContain("qual e o estado do board?");
    expect(prompt).toContain("under 120 words");
  });
});

describe("ask_gary through the live server route", () => {
  it("serves the tool and manifest end-to-end (offline gateway = friendly answer)", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-chat-e2e-"));
    const prevHome = process.env.GARRISON_HOME;
    process.env.GARRISON_HOME = home;
    let server: Awaited<ReturnType<typeof startServer>> | null = null;
    try {
      const cfg = {
        ...loadConfig({ GARRISON_HOME: home }),
        port: 0,
        chatEnabled: true,
        syncJobs: false,
        gatewayUrl: null,
        secrets: { appId: "app_123", appSecret: "", importApiKey: "", webhookSecret: SECRET }
      };
      server = await startServer(cfg);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const base = `http://127.0.0.1:${port}`;

      const manifest = await fetch(`${base}/omi/tools-manifest?key=${SECRET}`);
      expect(manifest.status).toBe(200);
      const parsed = await manifest.json();
      expect(parsed.tools[0].name).toBe("ask_gary");

      const answer = await fetch(`${base}/omi/chat?key=${SECRET}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body())
      });
      expect(answer.status).toBe(200);
      const payload = await answer.json();
      expect(String(payload.result)).toContain("offline");
    } finally {
      await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
      if (prevHome === undefined) delete process.env.GARRISON_HOME;
      else process.env.GARRISON_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
