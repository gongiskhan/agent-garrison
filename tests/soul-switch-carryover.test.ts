import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import path from "node:path";
// @ts-ignore — pure .mjs
import { buildContextCarryover, buildRespawnOpts } from "../fittings/seed/orchestrator/lib/stage-b.mjs";
// @ts-ignore — pure .mjs
import { createRoutedGateway } from "../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs";

// U4 — soul-switch context preservation (soul-switch-ok), committed gate.
// `claude --continue` is unreliable for ephemeral sessions on 2.1.x, so the
// self-unblock is a CARRYOVER FALLBACK: on a soul/provider respawn, re-inject a
// compact summary of the recent turns as the next turn's preamble. This verifies
// the fallback deterministically; scripts/probe-soul-switch.mjs proves it live.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEED = JSON.parse(readFileSync(join(REPO_ROOT, "fittings/seed/orchestrator/config/routing.seed.json"), "utf8"));

class FakeSession {
  cfg: any;
  keys: string[] = [];
  disposed = false;
  constructor(cfg: any) {
    this.cfg = cfg;
  }
  async runTurn({ message }: { message: string }) {
    if (/routing classifier/i.test(message)) {
      // "deep" prompts → code/T2-deep (→ expert role)
      const deep = /(deep|refactor|subsystem|architecture)/i.test(message);
      return {
        reply: JSON.stringify({ taskType: "code", tier: deep ? "T2-deep" : "T1-standard", matchedException: null }),
        sessionId: "fake-classifier",
      };
    }
    const m = message.match(/\[gateway-route: target=(\S+) rule=(\S+) profile=(\S+)\]/);
    const token = m ? `[route: ${m[1]} | rule: ${m[2]} | profile: ${m[3]}]` : "[route: ?]";
    return { reply: `ok\n${token}`, sessionId: "fake-op" };
  }
  writeKeys(b: string) {
    this.keys.push(b);
  }
  isAlive() {
    return !this.disposed;
  }
  isDisposed() {
    return this.disposed;
  }
  getClaudeSessionId() {
    return "fake";
  }
  status() {
    return {};
  }
  dispose() {
    this.disposed = true;
  }
}

describe("U4 — buildContextCarryover (the fallback summary)", () => {
  it("builds a compact summary carrying the prior facts", () => {
    const carry = buildContextCarryover([
      { role: "user", text: "Remember the codeword GARRISON-ZEBRA-42." },
      { role: "assistant", text: "stored the codeword GARRISON-ZEBRA-42" },
    ]);
    expect(carry).toContain("context carried over");
    expect(carry).toContain("GARRISON-ZEBRA-42");
    expect(carry).toContain("User:");
    expect(carry).toContain("You:");
  });

  it("returns empty string when there are no prior turns", () => {
    expect(buildContextCarryover([])).toBe("");
    expect(buildContextCarryover(null as any)).toBe("");
  });

  it("caps the summary length", () => {
    const big = [{ role: "user", text: "x".repeat(5000) }];
    expect(buildContextCarryover(big, { maxChars: 200 }).length).toBeLessThan(400);
  });

  it("buildRespawnOpts flags providerLaunch for a non-anthropic provider", () => {
    const ollama = buildRespawnOpts({ provider: "ollama-local", model: "qwen2.5-coder" }, { baseEnv: {}, secrets: {} });
    expect(ollama.providerLaunch).toBe(true);
    const plan = buildRespawnOpts({ provider: "anthropic-plan", model: "opus" }, { baseEnv: {} });
    expect(plan.providerLaunch).toBe(false);
  });
});

describe("U4 — RoutedGateway re-injects carryover on a respawn (soul-switch-ok)", () => {
  it("a provider switch respawns and the next turn's annotation carries prior context", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gar-soul-gw-"));
    // economy: expert → cc-ollama-qwen (ollama-local provider) ⇒ respawn-resume
    const config = { ...SEED, activeProfile: "economy" };
    const gw = await createRoutedGateway({
      compositionDir: tmp,
      config,
      decisionsFile: join(tmp, "decisions.jsonl"),
      spawnFn: (cfg: any) => Promise.resolve(new FakeSession(cfg)),
      initialTarget: { provider: "anthropic-plan", model: "sonnet", effort: null },
      logFn: () => {},
    });
    await gw.start();

    // seed a prior turn carrying a codeword
    gw._lastTurns = [
      { role: "user", text: "my codeword is GARRISON-ZEBRA-42" },
      { role: "assistant", text: "stored" },
    ];

    // a deep prompt → expert → cc-ollama-qwen (ollama) ⇒ provider change ⇒ respawn
    const pre = await gw.preRoute("do a deep refactor of the auth subsystem");
    expect(pre.route.targetId).toBe("cc-ollama-qwen");
    expect(pre.plan.path).toBe("respawn-resume");
    expect(pre.carried).toBe(true);
    expect(pre.annotation).toContain("context carried over");
    expect(pre.annotation).toContain("GARRISON-ZEBRA-42");
    gw.shutdown();
  });
});
