// Deterministic fake runtime for the gateway HTTP integration test (BRIEF U1).
// Loaded by gateway-pty.mjs via GARRISON_GATEWAY_RUNTIME_STUB so a real prompt
// flows THROUGH the gateway HTTP surface (classify → resolve → log → switch →
// honored token) with no live model. The classifier echoes a keyword-based
// classification; the operative honors the [gateway-route:] annotation.

class FakeSession {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.keys = [];
    this.disposed = false;
  }
  async runTurn({ message }) {
    if (/routing classifier/i.test(message)) {
      const task = String(message).toLowerCase();
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
      return {
        reply: JSON.stringify({ taskType, tier, matchedException: null, contextKind: "integration" }),
        sessionId: "fake-classifier",
      };
    }
    const m = String(message).match(/\[gateway-route: target=(\S+) rule=(\S+) profile=(\S+)\]/);
    const token = m
      ? `[route: ${m[1]} | rule: ${m[2]} | profile: ${m[3]}]`
      : "[route: ? | rule: ? | profile: ?]";
    return { reply: `Acknowledged.\n${token}`, sessionId: "fake-operative" };
  }
  writeKeys(b) {
    this.keys.push(b);
  }
  isAlive() {
    return !this.disposed;
  }
  isDisposed() {
    return this.disposed;
  }
  getClaudeSessionId() {
    return "fake-session";
  }
  status() {
    return { model: this.cfg?.model ?? null };
  }
  dispose() {
    this.disposed = true;
  }
}

export function spawnFn(config) {
  return Promise.resolve(new FakeSession(config));
}

export default spawnFn;
