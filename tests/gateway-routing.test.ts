import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs routing layer
import { createRoutedGateway } from "../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs";

// U1 — Live gateway routing (the committed, re-runnable GATE).
//
// Drives the REAL RoutedGateway the gateway wires (createRoutedGateway → the
// same MultiRuntimePool + routing-core + stage-b + telemetry), with the leaf
// session factory stubbed by a deterministic FakeSession. No live model: the
// classifier echoes a keyword-based classification, the operative honors the
// gateway-route annotation. Asserts the full Stage-A path end to end:
// classify → resolve → LOG at resolution → pool serves → honored token, and a
// second prompt resolving to a different {model,effort} drives the in-place
// slash-inject switch. The live counterpart (real claude) is
// scripts/probe-live-gateway.mjs.

class FakeSession {
  cfg: any;
  keys: string[] = [];
  disposed = false;
  constructor(cfg: any) {
    this.cfg = cfg;
  }
  async runTurn({ message }: { message: string }) {
    if (/routing classifier/i.test(message)) {
      const task = message.toLowerCase();
      let taskType = "other";
      let tier = "T1-standard";
      if (/(login|unit test|fix the)/.test(task)) {
        taskType = "code";
        tier = "T1-standard";
      }
      if (/(2 plus 2|quick:)/.test(task)) {
        taskType = "other";
        tier = "T0-trivial";
      }
      return { reply: JSON.stringify({ taskType, tier, matchedException: null, contextKind: "unit" }), sessionId: "fake-classifier" };
    }
    // operative turn — honor the gateway-route annotation as the reply token
    const m = message.match(/\[gateway-route: target=(\S+) rule=(\S+) profile=(\S+)\]/);
    const token = m ? `[route: ${m[1]} | rule: ${m[2]} | profile: ${m[3]}]` : "[route: ? | rule: ? | profile: ?]";
    return { reply: `Working on it.\n${token}`, sessionId: "fake-operative" };
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
    return { model: this.cfg?.model };
  }
  dispose() {
    this.disposed = true;
  }
}

function readDecisions(file: string): any[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function bootGateway() {
  const tmp = mkdtempSync(join(tmpdir(), "gar-gwroute-"));
  const decisionsFile = join(tmp, "decisions.jsonl");
  const spawnFn = (cfg: any) => Promise.resolve(new FakeSession(cfg));
  const gw = await createRoutedGateway({
    compositionDir: tmp,
    decisionsFile,
    spawnFn,
    logFn: () => {},
  });
  gw.injectSettleMs = 1;
  await gw.start();
  return { gw, tmp, decisionsFile };
}

describe("U1 — gateway Stage-A live routing (live-route-ok)", () => {
  it("classifies → resolves → logs at resolution → pool serves → honored token", async () => {
    const { gw, decisionsFile } = await bootGateway();
    try {
      const msg = "fix the failing login unit test";
      const pre = await gw.preRoute(msg);

      // resolved the standard role → cc-sonnet-med
      expect(pre.route.targetId).toBe("cc-sonnet-med");
      expect(pre.route.profile).toBe("balanced");

      // logged AT RESOLUTION TIME — before the operative turn runs
      let decisions = readDecisions(decisionsFile);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].targetId).toBe("cc-sonnet-med");
      expect(decisions[0].profile).toBe("balanced");
      expect(decisions[0].role).toBe("standard");

      // the pool served the operative session
      const served = gw.servedStatus();
      expect(served.operative.checkedOut).toBeGreaterThanOrEqual(1);
      expect(served.classifier.checkedOut).toBeGreaterThanOrEqual(1);

      // run the operative turn (what gateway-pty does between preRoute/postTurn)
      const sess = gw.getOperativeSession();
      const out = await sess.runTurn({ message: `${pre.annotation}\n${msg}` });
      const honored = await gw.postTurn(pre.route, pre.decision, out.reply);
      expect(honored.honored).toBe(true);

      // honored → no extra misroute record appended
      decisions = readDecisions(decisionsFile);
      expect(decisions).toHaveLength(1);
    } finally {
      gw.shutdown();
    }
  });

  it("honors an EXPLICIT {taskType,tier} classification over keyword classification (Kanban Loop §10)", async () => {
    const { gw, decisionsFile } = await bootGateway();
    try {
      // this message alone keyword-classifies to trivial → fast → cc-haiku-low …
      const baseline = await gw.preRoute("quick: what is 2 plus 2");
      expect(baseline.route.targetId).toBe("cc-haiku-low");
      // … but an explicit deep-code classification (what the Kanban engine sends) must
      // be HONORED → expert → cc-opus-high, regardless of the message keywords.
      const pre = await gw.preRoute("quick: what is 2 plus 2", {
        classification: { taskType: "code", tier: "T2-deep" },
        skill: "garrison-implement",
      });
      expect(pre.route.targetId).toBe("cc-opus-high");
      expect(pre.route.role).toBe("expert");
      const decisions = readDecisions(decisionsFile);
      expect(decisions[decisions.length - 1].targetId).toBe("cc-opus-high");
    } finally {
      gw.shutdown();
    }
  });

  it("does NOT honor an OUT-OF-VOCAB explicit classification — falls back to the message classifier (s5 r3)", async () => {
    const { gw } = await bootGateway();
    try {
      // a bogus taskType must be rejected (not blindly trusted) → classify the message
      // instead → "quick: what is 2 plus 2" is trivial → fast → cc-haiku-low.
      const pre = await gw.preRoute("quick: what is 2 plus 2", {
        classification: { taskType: "bogus", tier: "T2-deep" },
      });
      expect(pre.route.targetId).toBe("cc-haiku-low");
    } finally {
      gw.shutdown();
    }
  });

  it("logs honored:false when the operative emits a mismatched token", async () => {
    const { gw, decisionsFile } = await bootGateway();
    try {
      const pre = await gw.preRoute("fix the failing login unit test");
      // a reply with the WRONG target token
      const honored = await gw.postTurn(pre.route, pre.decision, "done\n[route: cc-opus-high | rule: x | profile: balanced]");
      expect(honored.honored).toBe(false);
      const decisions = readDecisions(decisionsFile);
      expect(decisions).toHaveLength(2);
      expect(decisions[1].honored).toBe(false);
    } finally {
      gw.shutdown();
    }
  });
});

