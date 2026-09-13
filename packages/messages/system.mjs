import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createStateClient } from "../garrison-state-client/index.mjs";

function clientFor({ client, env = process.env, fetchImpl } = {}) {
  return client ?? createStateClient({ env: { ...env, GARRISON_HOME: env.GARRISON_HOME || path.join(os.homedir(), ".garrison") }, readFileSync, fetchImpl });
}

// Only the store emits notification work. Producers never call a mirror directly.
export async function emitSystemMessage(input, deps = {}) {
  let attachments=input.attachments;
  if(attachments?.length) {
    const env=deps.env??process.env,root=path.join(env.GARRISON_HOME||path.join(os.homedir(),'.garrison'),'messages');
    const {attachmentRelativePath,confinedPath,saveBytes}=await import('./media.mjs');
    attachments=await Promise.all(attachments.map(async (attachment,index)=>{
      if(!attachment.path) throw new Error('System attachments require a local file');
      const mime=attachment.mime||'application/octet-stream';
      const source=path.isAbsolute(attachment.path)?attachment.path:await confinedPath(root,attachment.path);
      const stat=await fs.stat(source);if(!stat.isFile()||stat.size>25*1024*1024) throw new Error('Attachments are limited to 25 MB');
      const bytes=await fs.readFile(source),identity=input.idempotencyKey??input.externalId;
      const id=attachment.id??(identity?createHash('sha256').update(String(identity)).update(`:${index}:`).update(bytes).digest('hex'):randomUUID());
      const receivedAt=input.receivedTs??input.ts;
      const at=receivedAt&&!Number.isNaN(Date.parse(receivedAt))?new Date(receivedAt):new Date();
      const relative=attachmentRelativePath('system','default',id,mime,at);
      await saveBytes(root,relative,bytes);
      return {id,kind:mime.startsWith('image/')?'image':mime.startsWith('audio/')?'audio':'file',name:attachment.name||path.basename(source),mime,size:bytes.length,path:relative,thumbPath:null,playbackPath:null,durationMs:null,transcript:null,transcriptStatus:mime.startsWith('audio/')?'pending':'none'};
    }));
  }
  const result = await clientFor(deps).request("POST", "/v1/messages/system", { body: { ...input, ...(attachments?{attachments}:{}), idempotencyKey: input.idempotencyKey ?? input.externalId ?? undefined } });
  const message = result.message ?? result;
  if (!message?.id) throw new Error("Messages did not confirm the system message");
  return message;
}

