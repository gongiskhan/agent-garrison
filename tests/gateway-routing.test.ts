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
