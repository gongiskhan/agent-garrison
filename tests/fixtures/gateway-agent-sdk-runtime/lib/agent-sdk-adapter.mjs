// Hermetic Agent SDK adapter for real gateway process tests. It preserves the
// production adapter contract while answering only the bounded dispatch-fast
// inference turn; no network, credentials, tools, or conversational session.
export class AgentSdkAdapter {
  async spawn(config = {}) {
    return { alive: true, config, prompt: "", sessionId: "dispatch-fixture" };
  }

  async awaitReady() {}

  async sendTurn(session, prompt) {
    session.prompt = String(prompt ?? "");
  }

  async awaitResponse(session) {
    const task = session.prompt.match(/Task:\s*"""([\s\S]*?)"""/)?.[1] ?? "";
    const code = /\b(fix|code|test|login|implement|build|feature)\b/i.test(task);
    return {
      text: JSON.stringify({
        duty: code ? "code" : "other",
        level: 1,
        confidence: "high",
        clarity: "clear",
        reason: "hermetic gateway fixture"
      })
    };
  }

  async cancel(session) {
    session.alive = false;
  }

  async teardown(session) {
    session.alive = false;
  }
}
