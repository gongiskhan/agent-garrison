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
    // A historical conversation title is not the current instruction. The
    // native model gets the latest messages separately from retained context.
    const activeRequest = /## User messages since the last stretch\n([\s\S]*?)(?=\n## |$)/.exec(brief)?.[1]
      ?? /## Original request[^\n]*\n([\s\S]*?)(?=\n## |$)/.exec(brief)?.[1] ?? "";
    session.hold = activeRequest.includes("HOLD_HTTP_TEST");
    const answer = brief.includes("ANSWER_ONLY_HTTP") || (duty === "implement" && brief.includes("MISLABEL_WORK_HTTP"));
    record(session, "turn", { duty, brief });
    if (!session.hold) {
      fs.writeFileSync(handoffPath, JSON.stringify({
        v: 1, stretchId: session.stretchId, duty,
        status: "complete", summary: "The isolated gateway test answered.", evidenceRefs: [],
        ...(answer ? { completion: "answer" } : {}),
        nextSteps: { next: answer ? "done" : "needs-input", why: answer ? "The prose evaluation is complete" : "waiting for another message", items: [] },
        blocker: answer ? null : { what: "next question", needs: "user input", who: "user" },
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
