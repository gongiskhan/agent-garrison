import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
// @ts-ignore — owner ledger
import { openConversation, validateHandoff } from "../packages/claude-pty/src/conversation-store.mjs";
// @ts-ignore
import { recoverableConversations, recoverInterruptedStretch, originalRequest, deploymentInFlight, cancelConversationDeployment } from "../fittings/seed/http-gateway/scripts/lib/conversation-recovery.mjs";
// @ts-ignore
import { buildStretchBrief, applyFlowPolicy, runStretch } from "../fittings/seed/http-gateway/scripts/lib/stretch.mjs";
// @ts-ignore
import { requestDeployment, runWorker, launchWorker, deploymentEnv } from "../scripts/garrison-supervised-deploy.mjs";
// @ts-ignore
import { hostedCommandRejection } from "../fittings/seed/agent-sdk-runtime/lib/hosted-process-guard.mjs";
// @ts-ignore
import { AgentSdkAdapter } from "../fittings/seed/agent-sdk-runtime/lib/agent-sdk-adapter.mjs";
// @ts-ignore
import { stretchProcessEnv } from "../fittings/seed/http-gateway/scripts/lib/stretch-process-env.mjs";

let tmp: string;
let env: Record<string, string>;
const start = (store: any, id = "st_interrupted", duty = "implement") => store.append({
  kind: "stretch-started", stretch: id, duty, runId: "default@old-process",
  payload: { stretchId: id, duty, cwd: "/project", project: "project" },
});
const handoff = (over: any = {}) => ({
  v: 1, stretchId: "st_interrupted", duty: "implement", status: "complete", completion: "work",
  summary: "Changes saved; verify the result", evidenceRefs: [], nextSteps: { next: "test", why: "verification", items: ["Run the acceptance check"] },
  blocker: null, activeConstraints: [], failedApproaches: [], surprises: [], forceEscalation: null, synthesized: false, ...over,
});
beforeEach(() => { tmp = mkdtempSync(path.join(os.tmpdir(), "garrison-operability-")); env = { GARRISON_HOME: tmp }; });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("interrupted native stretches", () => {
  it("recovers the owner output once, carries effects to verify, and leaves other compositions alone", () => {
    const store = openConversation("recovery", { role: "gateway", env });
    store.init();
    store.append({ kind: "user-message", payload: { text: "Fix the compact mobile controls" } });
    start(store);
    store.append({ kind: "session-event", stretch: "st_interrupted", payload: { id: "output", blocks: [
      { type: "tool_use", name: "Bash", input: "npm run node:reload" },
      { type: "tool_result", text: "build started" },
    ] } });
    expect(recoverableConversations({ env, compositionId: "different" })).toEqual([]);
    expect(recoverableConversations({ env, compositionId: "default" })).toEqual(["recovery"]);
    const recovery = recoverInterruptedStretch(store);
    expect(recovery).toMatchObject({ parked: false, handoff: { status: "partial", nextSteps: { next: "implement" } } });
    const context = readFileSync(recovery.context, "utf8");
    expect(context).toContain("build started");
    expect(context).toContain("Verify those effects before repeating");
    expect(validateHandoff(recovery.handoff, { selectedDuties: ["implement"] }).ok).toBe(true);
    expect(recoverInterruptedStretch(store)).toBeNull();
    expect(recoverableConversations({ env, compositionId: "default" })).toEqual(["recovery"]);
    store.append({ kind: "handoff", duty: "implement", payload: handoff({ nextSteps: { next: "done", why: "verified", items: [] } }) });
    expect(recoverableConversations({ env, compositionId: "default" })).toEqual([]);
  });

  it("never steals a live stretch and parks repeated crashes until a fresh user message", () => {
    const store = openConversation("live", { role: "gateway", env });
    store.init(); start(store); store.claimStretch("st_interrupted");
    expect(recoverInterruptedStretch(store)).toBeNull();
    store.releaseStretch("st_interrupted");
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) start(store, "st_retry" + attempt);
      expect(recoverInterruptedStretch(store).parked).toBe(attempt === 2);
    }
    expect(store.tail(1, { kinds: ["handoff"] })[0].payload.nextSteps.next).toBe("needs-input");
    store.append({ kind: "user-message", payload: { text: "Service restored; continue" } });
    start(store, "st_fresh");
    expect(recoverInterruptedStretch(store).parked).toBe(false);
  });

  it("preserves a handoff committed just before shutdown instead of repeating its duty", () => {
    const store = openConversation("committed", { role: "gateway", env });
    store.init(); start(store);
    store.append({ kind: "handoff", stretch: "st_interrupted", duty: "implement", payload: handoff() });
    expect(recoverInterruptedStretch(store).handoff.nextSteps.next).toBe("test");
    expect(store.count("handoff")).toBe(1);
  });

  it("retains an unfinished request across pauses but starts a fresh objective after Stop or Done", () => {
    const store = openConversation("objective-cycle", { role: "gateway", env }); store.init();
    store.append({ kind: "user-message", payload: { text: "First request" } });
    store.append({ kind: "handoff", payload: handoff({ nextSteps: { next: "needs-input", why: "clarify", items: [] } }) });
    store.append({ kind: "user-message", payload: { text: "Clarification" } });
    expect(originalRequest(store)).toBe("First request");
    store.append({ kind: "handoff", payload: handoff({ cancelled: true }) });
    store.append({ kind: "user-message", payload: { text: "Second request" } });
    expect(originalRequest(store)).toBe("Second request");
    store.append({ kind: "handoff", payload: handoff({ nextSteps: { next: "done", why: "finished", items: [] } }) });
    store.append({ kind: "user-message", payload: { text: "Third request" } });
    expect(originalRequest(store)).toBe("Third request");
  });

  it("carries the complete original request, latest remaining steps and failed approaches in the next brief", () => {
    const store = openConversation("brief", { role: "gateway", env }); store.init();
    const request = "Fix this. " + "context ".repeat(1300) + "Keep mobile usable.";
    store.append({ kind: "user-message", payload: { text: request } });
    const objective = originalRequest(store);
    expect(objective).toContain("Read it before acting");
    expect(readFileSync(path.join(store.dir, "payloads/original-request.md"), "utf8")).toBe(request);
    const brief = buildStretchBrief({ conversationId: "brief", conversationDir: store.dir, objective, duty: "test",
      handoffPath: store.handoffPath(2), stretchId: "st_2", selectedDuties: ["test"],
      lastHandoffs: [{ ordinal: 1, handoff: handoff({ failedApproaches: [{ approach: "Restart the parent", why: "lost the conversation" }] }) }] });
    expect(brief).toContain("Remaining: Run the acceptance check");
    expect(brief).toContain("Do not repeat: Restart the parent");
    expect(brief).toContain("HOSTED NODE DEPLOYMENT");
    expect(brief).toContain('evidenceRefs kind "run" or "gate"');
    expect(brief).toContain("Reuse already-completed checks");
  });

  it("keeps partial output on a runtime crash and cancels a late admission after its timeout", async () => {
    let stops = 0;
    let release = 0;
    const gateway = { compositionDir: tmp,
      async runAgentSdkTurn(_route: any, _brief: string, chunk: any, hooks: any) {
        chunk("Saved the file; tests are still running");
        await new Promise((r) => setTimeout(r, 30));
        hooks.registerStop(() => { stops++; });
        throw new Error("lost connection");
      },
      async releaseConversationSessions() { release++; },
    };
    const result = await runStretch(gateway, { route: { target: { runtime: "agent-sdk" } },
      brief: "test", stretchId: "st_late", env, timeoutMs: 10 });
    await new Promise((r) => setTimeout(r, 40));
    expect(result).toMatchObject({ ok: false, reply: "Saved the file; tests are still running" });
    expect(stops).toBe(1);
    expect(release).toBe(1);
  });
});

