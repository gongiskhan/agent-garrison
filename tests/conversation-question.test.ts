import { createServer, type Server, type RequestListener } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore
import { openConversation, validateHandoff } from "../packages/claude-pty/src/conversation-store.mjs";
// @ts-ignore
import { pendingConversationQuestion, validConversationQuestion } from "../packages/claude-pty/src/conversation-question.mjs";
// @ts-ignore
import { handleConversationRequest } from "../packages/claude-pty/src/conversation-http.mjs";
// @ts-ignore
import { recordUserMessage } from "../fittings/seed/http-gateway/scripts/lib/stretch.mjs";
// @ts-ignore
import { relayCardConversation } from "../fittings/seed/kanban-loop/lib/conversation-owner.mjs";
import { classifyPeerPath } from "../src/lib/mesh/peer-proxy";

let tmp: string;
let store: any;
const servers: Server[] = [];
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "conversation-question-"));
  store = openConversation("question-test", { role: "gateway", env: { GARRISON_HOME: tmp } });
  store.init({ title: "Question fixture" });
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); })));
  rmSync(tmp, { recursive: true, force: true });
});
const mergeQuestion = { question: "What should happen to the preserved patch?", options: [
  { label: "Drop it - stash", description: "Keep the patch for later." },
  { label: "Drop it - delete", description: "Discard this patch." }, { label: "Merge it in" },
] };
function park(question: any = mergeQuestion, overrides: any = {}) {
  const handoff = { status: "blocked", summary: "A decision is needed", evidenceRefs: [],
    nextSteps: { next: "needs-input", why: "Choose the next step", items: [] },
    blocker: { what: "Preserved patch", needs: "Choose its disposition" },
    activeConstraints: [], failedApproaches: [], surprises: [], ...overrides,
    ...(question === undefined ? {} : { question }) };
  store.append({ kind: "handoff", stretch: "s1", payload: handoff });
  store.append({ kind: "stretch-ended", stretch: "s1", payload: { next: "needs-input" } });
  return handoff;
}
async function listen(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as any).port}`;
}

describe("conversation questions", () => {
  it("validates bounded choices and preserves old handoffs", () => {
    const handoff = park();
    expect(validateHandoff(handoff).ok).toBe(true);
    for (const question of [{ ...mergeQuestion, options: Array(5).fill({ label: "a" }) },
      { ...mergeQuestion, options: [{ label: "a" }, { label: " a " }] },
      { ...mergeQuestion, question: " " }, { ...mergeQuestion, options: [{ label: "a", description: 12 }] }]) {
      expect(validConversationQuestion(question)).toBeFalsy();
      expect(validateHandoff({ ...handoff, question }).ok).toBe(false);
    }
    expect(validateHandoff({ ...handoff, question: null }).ok).toBe(true);
    expect(validConversationQuestion({ question: "What do you need?", options: [] })).toBe(true);
    expect(validateHandoff({ ...handoff, status: "complete", nextSteps: { next: "done", why: "done", items: [] } }).ok).toBe(false);
  });
  it("offers the credential reply on legacy handoffs whose blocker is null", () => {
    park(null, { blocker: null, nextSteps: { next: "needs-input", why: "Credentials need you", items: ["Add the Slack token to the Vault"] } });
    expect(pendingConversationQuestion(store).options).toEqual([{ label: "I have added the keys to the vault" }]);
  });
  it("does not invent destructive replies for a generic pause", () => {
    park(null);
    expect(pendingConversationQuestion(store).options).toEqual([]);
  });
  it.each(["user-message", "stretch-started", "approval-requested"])("expires the question after %s", (kind) => {
    park();
    expect(pendingConversationQuestion(store)?.question).toBe(mergeQuestion.question);
    store.append({ kind, payload: { text: "Continue" } });
    expect(pendingConversationQuestion(store)).toBeNull();
  });
  it("records one answer, dedupes retries after restart, and rejects a second choice", () => {
    park();
    const questionId = pendingConversationQuestion(store).id;
    const request = { text: "Merge it in", questionId, clientRequestId: `answer:${questionId}` };
    expect(recordUserMessage(store, request).ok).toBe(true);
    const reopened = openConversation("question-test", { role: "gateway", env: { GARRISON_HOME: tmp } });
    expect(recordUserMessage(reopened, request).duplicate).toBe(true);
    expect(recordUserMessage(reopened, { ...request, text: "Drop it - delete" }).conflict).toBe(true);
    expect(recordUserMessage(reopened, { ...request, clientRequestId: "different-browser" }).conflict).toBe(true);
    expect(reopened.tail(100, { kinds: ["user-message"] })).toHaveLength(1);
  });
  it("rejects a stale question after a normal composer reply", () => {
    park();
    const questionId = pendingConversationQuestion(store).id;
    recordUserMessage(store, { text: "Actually keep it for now" });
    expect(recordUserMessage(store, { text: "Merge it in", questionId }).conflict).toBe(true);
  });
  it("serves and answers through the real HTTP router with retry after failure", async () => {
    park();
    let reachable = false;
    const base = await listen((req, res) => { void handleConversationRequest(req, res, {
      env: { GARRISON_HOME: tmp }, role: "test",
      forwardMessage: async (input: any) => {
        if (!reachable) return { ok: false, status: 503, error: "fixture offline" };
        const result = recordUserMessage(store, { ...input, text: input.message });
        return { ...result, recorded: result.ok, status: result.conflict ? 409 : 202 };
      },
    }); });
    const root = `${base}/api/conversation/question-test`;
    const { question } = await (await fetch(`${root}/question`)).json();
    const input = { message: "Keep only the tests", questionId: question.id, clientRequestId: "question-retry" };
    const post = (body = input) => fetch(`${root}/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post()).status).toBe(502);
    expect(pendingConversationQuestion(store)?.id).toBe(question.id);
    reachable = true;
    expect((await post()).status).toBe(202);
    expect((await post()).status).toBe(202);
    expect((await post({ ...input, message: "Delete it" })).status).toBe(409);
    expect((await (await fetch(`${root}/question`)).json()).question).toBeNull();
    expect(store.tail(100, { kinds: ["user-message"] })[0].payload.text).toBe("Keep only the tests");
  });
  it("relays the card reply to its owner and refuses frozen card writes", async () => {
    const requests: any[] = [];
    const base = await listen((req, res) => { void relayCardConversation(req, res, {
      card: { placement: { target: "dev-madrid" }, frozen: req.url?.includes("frozen") }, appUrl: "http://shell.invalid",
      fetchImpl: async (url: string, init: any) => { requests.push({ url, body: String(init.body) }); return new Response('{"accepted":true}', { status: 202 }); },
    }); });
    const response = await fetch(`${base}/api/conversation/question-test/message`, { method: "POST", body: '{"message":"Keep it"}' });
    expect(response.status).toBe(202);
    expect(requests).toEqual([{ url: "http://shell.invalid/api/mesh/nodes/dev-madrid/conversation/question-test/message", body: '{"message":"Keep it"}' }]);
    expect((await fetch(`${base}/api/conversation/frozen/message`, { method: "POST", body: '{}' })).status).toBe(409);
    expect(requests).toHaveLength(1);
    expect(classifyPeerPath("POST", ["conversation", "question-test", "message"]).ok).toBe(true);
    expect(classifyPeerPath("GET", ["conversation", "question-test", "question"]).ok).toBe(true);
    expect(classifyPeerPath("POST", ["conversation", "question-test", "payload", "x"]).ok).toBe(false);
  });
});