export function systemEventKey(source, identity) {
  return `${source}:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

export function systemInputFromNotification(payload, source = "notification") {
  const title = String(payload.title || "Garrison");
  const body = String(payload.text ?? payload.body ?? "");
  const severity = payload.severity ?? (/failed|error|unhealthy/i.test(title) ? "error" : /warning|attention|interrupted/i.test(title) ? "warning" : "info");
  return {
    title, body, severity,
    category: payload.category ?? (severity === "error" ? "system.error" : severity === "warning" ? "system.warning" : "system.info"),
    externalId: payload.idempotencyKey || payload.externalId || null,
    ...(payload.cardId ? { cardId: payload.cardId } : {}),
    ...(payload.conversationRef ? { conversationRef: payload.conversationRef } : {}),
    ...(payload.action ? { action: payload.action } : {}),
    source,
    sourceLink: payload.link ?? payload.path ?? null,
    ...(payload.mirrorContext?{mirrorContext:payload.mirrorContext}:{}),
  };
}

export function isMessageMirror(payload) {
  return typeof payload?._messagesMirror?.id === "string" && payload._messagesMirror.id.length > 0;
}

function discoverMirrorTargets(env) {
  const explicitHome = env.GARRISON_HOME?.trim();
  if (!explicitHome && (env.VITEST || env.VITEST_WORKER_ID || env.NODE_ENV === "test")) return [];
  const home = explicitHome || path.join(os.homedir(), ".garrison");
  const app = env.GARRISON_APP_URL?.replace(/\/+$/, "");
  const targets = app ? [{ id: "web-channel-default", url: `${app}/api/notify` }] : [];
  try {
    for (const file of readdirSync(path.join(home, "ui-fittings"))) {
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -5);
      if (id === "omi-channel" || app && id.startsWith("web-channel")) continue;
      try {
        const status = JSON.parse(readFileSync(path.join(home, "ui-fittings", file), "utf8"));
        if (typeof status.url === "string") targets.push({ id, url: `${status.url.replace(/\/+$/, "")}/notify` });
      } catch { /* A partially replaced status file will be discovered next time. */ }
    }
  } catch { /* The shell can be the only configured delivery surface. */ }
  return targets;
}

// Called by the leased delivery worker, after ingest rules and durable storage.
// Each sink retains its existing subscription, account and per-channel gates.
export async function deliverMessageMirrors(message, { env = process.env, fetchImpl = fetch, targets, deliveredTargets = [], serveMap = new Map(), publicAppUrl = null } = {}) {
  if (!message?.id) throw new Error("A stored message is required for delivery");
  if (message.suppressNotification || message.direction === "out") return [];
  const localPath = `/messages/${encodeURIComponent(message.id)}`;
  let publicBase = null;
  try { const url = new URL(publicAppUrl); if (url.protocol === "https:" && !url.username && !url.password) publicBase = url.origin; } catch { /* Local fixture delivery can use a relative link. */ }
  const link = publicBase ? `${publicBase}${localPath}` : localPath;
  const body = String(message.bodyText || "").replace(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?(?=[/?#)\]\s]|$)/gi, (origin, port) => {
    const mapped = serveMap.get(Number(port));
    if (mapped?.startsWith("https://")) return mapped.replace(/\/+$/, "");
    try { if (publicBase && new URL(env.GARRISON_APP_URL).origin === origin) return publicBase; } catch { /* Unmapped provider text remains data. */ }
    return origin;
  });
  const payload = {
    title: message.subject || message.title || message.sender?.name || "Garrison",
    text: body,
    link, path: localPath, cardId: message.cardId ?? null,
    tag: message.mirrorContext?.tag || `message:${message.id}`, idempotencyKey: `message:${message.id}`,
    priority: message.mirrorContext?.priority ?? (message.action ? "interactive" : "routine"),
    webFallback: message.mirrorContext?.webFallback !== false,
    _messagesMirror: { id: message.id },
    actions: [{ label: "Open message", url: link }],
  };
  const receipts = [];
  for (const target of targets ?? discoverMirrorTargets(env)) {
    if (Array.isArray(message.mirrorTargets) && message.mirrorTargets.length && !message.mirrorTargets.includes(target.id)) continue;
    if (deliveredTargets.includes(target.id)) continue;
    try {
      const response = await fetchImpl(target.url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) });
      if (response.status === 404) continue;
      const result = await response.json().catch(() => null);
      const failedDelivery = Array.isArray(result) && result.length > 0 && !result.some((receipt) => receipt.ok) && result.some((receipt) => receipt.error);
      receipts.push({ id: target.id, status: response.status, ok: response.ok && !failedDelivery, result });
    } catch (error) {
      receipts.push({ id: target.id, ok: false, error: error.message });
    }
  }
  return receipts;
}

export function cardEventSystemInput(card, event, { ownerNode = null } = {}) {
  const categories = { finished: "card.done", "needs-input": "card.needs-input", blocked: "system.warning", failed: "system.error",
    created: "card.created", "duty-summary": "card.progress", "schedule-due": "card.due", "autonomy-acted": "card.autonomy", steering: "card.progress" };
  const question = event.detail?.questions?.[0];
  const prompt = typeof question === "string" ? question : question?.question ?? question?.text;
  const pending = event.kind === "needs-input";
  const approval = Boolean(card.awaitingApproval);
  return {
    category: pending || approval ? "card.needs-input" : categories[event.kind] ?? "system.info",
    severity: event.kind === "failed" ? "error" : event.kind === "blocked" ? "warning" : "info",
    title: card.title || "Card update", body: event.message || card.title || "Card update",
    cardId: card.id, conversationRef: card.conversationId ?? card.id,
    externalId: event.idempotencyKey || systemEventKey("card", [card.id, event.kind, event.at ?? card.updated ?? card.rev, event.detail ?? null]),
    action: pending || approval ? {
      kind: approval ? "approval" : "question", prompt: prompt || event.message || card.title,
      options: Array.isArray(question?.options) ? question.options.map((option) => typeof option === "string" ? option : option.label) : null,
      answeredAt: null, answer: null, revertUntil: null,
      target: { ownerNode, cardId: card.id, conversationId: card.conversationId ?? card.id,
        questionId: event.detail?.questionId ?? question?.id ?? null },
    } : null,
  };
}