describe("completion evidence", () => {
  it("keeps unfinished verification on the work rail when a follow-up enters through responder", () => {
    const store = openConversation("follow-up-proof", { role: "gateway", env }); store.init();
    start(store, "st_test", "test");
    store.append({ kind: "handoff", duty: "test", payload: handoff({ duty: "test", status: "partial", nextSteps: { next: "needs-input", why: "missing report", items: [] } }) });
    const input = { store, duty: "responder", selectedDuties: ["test"], cwd: tmp, env };
    expect(applyFlowPolicy("done", input).next).toBe("test");
    store.append({ kind: "handoff", duty: "test", payload: handoff({ duty: "test", nextSteps: { next: "done", why: "verified", items: [] } }) });
    expect(applyFlowPolicy("done", input).next).toBe("done");
  });

  it("accepts the current proof and gives verification one bounded chance to record missing results", () => {
    const store = openConversation("proof", { role: "gateway", env }); store.init();
    const proof = path.join(tmp, "check.txt"); writeFileSync(proof, "passed");
    const input = { store, duty: "test", selectedDuties: ["test"], cwd: tmp, env };
    expect(applyFlowPolicy("done", { ...input, handoff: handoff({ evidenceRefs: [{ kind: "run", ref: proof }] }) }).next).toBe("done");
    const missing = applyFlowPolicy("done", input);
    expect(missing).toMatchObject({ next: "test", reason: "verification-evidence-missing", verificationMissing: true });
    expect(missing.items[0]).toContain("actual commands/checks");
    store.append({ kind: "policy-rewrite", payload: { reason: missing.reason } });
    expect(applyFlowPolicy("done", input).next).toBe("needs-input");
    expect(applyFlowPolicy("done", { ...input, handoff: handoff({ evidenceRefs: [{ kind: "file", ref: proof }] }) }).next).toBe("needs-input");
    expect(applyFlowPolicy("done", { ...input, handoff: handoff({ evidenceRefs: [{ kind: "run", ref: proof }] }) }).next).toBe("done");
  });
});

