import { openConversation, ledgerToSessionEvents } from "@garrison/claude-pty";
import { getThread } from "./threads.mjs";
import { boardRequest, cardUrl, conversationUrl, provisionalTitle } from "./conversation-cards.mjs";

export const WINDOW_SIZES = [10, 20, 30, 40, 50];
export const INFERENCE_SYSTEM = "You extract one actionable task from the tail of a conversation between a user and their assistant. Use only what is in the messages. Do not invent details. Reply with JSON only, no prose, no code fences.";
export const INFERENCE_INSTRUCTIONS = `Return this JSON object:
{
  "title": string, at most 70 characters, imperative, no trailing period,
  "description": string in markdown with these sections in this order, each present, "Task" (what has to be done, 1 to 4 lines), "Decisions already made" (bullet list or "None"), "Open questions" (bullet list or "None"), "Context" (1 to 3 lines of background needed to do the task),
  "messageIds": array of the ids of the messages this task is drawn from,
  "confidence": number between 0 and 1
}
If the messages contain more than one candidate task, pick the most recent one and mention the others in "Open questions" as "Also discussed: ...".`;
export function cardError(status, message) { return Object.assign(new Error(message), { status }); }
const clock = (ts) => new Date(ts).toISOString().slice(11, 16);
const day = (ts) => new Date(ts).toISOString().slice(0, 10);

