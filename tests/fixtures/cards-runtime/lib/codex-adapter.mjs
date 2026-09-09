import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// The live HTTP journey harness keeps the real gateway and launcher. Its
// isolated runtime is a controllable child process so exit, kill and resume
// can be asserted without changing a user's files or running billable work.
export class CodexAdapter {
  async spawn(config) { return { config, alive: true, effortApplied: true }; }
  async awaitReady() {}
  async sendTurn(runtime, brief) {
    runtime.stretchId = /stretchId: (.+)/.exec(brief)?.[1].trim();
    runtime.duty = /## Your duty: ([^ ]+)/.exec(brief)?.[1];
    runtime.handoffPath = /handoffPath: (.+)/.exec(brief)?.[1].trim();
    const root = path.join(process.env.GARRISON_HOME, "controlled-runtime");
    fs.mkdirSync(root, { recursive: true });
    const release = path.join(root, `${runtime.stretchId}.release`);
    runtime.child = spawn(process.execPath, ["-e", "const fs=require('fs'); const timer=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(timer);process.exit(0)}},25)", release]);
    runtime.result = new Promise((resolve) => runtime.child.once("exit", (code, signal) => {
      runtime.alive = false;
      if (!signal && code === 0) fs.writeFileSync(runtime.handoffPath, JSON.stringify({
        v: 1, stretchId: runtime.stretchId, duty: runtime.duty, status: "complete", summary: "The requested check is complete.",
        completion: "answer", evidenceRefs: [], nextSteps: { next: "done", why: "The requested check is complete", items: [] },
        blocker: null, activeConstraints: [], failedApproaches: [], surprises: [], forceEscalation: null, synthesized: false,
      }));
      resolve({ text: signal ? "Stopped." : "The requested check is complete.", usedTokens: 7, ...(signal ? { stoppedReason: "cancelled" } : {}) });
    }));
    fs.appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify({ pid: runtime.child.pid, stretchId: runtime.stretchId, brief, model: runtime.config.model, effort: runtime.config.effort, release }) + "\n");
  }
  async awaitResponse(runtime) { return runtime.result; }
  async cancel(runtime) { runtime.child?.kill("SIGTERM"); }
  async teardown(runtime) { if (runtime.alive) runtime.child?.kill("SIGTERM"); runtime.alive = false; }
}
