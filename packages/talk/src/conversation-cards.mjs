// Board links for web work conversations. The board owns every card write.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openConversation } from "@garrison/claude-pty";
import { getThread, listThreads, setThreadBoardCard, inferredConversationTitle } from "./threads.mjs";

export const cardUrl = (id) => `/embed/kanban-loop?card=${encodeURIComponent(id)}`;
export const conversationUrl = (id, messageId = null) => `/talk?thread=${encodeURIComponent(id)}${messageId == null ? "" : `&message=${encodeURIComponent(messageId)}`}`;
export function isWorkSession(thread) {
  return !!thread && thread.source === "chat" && !thread.shell && !thread.remoteShell && !thread.context?.cardId;
}
export function provisionalTitle(message) {
  const text = String(message).replace(/\s+/g, " ").trim();
  if (text.length <= 80) return text;
  const head = text.slice(0, 80);
  return `${head.slice(0, head.lastIndexOf(" ") > 0 ? head.lastIndexOf(" ") : 80).trimEnd()}…`;
}
export function localMachineId() {
  if (process.env.GARRISON_NODE_NAME) return process.env.GARRISON_NODE_NAME;
  try { const n = JSON.parse(readFileSync(path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "node.json"), "utf8")); return n.name || n.id || os.hostname(); }
  catch { return os.hostname(); }
}
export function boardBase() {
  try { return JSON.parse(readFileSync(path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "ui-fittings/kanban-loop.json"), "utf8")).url; }
  catch { return null; }
}
export async function boardRequest(route, { method = "GET", body, engine = false, fetchImpl = fetch, base = boardBase() } = {}) {
  if (!base) throw new Error("The board is unavailable.");
  const response = await fetchImpl(`${base.replace(/\/$/, "")}${route}`, {
    method, headers: { "content-type": "application/json", ...(engine ? { "x-garrison-engine": "gateway" } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || `Board returned ${response.status}`), { status: response.status });
  return data;
}
async function existingCard(id) {
  try { const data = await boardRequest(`/cards/${encodeURIComponent(id)}`); return data.card ?? data; }
  catch (error) { if (error.status === 404) return null; throw error; }
}
const creating = new Map();
export async function createSessionCard(conversationId) {
  if (creating.has(conversationId)) return creating.get(conversationId);
  const pending = (async () => {
    const thread = await getThread(conversationId);
    if (!isWorkSession(thread)) return null;
    const store = openConversation(conversationId, { role: "web-channel" });
    const first = store.tail(Number.MAX_SAFE_INTEGER, { kinds: ["user-message"] })[0];
    if (!first?.payload?.text?.trim()) return null;
    const firstText = first.payload.textRef ? store.readPayload(first.payload.textRef) : first.payload.text;
    if (typeof firstText !== "string") throw new Error("The original message is unavailable.");
    let card = await existingCard(conversationId);
    if (!card) {
      const machineId = localMachineId();
      const summary = store.parseSummary();
      const inferred = summary?.objective && !summary.objective.startsWith("(not yet written") ? inferredConversationTitle(conversationId) : null;
      const title = thread.title || inferred || provisionalTitle(first.payload.text);
      const routing = first.payload.routing ?? thread.routing ?? {};
      const project = routing.project || thread.context?.project || null;
      const createdAt = first.ts;
      try {
        const data = await boardRequest("/cards", { method: "POST", engine: true, body: {
          conversationId, title, description: `Work session started ${createdAt.replace(/Z$/, "+00:00")} on ${machineId}\n\n${firstText}`,
          project, scope: project ? "project" : "unscoped", machineId, routing,
          targetList: "running", origin: { type: "workSession", conversationId, createdAt },
          titleProvisional: !thread.title && !inferred,
        } });
        card = data.card;
      } catch (error) {
        // A second process may win the unique card identity at the board door.
        card = await existingCard(conversationId);
        if (!card) throw error;
      }
    }
    await setThreadBoardCard(conversationId, card.id);
    return card.id;
  })().finally(() => creating.delete(conversationId));
  creating.set(conversationId, pending);
  return pending;
}
async function mutateSessionCard(conversationId, mutate) {
  const thread = await getThread(conversationId);
  if (!thread?.boardCardId) return null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const card = await existingCard(conversationId);
    if (card?.origin?.type !== "workSession") return null;
    const patch = mutate(card);
    if (!patch) return card.id;
    try { await boardRequest(`/cards/${encodeURIComponent(card.id)}`, { method: "PATCH", engine: true, body: { ...patch, rev: card.rev } }); return card.id; }
    catch (error) { if (error.status !== 409 || attempt === 3) throw error; }
  }
}
export async function syncSessionCardTitle(conversationId, title) {
  if (!title?.trim()) return null;
  return mutateSessionCard(conversationId, (card) => card.titleLocked || card.title === title ? null : { title, titleSync: true });
}
export const endSessionCard = (id) => mutateSessionCard(id, (card) => card.list === "done" ? null : { list: "done", status: "ok", runningSince: null });
export const resumeSessionCard = (id) => mutateSessionCard(id, (card) => card.list === "running" ? null : { list: "running", status: "running", runningSince: new Date().toISOString() });
export async function syncWorkSessionTitle(id) {
  const thread = await getThread(id);
  if (thread?.boardCardId) await syncSessionCardTitle(id, thread.title || inferredConversationTitle(id));
}
export function reportCardHook(error) { console.error(`[conversation-cards] ${error?.message || error}`); }
export async function reconcileSessionCards() {
  for (const thread of await listThreads()) {
    if (!thread.boardCardId || thread.source !== "chat") continue;
    const store = openConversation(thread.id, { role: "gateway" });
    if (!store.currentStretch() && !globalThis.__conversationAborts?.has(thread.id)) await endSessionCard(thread.id).catch(reportCardHook);
  }
}