export function conversationMessages(records, conversationId, readReply = null) {
  // Keep the shared adapter's revision and saved-reply handling. Notes, tool
  // payloads and all other ledger entries never become inference messages.
  const allowed = records.filter((record) => ["user-message", "session-event", "stretch-started", "stretch-ended"].includes(record.kind) && !(record.kind === "session-event" && record.payload?.role === "user"))
    .map((record) => record.kind === "user-message" && record.payload?.textRef && readReply
      ? { ...record, payload: { ...record.payload, text: readReply(record.payload.textRef) || record.payload.text } } : record);
  const rawByIndex = new Map(records.map((record) => [record.index, record]));
  const events = ledgerToSessionEvents(allowed, { conversationId, readReply });
  const merged = new Map();
  for (const event of events) merged.set(event.id, event);
  return [...merged.values()].sort((a, b) => a.order - b.order).flatMap((event) => {
    if (!["user", "assistant"].includes(event.role)) return [];
    const text = event.blocks.filter((block) => block.type === "text").map((block) => block.text || "").join("\n\n");
    const final = event.blocks.findLast((block) => block.type === "turn_end" && typeof block.result === "string")?.result;
    const rawAttachments = rawByIndex.get(event.order)?.payload?.attachments;
    const attachments = [...event.blocks.filter((block) => ["attachment", "file", "image"].includes(block.type)), ...(Array.isArray(rawAttachments) ? rawAttachments : [])].map((block) => `[attachment: ${block.filename || block.name || block.label || "attachment"}]`);
    const messageText = (text || final || "").replace(/\n{2,}Attached files?:\n((?:- [^\n]*(?:\n|$))+)\s*$/i,
      (_match, files) => "\n\n" + files.trimEnd().split("\n").map((file) => `[attachment: ${file.slice(2).split(/[\\/]/).at(-1)}]`).join("\n"));
    const rawBody = [messageText, ...attachments].filter(Boolean).join("\n");
    const body = event.role === "assistant" && rawBody.includes("```handoff") ? rawBody.split("```handoff")[0].trimEnd() : rawBody;
    return body ? [{ id: String(event.order), role: event.role, ts: new Date(event.ts).toISOString(), body }] : [];
  });
}
export function buildZecaWindow(messages, windowSize, previousCards = []) {
  if (!WINDOW_SIZES.includes(windowSize)) throw cardError(400, "invalid windowSize");
  let window = messages.slice(-windowSize);
  let boundaryApplied = false;
  if (windowSize === 10) {
    const last = previousCards.at(-1);
    const ids = new Set(last?.messageIds ?? []);
    const boundary = window.findLastIndex((message) => ids.has(message.id));
    if (boundary >= 0) { window = window.slice(boundary + 1); boundaryApplied = true; }
  }
  return { messages: window, boundaryApplied, windowStartId: window[0]?.id ?? null, windowEndId: window.at(-1)?.id ?? null };
}
export function inferencePrompt(messages) {
  return `Messages, oldest first. Each has an id, a role and a timestamp.\n\n${messages.map((message) => `[${message.id}] ${message.role === "user" ? "You" : "Zeca"} ${clock(message.ts)}\n${message.body}\n`).join("\n")}\n${INFERENCE_INSTRUCTIONS}`;
}
export function fallbackTranscript(title, messages, link) {
  const manyDays = new Set(messages.map((message) => day(message.ts))).size > 1;
  let previousDay = null;
  return `# ${title}\n\nSource: ${link}\nMessages: ${messages.length}\n\n` + messages.map((message) => {
    const currentDay = day(message.ts);
    const heading = manyDays && previousDay !== currentDay ? `--- ${currentDay} ---\n\n` : "";
    previousDay = currentDay;
    return `${heading}**${message.role === "user" ? "You" : "Zeca"}** · ${clock(message.ts)}\n${message.body}`;
  }).join("\n\n");
}
export function validateInference(text, messages) {
  const value = JSON.parse(text);
  const ids = new Set(messages.map((message) => message.id));
  if (!value || typeof value.title !== "string" || !value.title.trim() || value.title.length > 70 || value.title.endsWith(".") ||
    typeof value.description !== "string" || !value.description.trim() || !Array.isArray(value.messageIds) || !value.messageIds.length ||
    !value.messageIds.every((id) => typeof id === "string" && ids.has(id)) || typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) throw new Error("Invalid inference JSON");
  let cursor = -1;
  for (const heading of ["Task", "Decisions already made", "Open questions", "Context"]) {
    const match = new RegExp(`^#{1,6} ${heading}\\s*$`, "m").exec(value.description);
    if (!match || match.index <= cursor) throw new Error("Missing inference sections");
    cursor = match.index;
  }
  return { ...value, messageIds: messages.filter((message) => value.messageIds.includes(message.id)).map((message) => message.id) };
}
export async function inferWindow(messages, window, { conversationId, call, timeoutMs = 20_000 } = {}) {
  const title = provisionalTitle(messages.findLast((message) => message.role === "user")?.body || "");
  const link = `[Open conversation](${conversationUrl(conversationId, window.windowStartId)})`;
  const fallback = { title, description: window.messages.length ? fallbackTranscript(title, window.messages, link) : "", messageIds: window.messages.map((message) => message.id), confidence: 0, fallbackUsed: true };
  if (!window.messages.length) return fallback;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    let timer;
    try {
      const raw = await Promise.race([
        call({ system: INFERENCE_SYSTEM, prompt: inferencePrompt(window.messages), maxTokens: 800, effort: "low", signal: controller.signal }),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Inference timed out")); }, timeoutMs); }),
      ]);
      const result = validateInference(raw, window.messages);
      const firstId = result.messageIds[0], lastId = result.messageIds.at(-1);
      return { ...result, description: `${result.description}\n\nSource: Zeca conversation ${conversationId}, messages ${firstId} to ${lastId}, [Open conversation](${conversationUrl(conversationId, firstId)})`, fallbackUsed: false };
    } catch { /* One retry, then a usable editable transcript. */ }
    finally { clearTimeout(timer); controller.abort(); }
  }
  return fallback;
}
export async function zecaContext(conversationId) {
  if (typeof conversationId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(conversationId)) throw cardError(404, "unknown conversation");
  const thread = await getThread(conversationId);
  if (!thread) throw cardError(404, "unknown conversation");
  if (thread.source !== "zeca") throw cardError(409, "conversation is not a Zeca conversation");
  const store = openConversation(conversationId, { role: "web-channel" });
  const records = store.tail(Number.MAX_SAFE_INTEGER);
  const messages = conversationMessages(records, conversationId, (ref) => store.readPayload(ref));
  return { thread, store, messages, records };
}
export async function inferZecaCard({ conversationId, windowSize }, call) {
  if (!WINDOW_SIZES.includes(windowSize)) throw cardError(400, "invalid windowSize");
  const { messages, records } = await zecaContext(conversationId);
  if (!messages.length) throw cardError(400, "empty conversation");
  const previous = records.filter((record) => record.kind === "card.created_from_zeca").map((record) => record.payload);
  const window = buildZecaWindow(messages, windowSize, previous);
  const result = await inferWindow(messages, window, { conversationId, call });
  return { ...result, windowStartId: window.windowStartId, windowEndId: window.windowEndId, windowCount: window.messages.length, boundaryApplied: window.boundaryApplied };
}
export async function createZecaCard(body, request = boardRequest) {
  const { store, messages } = await zecaContext(body.conversationId);
  if (typeof body.title !== "string" || !body.title.trim()) throw cardError(400, "Give the card a title.");
  if (typeof body.description !== "string" || !body.description.trim()) throw cardError(400, "Give the card a description.");
  if (typeof body.projectId !== "string" || !body.projectId.trim()) throw cardError(400, "Choose a project.");
  if (!["todo", "start", "schedule"].includes(body.action)) throw cardError(400, "invalid action");
  if (!WINDOW_SIZES.includes(body.windowSize)) throw cardError(400, "invalid windowSize");
  const validIds = new Set(messages.map((message) => message.id));
  if (!Array.isArray(body.messageIds) || body.messageIds.length > 50 || !body.messageIds.every((id) => validIds.has(id))) throw cardError(400, "invalid messageIds");
  if (typeof body.confidence !== "number" || !Number.isFinite(body.confidence) || body.confidence < 0 || body.confidence > 1) throw cardError(400, "invalid confidence");
  if (["fallbackUsed", "titleEdited", "descriptionEdited"].some((field) => typeof body[field] !== "boolean")) throw cardError(400, "invalid edit metadata");
  if (body.action === "schedule" && (typeof body.scheduledAt !== "string" || !Number.isFinite(Date.parse(body.scheduledAt)))) throw cardError(400, "Pick a time.");
  const messageIds = messages.filter((message) => body.messageIds.includes(message.id)).map((message) => message.id);
  const createdAt = new Date().toISOString();
  const result = await request("/cards", { method: "POST", body: {
    title: body.title.trim(), description: body.description, project: body.projectId.trim(), targetList: "todo",
    origin: { type: "zeca", conversationId: body.conversationId, messageIds, createdAt },
  } });
  const card = result.card;
  let state = "todo", warning;
  try {
    if (body.action === "start") { await request(`/cards/${card.id}/start`, { method: "POST" }); state = "running"; }
    if (body.action === "schedule") {
      await request(`/cards/${card.id}`, { method: "PATCH", body: { rev: card.rev, schedule: { kind: "once", action: "run", at: body.scheduledAt, timezone: "Europe/Lisbon", enabled: true, targetList: "todo" } } });
      state = "scheduled";
    }
  } catch (error) { warning = error.message; }
  const url = cardUrl(card.id);
  const event = store.append({ kind: "card.created_from_zeca", payload: {
    cardId: card.id, conversationId: body.conversationId, action: body.action,
    ...(body.action === "schedule" ? { scheduledAt: body.scheduledAt } : {}), windowSize: body.windowSize,
    messageIds, confidence: body.confidence, titleEdited: body.titleEdited, descriptionEdited: body.descriptionEdited, fallbackUsed: body.fallbackUsed,
  } });
  store.append({ kind: "note", payload: { origin: "zeca-card", text: `Card created from this conversation: ${card.title}\n\n[Open card](${url})` } });
  if (!event.ok) warning = [warning, "The conversation link could not be recorded."].filter(Boolean).join(" ");
  return { cardId: card.id, cardUrl: url, state, ...(warning ? { warning } : {}) };
}
