// Only the runtime leaf is replaced. The real HTTP gateway still owns routing,
// admission, cancellation, the Codex lock, handoffs and the durable ledger.
import fs from "node:fs";
import path from "node:path";

function record(session, kind, extra = {}) {
  fs.appendFileSync(path.join(process.env.GARRISON_HOME, "runtime-calls.jsonl"), `${JSON.stringify({
    kind, model: session.config.model, effort: session.config.effort,
    cwd: session.config.compositionDir, stretchId: session.stretchId, ...extra,
  })}\n`);
}

export class CodexAdapter {
  async spawn(config) { return { config, alive: true, effortApplied: true }; }
  async awaitReady() {}
  async sendTurn(session, brief) {
    session.stretchId = /stretchId: (.+)/.exec(brief)?.[1].trim();
    const duty = /## Your duty: ([^ ]+)/.exec(brief)?.[1];
    const handoffPath = /handoffPath: (.+)/.exec(brief)?.[1].trim();
    session.hold = brief.includes("HOLD_HTTP_TEST");
    record(session, "turn", { duty, brief });
    if (!session.hold) {
      fs.writeFileSync(handoffPath, JSON.stringify({
        v: 1, stretchId: session.stretchId, duty,
        status: "complete", summary: "The isolated gateway test answered.", evidenceRefs: [],
        nextSteps: { next: "needs-input", why: "waiting for another message", items: [] },
        blocker: { what: "next question", needs: "user input", who: "user" },
        activeConstraints: [], failedApproaches: [], surprises: [], forceEscalation: null, synthesized: false,
      }));
    }
  }
  async awaitResponse(session) {
    if (session.hold) return await new Promise((resolve) => { session.finish = resolve; });
    return { text: "The isolated gateway test answered.", usedTokens: 7 };
  }
  async cancel(session) {
    record(session, "cancel");
    session.finish?.({ text: "Stopped.", stoppedReason: "cancelled" });
    session.alive = false;
  }
  async teardown(session) { session.alive = false; }
}
