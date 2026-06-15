import { describe, it, expect } from "vitest";
// @ts-ignore — pure .mjs package
import { runAdapterConformance, ADAPTER_METHODS, ClaudeCodeAdapter } from "../packages/claude-pty/src/index.mjs";

// A stub adapter — in-memory, no live model — that satisfies the RuntimeAdapter
// contract. Proves the conformance harness drives spawn→awaitReady→sendTurn→
// awaitResponse→teardown without a real runtime (deterministic gate).
class StubAdapter {
  id = "stub-runtime";
  _queued = new WeakMap<object, string>();
  spawned = 0;
  torndown = 0;
  async spawn(config: any) {
    this.spawned++;
    return { alive: true, cwd: config?.compositionDir };
  }
  async awaitReady(session: any) {
    if (!session.alive) throw new Error("not ready");
  }
  async sendTurn(session: any, text: string) {
    this._queued.set(session, `echo:${text}`);
  }
  async awaitResponse(session: any) {
    return { text: this._queued.get(session) ?? "", artifacts: [] };
  }
  async setModel() {}
  async setEffort() {}
  async resume(config: any) {
    return { alive: true, resumed: true, cwd: config?.compositionDir };
  }
  async teardown(session: any) {
    this.torndown++;
    session.alive = false;
  }
}

describe("RuntimeAdapter conformance (MRr-adapter — adapter-contract-ok)", () => {
  it("the conformance harness drives a stub adapter through the full lifecycle", async () => {
    const adapter = new StubAdapter();
    const report = await runAdapterConformance(adapter, { turnText: "ping" });
    expect(report.ok).toBe(true);
    expect(report.runtime).toBe("stub-runtime");
    const stepNames = report.steps.map((s: any) => s.name);
    for (const m of ADAPTER_METHODS) expect(stepNames).toContain(`has:${m}`);
    for (const step of ["spawn", "awaitReady", "sendTurn", "awaitResponse", "teardown"]) {
      const s = report.steps.find((x: any) => x.name === step);
      expect(s?.ok, `${step} should pass`).toBe(true);
    }
    expect(adapter.spawned).toBe(1);
    expect(adapter.torndown).toBe(1);
  });

  it("awaitResponse returns the per-turn text (the hardest primitive)", async () => {
    const adapter = new StubAdapter();
    const session = await adapter.spawn({ compositionDir: "/tmp/x" });
    await adapter.sendTurn(session, "hello");
    const resp = await adapter.awaitResponse(session);
    expect(resp.text).toBe("echo:hello");
  });

  it("conformance fails loudly when an adapter is missing a method", async () => {
    const broken: any = new StubAdapter();
    broken.awaitResponse = undefined; // shadow the prototype method
    const report = await runAdapterConformance(broken);
    expect(report.ok).toBe(false);
    expect(report.steps.find((s: any) => s.name === "has:awaitResponse")?.ok).toBe(false);
  });

  it("the ClaudeCodeAdapter reference implements every contract method", () => {
    const cc = new ClaudeCodeAdapter();
    expect(cc.id).toBe("claude-code");
    for (const m of ADAPTER_METHODS) expect(typeof (cc as any)[m]).toBe("function");
  });
});
