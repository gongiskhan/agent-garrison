import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSITION_ID = process.env.GARRISON_COMPOSITION_ID ?? "default";
const GATEWAY_URL = (process.env.GARRISON_GATEWAY_URL ?? "http://127.0.0.1:4777").replace(/\/$/, "");
const COMPOSITION_DIR = path.join(REPO_ROOT, "compositions", COMPOSITION_ID);
const FORCE_RUN = process.env.GARRISON_INTEGRATION === "1";

let gatewayReachable = false;

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

interface ChatResponse {
  reply: string;
  session_id: string;
}

async function chat(message: string): Promise<ChatResponse> {
  const response = await fetch(`${GATEWAY_URL}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok) {
    throw new Error(`POST /chat returned ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as ChatResponse;
}

beforeAll(async () => {
  // CRITICAL: this probe must NOT throw. vitest treats beforeAll throws as suite
  // failures, which would defeat skip-by-default and break `npm test` whenever
  // the operative isn't running.
  try {
    const response = await fetch(`${GATEWAY_URL}/health`, {
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) return;
    const body = (await response.json()) as { ok?: boolean };
    if (body.ok === true) {
      gatewayReachable = true;
    }
  } catch {
    // gateway down — leave gatewayReachable=false
  }
});

function shouldSkip(): boolean {
  return !gatewayReachable && !FORCE_RUN;
}

describe("orchestrator-integration", () => {
  it("auth source uses Claude Code OAuth, not ANTHROPIC_API_KEY", async () => {
    if (shouldSkip()) return;
    expect(process.env.ANTHROPIC_API_KEY ?? "").toBe("");
    const claudeDir = path.join(os.homedir(), ".claude");
    expect(await pathExists(claudeDir)).toBe(true);
  });

  it("assembled system prompt contains marker and identity", async () => {
    if (shouldSkip()) return;
    const promptPath = path.join(COMPOSITION_DIR, ".garrison", "assembled-system-prompt.md");
    expect(await pathExists(promptPath)).toBe(true);
    const contents = await fs.readFile(promptPath, "utf8");
    expect(contents).toContain("[orchestrator-active]");
    expect(contents).toContain("Verity");
  });

  it("gateway /health responds", async () => {
    if (shouldSkip()) return;
    expect(gatewayReachable).toBe(true);
  });

  it(
    "orchestrator marker present in turn 1 reply",
    async () => {
      if (shouldSkip()) return;
      const turn1 = await chat("Briefly say hello.");
      expect(turn1.session_id).toBeTruthy();
      expect(turn1.reply).toContain("[orchestrator-active]");
    },
    150_000
  );

  it(
    "session resumes and operative identifies as Verity",
    async () => {
      if (shouldSkip()) return;
      const turn1 = await chat("Briefly say hello.");
      const turn2 = await chat("What is your name?");
      expect(turn2.session_id).toBe(turn1.session_id);
      expect(turn2.reply).toMatch(/\bVerity\b/i);
    },
    300_000
  );

  it(
    "operative recalls in-session memory across turns",
    async () => {
      if (shouldSkip()) return;
      await chat("Please remember: my favorite color is teal.");
      const reply = await chat("What did I just tell you my favorite color was?");
      expect(reply.reply).toMatch(/\bteal\b/i);
    },
    300_000
  );

  // Intentionally skipped until cross-session memory persistence lands.
  // Remove `.skip` when a hook starts writing compositions/<id>/memory/compiled.md.
  it.skip("cross-session memory file is written", async () => {
    const memoryPath = path.join(COMPOSITION_DIR, "memory", "compiled.md");
    expect(await pathExists(memoryPath)).toBe(true);
    const contents = await fs.readFile(memoryPath, "utf8");
    expect(contents.trim().length).toBeGreaterThan(0);
  });
});