describe("D18 — execution has left the classification", () => {
  it("preRoute output and the decisions.jsonl record carry NO execution field", async () => {
    const { gw, decisionsFile } = await bootGateway();
    try {
      // The classifier parser still attaches a legacy `execution`; preRoute strips
      // it, so neither the returned classification, the decision, nor the logged
      // record surfaces an execution axis (D18: where work runs is derived from the
      // phase plan, not a per-turn flag).
      const pre = await gw.preRoute("fix the failing login unit test");
      expect(pre.classification).not.toHaveProperty("execution");
      expect(pre.decision).not.toHaveProperty("execution");
      const decisions = readDecisions(decisionsFile);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).not.toHaveProperty("execution");
      // the axis it REPLACED still resolves a target — routing is unaffected
      expect(pre.route.targetId).toBe("cc-sonnet-med");
    } finally {
      gw.shutdown();
    }
  });
});

describe("U1 — gateway in-place switch (live-switch-ok)", () => {
  it("a second prompt resolving to a different {model,effort} slash-injects onto the target", async () => {
    const { gw, decisionsFile } = await bootGateway();
    try {
      // turn 1: standard → cc-sonnet-med (sonnet/medium)
      const pre1 = await gw.preRoute("fix the failing login unit test");
      expect(pre1.route.targetId).toBe("cc-sonnet-med");
      const sess = gw.getOperativeSession();
      await sess.runTurn({ message: `${pre1.annotation}\nfix the failing login unit test` });
      await gw.postTurn(pre1.route, pre1.decision, `ok\n[route: cc-sonnet-med | rule: ${pre1.route.ruleId} | profile: balanced]`);

      // turn 2: trivial → fast → cc-haiku-low (haiku/low): model + effort change
      const pre2 = await gw.preRoute("quick: what is 2 plus 2");
      expect(pre2.route.targetId).toBe("cc-haiku-low");
      expect(pre2.plan.path).toBe("slash-inject");
      expect(pre2.plan.injections).toContain("/model haiku");
      expect(pre2.plan.injections).toContain("/effort low");

      // the live operative session actually received the slash injections
      const injected = sess.keys.join("");
      expect(injected).toContain("/model haiku");
      expect(injected).toContain("/effort low");

      // and the gateway now considers the operative to be on the haiku target
      expect(gw.currentTarget.model).toBe("haiku");

      // both decisions logged
      const decisions = readDecisions(decisionsFile);
      expect(decisions.map((d) => d.targetId)).toEqual(["cc-sonnet-med", "cc-haiku-low"]);
    } finally {
      gw.shutdown();
    }
  });
});