describe("hosted node deployment", () => {
  function setup() {
    const store = openConversation("deploy", { role: "gateway", env }); store.init(); start(store, "st_deploy", "ops");
    store.claimStretch("st_deploy");
    const hosted = { ...env, GARRISON_CONVERSATION_ID: "deploy", GARRISON_STRETCH_ID: "st_deploy", GARRISON_INSTANCE_ID: "node" };
    return { store, hosted, file: path.join(store.dir, "deployment.json") };
  }
  it("refuses a hosted restart without launching a worker or releasing its stretch", () => {
    const { store, hosted } = setup();
    let launches = 0;
    expect(() => requestDeployment({ env: hosted, launch: () => { launches++; } })).toThrow("working Conversation");
    expect(launches).toBe(0);
    expect(store.currentStretch()).toBe("st_deploy");
  });

  it("cancels a legacy queued deployment without stopping or resuming work", async () => {
    const { store, file } = setup();
    writeFileSync(file, JSON.stringify({ status: "queued", conversationId: "deploy", home: tmp }));
    let called = false;
    await runWorker(file, { run: async () => { called = true; }, resume: async () => { called = true; } });
    expect(called).toBe(false);
    expect(store.currentStretch()).toBe("st_deploy");
    expect(JSON.parse(readFileSync(file, "utf8")).status).toBe("cancelled");
    expect(deploymentInFlight(store)).toBeNull();
  });

  it("protects the hosting process in actual SDK hook options, without changing unrelated commands", async () => {
    const hosted = { GARRISON_STRETCH_ID: "st_x", GARRISON_HOST_PIDS: "123,456" };
    const adapter = new AgentSdkAdapter();
    const opts = adapter.buildQueryOptions({ queryAssembly: { permissionMode: "bypassPermissions" }, config: { env: hosted } });
    const hook = opts.hooks.PreToolUse[0].hooks[0];
    expect((await hook({ tool_name: "Bash", tool_input: { command: "kill -9 123" } })).hookSpecificOutput.permissionDecision).toBe("deny");
    for (const command of ['pkill -f "garrison.*dev"', " sudo pkill -9 -f 'node.*garrison'", "systemctl --user restart garrison-prod"]) {
      expect(hostedCommandRejection("Bash", { command }, hosted)).toContain("Deploy another mesh node");
    }
    for (const command of ["npm test", "npm run node:redeploy", "kill -9 999", 'rg "pkill.*node" docs/']) {
      expect(await hook({ tool_name: "Bash", tool_input: { command } })).toEqual({});
    }
    expect(opts.permissionMode).toBe("bypassPermissions");
    const base = { NEXT_DIST_DIR: ".next-prod", PATH: "/bin", HOME: tmp };
    expect(stretchProcessEnv(base, {})).toBe(base);
    expect(stretchProcessEnv(base, { conversationId: "c", stretchId: "s" })).not.toHaveProperty("NEXT_DIST_DIR");
  });
});