// S4 (GARRISON-RUNTIMES-V1 P4): the pool warms the adapter named by the
// policy's primary — resolved to an engine by the runner and handed down as
// primaryEngine. Stub adapters prove WHICH adapter backs the operative entry;
// loud-error paths prove a missing fitting or unknown engine never silently
// falls back to claude-code.
// @ts-ignore — pure .mjs routing layer
import { resolvePrimaryAdapter } from "../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs";

describe("primary runtime warm seam (S4)", () => {
  const baseCtx = (extra: any = {}) => ({
    compositionDir: mkdtempSync(join(tmpdir(), "gar-p4-")),
    spawnFn: null,
    operativeSpawnConfig: { compositionDir: "/tmp/x", model: "sonnet", appendSystemPromptFile: undefined },
    opts: { probeExecPrimaries: false, ...extra }
  });

  it("claude-code returns the historical ClaudeCodeAdapter construction", async () => {
    const p = await resolvePrimaryAdapter("claude-code", baseCtx());
    expect(p.claude).toBe(true);
    expect(p.adapter?.constructor?.name).toBe("ClaudeCodeAdapter");
    expect(p.spawnConfig.model).toBe("sonnet");
  });

  it("agent-sdk uses the injected adapter and full prompt mode", async () => {
    const fake = { spawn: async () => ({}) };
    const p = await resolvePrimaryAdapter("agent-sdk", baseCtx({ agentSdkAdapter: fake }));
    expect(p.adapter).toBe(fake);
    expect(p.spawnConfig.promptMode).toBe("full");
    expect(p.spawnConfig.provider).toBe("anthropic");
  });

  it("agent-sdk primary resolves via the dev-checkout fallback (documented) but FAILS LOUD on an unreadable assembled prompt", async () => {
    // In a dev checkout resolveAgentSdkDir's repo fallback always resolves —
    // the not-installed throw is only reachable in a real deployment. The
    // reachable loud path here: a prompt FILE that cannot be read must throw
    // (the SDK needs the bytes, not the path), never spawn promptless.
    const ctx = baseCtx();
    ctx.operativeSpawnConfig.appendSystemPromptFile = "/nonexistent/assembled-system-prompt.md" as any;
    await expect(resolvePrimaryAdapter("agent-sdk", ctx)).rejects.toThrow(
      /assembled system prompt unreadable at \/nonexistent/
    );
  });

  it("codex primary uses an injected secondary adapter without probing", async () => {
    const fake = { spawn: async () => ({}) };
    const p = await resolvePrimaryAdapter("codex", baseCtx({ secondaryAdapters: new Map([["codex", fake]]) }));
    expect(p.adapter).toBe(fake);
  });

  it("an unknown engine FAILS LOUD naming the known set and the fix", async () => {
    await expect(resolvePrimaryAdapter("opencode", baseCtx())).rejects.toThrow(
      /unknown primary engine "opencode".*claude-code, agent-sdk, codex, gemini.*composer/
    );
  });
});

// Ratchet for the S4 codex findings: the probe's TIMEOUT path reaps the child
// before rejecting and its error names the cause, the stderr context, and the
// remediation — same loudness contract as a failed exit.
// @ts-ignore — pure .mjs routing layer
import { probeRuntimeBridge } from "../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs";
import { mkdirSync as mkd, writeFileSync as wfs } from "node:fs";

describe("probeRuntimeBridge timeout loudness (S4 ratchet)", () => {
  it("a hanging bridge times out with cause + remediation in the error, after the child closes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gar-probe-"));
    mkd(join(dir, "scripts"), { recursive: true });
    wfs(join(dir, "scripts", "bridge.mjs"), "console.error('warming up'); setInterval(() => {}, 1000);\n");
    await expect(probeRuntimeBridge(dir, "codex", { timeoutMs: 1500 })).rejects.toThrow(
      /codex runtime probe FAILED \(timed out after 1500ms\).*warming up.*switch primaryRuntime back to claude-code-runtime/s
    );
  });

  it("a failing bridge rejects with exit code + stderr + remediation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gar-probe-"));
    mkd(join(dir, "scripts"), { recursive: true });
    wfs(join(dir, "scripts", "bridge.mjs"), "console.error('cli not authenticated'); process.exit(3);\n");
    await expect(probeRuntimeBridge(dir, "gemini", { timeoutMs: 5000 })).rejects.toThrow(
      /gemini runtime probe FAILED \(exit 3\).*cli not authenticated.*install\/authenticate/s
    );
  });
});
