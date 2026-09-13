import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { build } from "esbuild";
import { stateClient, stateEnrolled, type StateClient } from "./state-client";
import { garrisonDir } from "./claude-home";
import { readLibrary } from "./library";
import { readNodeIdentity } from "./node-identity";
import { getInternalToken } from "./internal-token";
import { peerAppBase, forwardToPeer } from "./mesh/peer-proxy";
import { getConnectorAccountToken, listConnectorAccounts, scopedSecrets } from "./connector-auth";
import { createGoogleActionAdapter, createGoogleSendAdapter } from "../../packages/messages/providers/google-write";
import { createSlackActionAdapter, createSlackSendAdapter } from "../../packages/messages/providers/slack-write";
import { GOOGLE_MESSAGES_SCOPES } from "../../packages/messages/providers/google-common";
import { SLACK_MESSAGES_SCOPES } from "../../packages/messages/providers/slack-common";
import { baseConversation, baseMessage } from "../../packages/messages/providers/shared";
import { emitSystemMessage, deliverMessageMirrors } from "../../packages/messages/system.mjs";
import { createCardFromMessage } from "../../packages/messages/system-actions.mjs";
import type { IngestAccount } from "../../packages/messages/worker";
import type { ProviderDescriptor, OutboxItem, Message, Attachment } from "../../packages/messages/types";

type Descriptor = ProviderDescriptor & { ownerNode?: string; callbackBaseUrl?: string };
type RuntimeDependencies = { client?: StateClient; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; log?: Pick<Console, "error"> };

export function ingestEnvironment(diskRoot: string, modules?: string): NodeJS.ProcessEnv {
  return { NODE_ENV: "production", GARRISON_MESSAGES_INGEST_CHILD: "1", HOME: diskRoot, TMPDIR: path.join(diskRoot, "tmp"), TZ: "UTC", LANG: "C.UTF-8",
    ...(modules ? { NODE_PATH: modules } : {}) };
}
export function ingestPermissionArgs(bundle: string, diskRoot: string, modules: string): string[] {
  return ["--experimental-permission", `--allow-fs-read=${bundle}`, `--allow-fs-read=${modules}`, `--allow-fs-read=${diskRoot}`, `--allow-fs-write=${diskRoot}`];
}

export function validateCallback(provider: Descriptor, node: any, localNode: string, fittingStatus?: { url?: string; tailnetUrl?: string | null }): string {
  if (!provider.callbackBaseUrl || !provider.ownerNode || provider.ownerNode !== node?.name) throw new Error("Provider callback has no verified owner");
  const callback = new URL(provider.callbackBaseUrl);
  if (callback.username || callback.password || callback.search || callback.hash || !["http:", "https:"].includes(callback.protocol)) throw new Error("Invalid provider callback");
  if (provider.ownerNode === localNode) {
    if (!fittingStatus?.url || callback.origin !== new URL(fittingStatus.url).origin) throw new Error("Provider callback does not match its running fitting");
  } else {
    const ownerHost = node.tailnetHost || (node.health?.node?.appOrigin ? new URL(node.health.node.appOrigin).hostname : null);
    if (!fittingStatus?.url || !fittingStatus.tailnetUrl || !ownerHost) throw new Error("Provider callback has no published owner fitting");
    const published = new URL(fittingStatus.tailnetUrl);
    if (published.protocol !== "https:" || published.hostname !== ownerHost || published.pathname !== "/") throw new Error("Provider callback is outside its owner node");
    if (callback.origin === new URL(fittingStatus.url).origin) {
      callback.protocol = published.protocol; callback.hostname = published.hostname; callback.port = published.port;
    }
    if (callback.origin !== published.origin) throw new Error("Provider callback is outside its owner node");
  }
  if (callback.pathname !== "/messages-adapter") throw new Error("Provider callback must use its isolated Messages adapter route");
  return callback.href.replace(/\/$/, "");
}

async function confinedRead(root: string, file: string): Promise<Uint8Array> {
  const resolved = await fs.realpath(path.resolve(root, file));
  const canonicalRoot = await fs.realpath(root);
  if (!resolved.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error("Attachment is outside the Messages store");
  const stat = await fs.stat(resolved);
  if (!stat.isFile() || stat.size > 25 * 1024 * 1024) throw new Error("Attachment exceeds 25 MB");
  return fs.readFile(resolved);
}

export async function applyProviderState(adapter: any, message: Message, payload: any, provider: Descriptor, conversation: any): Promise<void> {
  const patch = payload.patch ?? {};
  const account = message.account, externalId = message.externalId;
  if (!externalId) return;
  if ("read" in patch && provider.capabilities.markRead && provider.sendReadReceipts !== false) await adapter.setRead(account, [externalId], patch.read);
  if ("archived" in patch && provider.capabilities.archive) {
    if (patch.archived) await adapter.archive(account, conversation.externalId);
    else if (adapter.setLabels) await adapter.setLabels(account, [externalId], ["INBOX"], []);
    else throw new Error("Provider cannot undo archive");
  }
  if ("deleted" in patch && provider.capabilities.delete && (provider.kind === "mail" || message.sender.isMe)) {
    if (patch.deleted) await adapter.delete(account, externalId);
    else if (adapter.setLabels) await adapter.setLabels(account, [externalId], ["INBOX"], ["TRASH"]);
    else throw new Error("Provider cannot restore a deleted message");
  }
  if ("starred" in patch && adapter.setStarred) await adapter.setStarred(account, [externalId], patch.starred);
  if ("labels" in patch && adapter.setLabels) {
    const before = payload.before?.labels ?? message.labels;
    await adapter.setLabels(account, [externalId], patch.labels.filter((label: string) => !before.includes(label)), before.filter((label: string) => !patch.labels.includes(label)));
  }
}

export class MessagesRuntime {
  private client: StateClient;
  private env: NodeJS.ProcessEnv;
  private fetchImpl: typeof fetch;
  private log: Pick<Console, "error">;
  private diskRoot: string;
  private node: string;
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private ticking = false;
  private refreshedAt = 0;
  private providers: Descriptor[] = [];
  private lastRetention = "";
  constructor(deps: RuntimeDependencies = {}) {
    this.client = deps.client ?? stateClient(); this.env = deps.env ?? process.env;
    this.fetchImpl = deps.fetchImpl ?? fetch; this.log = deps.log ?? console;
    this.diskRoot = path.join(this.env.GARRISON_HOME || garrisonDir(), "messages");
    this.node = this.env.GARRISON_NODE_NAME || this.client.node || readNodeIdentity().id;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 5_000); this.timer.unref();
    void this.tick();
  }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); if (this.child?.connected) this.child.send({ type: "stop" }); this.child = null; }
  private request(method: string, suffix: string, body?: unknown) { return this.client.request(method, `/v1/messages/${suffix}`, { body }); }
  private async callback(provider: Descriptor): Promise<string> {
    const node = await this.client.getNode(provider.ownerNode!);
    const owner = (node as any).node ?? node;
    let fittingStatus;
    if (provider.ownerNode === this.node) {
      try { fittingStatus = JSON.parse(readFileSync(path.join(this.env.GARRISON_HOME || garrisonDir(), "ui-fittings", `${provider.id}.json`), "utf8")); } catch { /* Validation explains the unavailable fitting. */ }
    } else {
      const base = peerAppBase(owner.tailnetHost, owner.health?.node?.appOrigin);
      if (!base) throw new Error("Provider owner is unavailable");
      const result = await forwardToPeer({ node: provider.ownerNode!, base, path: "/api/fittings/views", method: "GET", fetchImpl: this.fetchImpl });
      if (!result.ok) throw new Error("Provider owner fitting registry is unavailable");
      fittingStatus = (await result.json()).views?.find((view: any) => view.fittingId === provider.id && view.healthy);
    }
    return validateCallback(provider, owner, this.node, fittingStatus);
  }
  private async connectorToken(provider: string, account: string): Promise<string> {
    if (provider === "slack" && account === "default") {
      try { return await getConnectorAccountToken(provider, account); } catch { /* Legacy user tokens need their own grant. */ }
      const secret = (await scopedSecrets(["SLACK_USER_TOKEN"])).find(entry => entry.key === "SLACK_USER_TOKEN")?.value;
      if (!secret?.startsWith("xoxp-")) throw new Error("Slack needs setup: reinstall Slack with user scopes");
      return secret;
    }
    return getConnectorAccountToken(provider, account);
  }
  private async refreshProviders() {
    const entries = await readLibrary();
    for (const entry of entries) {
      const declared = entry.metadata.connector?.messaging;
      if (!declared) continue;
      try {
      const accounts = await listConnectorAccounts(declared.id);
      let hint: string | null = null;
      let publicAccounts = accounts.filter(account => account.status !== "revoked").map(({ id, label, address }) => ({ id, label, address }));
      if (declared.id === "slack" && publicAccounts.length === 0) {
        publicAccounts = [{ id: "default", label: "Slack", address: undefined }];
        hint = "Reinstall Slack with user scopes";
      } else if (!publicAccounts.length) hint = "Connect this account in Connectors";
      if (declared.id === "google" && accounts.some(account => account.status !== "revoked" && GOOGLE_MESSAGES_SCOPES.some(scope => !account.scopes.includes(scope)))) hint = "Reconnect Google with mail read scope in Connectors";
      if (declared.id === "slack" && accounts.some(account => account.status !== "revoked" && SLACK_MESSAGES_SCOPES.some(scope => !account.scopes.includes(scope)))) hint = "Reinstall Slack with user scopes";
      await this.request("POST", "providers/register", { descriptor: { ...declared, accounts: publicAccounts, setupHint: hint, health: { ok: !hint, ...(hint ? { reason: hint } : {}) } } });
      if (hint) await emitSystemMessage({ category: "system.warning", severity: "warning", title: `${declared.label} needs setup`, body: hint,
        idempotencyKey: `messages:setup:${declared.id}:${hint}` }, { client: this.client });
      } catch (error: any) { this.log.error(`[messages] ${declared.id} discovery failed: ${error.message}`); }
    }
    this.providers = (await this.request("GET", "providers")).providers;
    this.refreshedAt = Date.now();
  }
  private async ingestAccounts(): Promise<IngestAccount[]> {
    const accounts: IngestAccount[] = [];
    for (const provider of this.providers) {
      const demoEnabled = process.env.NODE_ENV !== "production" && this.env.GARRISON_MESSAGES_FIXTURES === "1";
      if (provider.id === "system" || (provider.id === "demo" && !demoEnabled) || provider.setupHint || provider.health?.ok === false) continue;
      for (const account of provider.accounts) {
        try {
          if (provider.callbackBaseUrl) accounts.push({ provider, account, callbackBaseUrl: await this.callback(provider) });
          else {
            const token = await this.connectorToken(provider.id, account.id);
            accounts.push({ provider, account, token });
          }
        } catch (error: any) {
          this.log.error(`[messages] ${provider.id} account unavailable: ${error.message}`);
        }
      }
    }
    return accounts;
  }
  private async spawnReadWorker(): Promise<ChildProcess> {
    await fs.mkdir(path.join(this.diskRoot, "tmp"), { recursive: true, mode: 0o700 });
    const runtimeDir = path.join(path.dirname(this.diskRoot), "runtime-workers", "messages");
    await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    const bundle = path.join(runtimeDir, "ingest.cjs");
    const root = this.env.GARRISON_REPO || process.cwd();
    await build({ entryPoints: [path.join(root, "packages/messages/worker.ts")], bundle: true, platform: "node", target: "node20", format: "cjs",
      outfile: bundle, packages: "external", logLevel: "silent" });
    const modules = path.join(root, "node_modules");
    const child = fork(bundle, [], { execPath: process.execPath, execArgv: ingestPermissionArgs(bundle, this.diskRoot, modules),
      cwd: this.diskRoot, env: ingestEnvironment(this.diskRoot, modules), stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.stderr?.on("data", () => { /* Never log child payloads or credentials. Structured status uses IPC. */ });
    return child;
  }
  private async startIngest() {
    if (this.child?.connected) { this.child.send({ type: "accounts", accounts: await this.ingestAccounts() }); return; }
    const lease = await this.request("POST", "lease/acquire");
    if (!lease.granted) return;
    const accounts = await this.ingestAccounts();
    const child = await this.spawnReadWorker();
    this.child = child;
    child.on("error", (error) => this.log.error(`[messages] Ingest process failed: ${error.message}`));
    child.on("exit", () => { if (this.child === child) this.child = null; });
    child.on("message", (event: any) => {
      if (event?.type === "provider-error") this.log.error(`[messages] ${event.provider} sync failed: ${event.error}`);
    });
    child.send({ type: "start", config: { stateUrl: this.client.url, token: lease.token, fence: lease.fence, diskRoot: this.diskRoot, accounts } });
  }
  private async downloadAttachment(provider: Descriptor, message: Message, attachment: Attachment): Promise<Attachment> {
    const account = provider.accounts.find(account => account.id === message.account);
    if (!account) throw new Error("Unknown provider account");
    const entry: IngestAccount = { provider, account, ...(provider.callbackBaseUrl ? { callbackBaseUrl: await this.callback(provider) } : { token: await this.connectorToken(provider.id, account.id) }) };
    const child = await this.spawnReadWorker();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("Attachment download timed out")); }, 90_000);
      child.once("message", (result: any) => { clearTimeout(timer); if (result.type === "downloaded") resolve(result.attachment); else reject(new Error("Attachment download failed")); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); if (code) reject(new Error("Attachment worker could not start")); });
      child.send({ type: "download", entry, message: { ts: message.ts }, attachment, diskRoot: this.diskRoot });
    });
  }
  private async processMedia(message: Message) {
    let captureUrl: string | undefined, captureToken: string | undefined;
    if (message.attachments.some(attachment => attachment.kind === "audio" && !["done", "failed"].includes(attachment.transcriptStatus))) {
      try {
        const status = JSON.parse(await fs.readFile(path.join(path.dirname(this.diskRoot), "ui-fittings/capture-service.json"), "utf8"));
        captureUrl = status.url;
        captureToken = (await scopedSecrets(["CAPTURE_TOKEN"])).find(entry => entry.key === "CAPTURE_TOKEN")?.value;
      } catch { /* The media worker records an unavailable transcript without dropping playback. */ }
    }
    const { processMessageMedia } = await import("./messages-media");
    await processMessageMedia(message, { captureUrl, captureToken });
  }
  private async writeAdapter(provider: Descriptor, account: string, send = false): Promise<any> {
    if (provider.callbackBaseUrl) {
      const invoke = (method: string, body: unknown) => this.invokeCallback(provider, method, body);
      return { setRead: (account: string, ids: string[], read: boolean) => invoke("setRead", { account, messageExternalIds: ids, read }),
        archive: (account: string, conversationExternalId: string) => invoke("archive", { account, conversationExternalId }),
        delete: (account: string, messageExternalId: string) => invoke("delete", { account, messageExternalId }),
        send: (item: OutboxItem) => invoke("send", { item }),
        outboxStatus: (id: string) => invoke("outboxStatus", { id }), cancelSend: (id: string) => invoke("cancelSend", { id }) };
    }
    const token = await this.connectorToken(provider.id, account);
    const options = { token, fetchImpl: this.fetchImpl, readFile: (file: string) => confinedRead(this.diskRoot, file) };
    if (provider.id === "google") return send ? createGoogleSendAdapter(options) : createGoogleActionAdapter(options);
    if (provider.id === "slack") return send ? createSlackSendAdapter(options) : createSlackActionAdapter(options);
    throw new Error("Provider action adapter is unavailable");
  }
  private async invokeCallback(provider: Descriptor, method: string, body: unknown): Promise<any> {
    if (!["setRead", "archive", "delete", "send", "outboxStatus", "cancelSend"].includes(method)) throw new Error("Provider operation is not permitted");
    if (provider.ownerNode !== this.node) {
      const nodeResult = await this.client.getNode(provider.ownerNode!);
      const owner = (nodeResult as any).node ?? nodeResult;
      const base = peerAppBase(owner.tailnetHost, owner.health?.node?.appOrigin);
      if (!base) throw new Error("The provider owner is unavailable");
      const response = await forwardToPeer({ node: provider.ownerNode!, base, path: `/api/messages/providers/${encodeURIComponent(provider.id)}/adapter/${method}`,
        method: "POST", body: JSON.stringify(body), fetchImpl: this.fetchImpl, timeoutMs: 60_000 });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The provider owner refused the operation");
      return result;
    }
    const callback = await this.callback(provider);
    const response = await this.fetchImpl(`${callback}/${method}`, { method: "POST", headers: { "content-type": "application/json", "x-garrison-internal": await getInternalToken() },
      body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(60_000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Provider ${method} failed`);
    return result;
  }
  async invokeProviderAction(providerId: string, method: string, input: any) {
    const { providers } = await this.request("GET", "providers");
    const provider: Descriptor | undefined = providers.find((entry: Descriptor) => entry.id === providerId);
    if (!provider || provider.ownerNode !== this.node || !provider.callbackBaseUrl) throw new Error("This node does not own the provider");
    if (!["setRead", "archive", "delete", "send", "outboxStatus", "cancelSend"].includes(method)) throw new Error("Provider operation is not permitted");
    let body = input;
    if (method === "send") {
      const id = input?.item?.id;
      const { items } = await this.request("GET", "outbox");
      const stored: OutboxItem | undefined = items.find((entry: OutboxItem) => entry.id === id && entry.provider === providerId);
      if (!stored || stored.status !== "sending" || Date.parse(stored.holdUntil) > Date.now()) throw new Error("Send is not claimed or its hold has not ended");
      const item = structuredClone(stored);
      if (item.to.conversationId) {
        const { conversation } = await this.request("GET", `conversations/${encodeURIComponent(item.to.conversationId)}`);
        if (provider.id === "whatsapp-web") item.to.jid = conversation.externalId;
        if (provider.id === "slack") {
          const [channel, rootTs] = String(conversation.externalId).split(":");
          item.to.channel = channel;
          if (rootTs) item.replyToExternalId = `${channel}:${rootTs}`;
        }
      }
      for (const attachment of item.attachments) {
        await confinedRead(this.diskRoot, attachment.path);
        attachment.path = path.resolve(this.diskRoot, attachment.path);
      }
      body = { item };
    } else if (method === "outboxStatus" || method === "cancelSend") {
      const { items } = await this.request("GET", "outbox");
      if (!items.some((item: OutboxItem) => item.provider === providerId && item.externalReceipt?.id === input?.id)) throw new Error("Unknown delegated send");
      body = { id: input.id };
    } else {
      if (!provider.accounts.some(account => account.id === input?.account)) throw new Error("Unknown provider account");
      if (method === "setRead") {
        if (!Array.isArray(input.messageExternalIds) || input.messageExternalIds.length > 2000 || input.messageExternalIds.some((id: unknown) => typeof id !== "string") || typeof input.read !== "boolean") throw new Error("Invalid structured read state");
        body = { account: input.account, messageExternalIds: input.messageExternalIds, read: input.read, sendReadReceipts: provider.sendReadReceipts !== false };
      } else {
        const key = method === "archive" ? "conversationExternalId" : "messageExternalId";
        if (typeof input[key] !== "string") throw new Error("Invalid provider message reference");
        body = { account: input.account, [key]: input[key] };
      }
    }
    return this.invokeCallback(provider, method, body);
  }
  private async executeWork(kind: string, item: any): Promise<Record<string, unknown>> {
    if (kind === "mirrors") {
      const receipt = await deliverMessageMirrors(item.message, { env: this.env, fetchImpl: this.fetchImpl });
      return { receipt, ...(receipt.some(row => !row.ok) ? { error: "One or more notification mirrors failed" } : {}) };
    }
    if (kind === "effects" && item.kind === "applyRule") return this.request("POST", `rules/${encodeURIComponent(item.payload.ruleId)}/run`);
    if (kind === "effects" && item.kind === "createCard") {
      const result = await createCardFromMessage(item.message, item.payload, { env: this.env, fetchImpl: this.fetchImpl });
      return { cardId: result.card?.id ?? result.id };
    }
    if (kind === "effects" && item.kind === "pruneFiles") {
      if (item.payload.ownerNode !== this.node) throw new Error("File pruning must run on its owner node");
      for (const file of item.payload.paths) {
        const resolved = path.resolve(this.diskRoot, file);
        if (resolved.startsWith(`${this.diskRoot}${path.sep}`)) await fs.unlink(resolved).catch(error => { if (error.code !== "ENOENT") throw error; });
      }
      return {};
    }
    const message = item.message;
    if (kind === "effects" && item.kind === "processMedia") {
      const attachments = message.attachments.filter((attachment: Attachment) => (attachment.ownerNode ?? message.ownerNode) === this.node && (!item.payload.attachmentIds || item.payload.attachmentIds.includes(attachment.id)));
      await this.processMedia({ ...message, attachments }); return {};
    }
    const provider = this.providers.find(provider => provider.id === (message?.provider ?? item.provider));
    if (!provider || provider.setupHint || provider.health?.ok === false) throw new Error("Provider needs setup in Connectors");
    if (kind === "effects" && item.kind === "downloadAttachment") {
      const attachment = message.attachments.find((attachment: Attachment) => attachment.id === item.payload.attachmentId);
      if (!attachment) throw new Error("Attachment not found");
      const updated = attachment.path ? attachment : await this.downloadAttachment(provider, message, attachment);
      await this.request("POST", `${encodeURIComponent(message.id)}/media`, { attachment: updated });
      await this.processMedia({ ...message, attachments: [updated] });
      return {};
    }
    if (kind === "effects" && item.kind === "providerState") {
      const adapter = await this.writeAdapter(provider, message.account);
      const { conversation } = await this.request("GET", `conversations/${encodeURIComponent(message.conversationId)}`);
      await applyProviderState(adapter, message, item.payload, provider, conversation);
      return {};
    }
    if (kind === "outbox") {
      const sentItem: OutboxItem & { mail?: any } = structuredClone(item);
      let conversation;
      if (sentItem.to.conversationId) {
        ({ conversation } = await this.request("GET", `conversations/${encodeURIComponent(sentItem.to.conversationId)}`));
        if (provider.id === "slack") {
          const [channel, threadTs] = String(conversation.externalId).split(":");
          sentItem.to.channel = channel;
          if (threadTs) sentItem.replyToExternalId = `${channel}:${threadTs}`;
        }
        if (provider.id === "whatsapp-web") sentItem.to.jid = conversation.externalId;
        if (provider.kind === "mail") {
          sentItem.mail = { threadId: conversation.externalId, subject: sentItem.to.subject || conversation.title };
          if (!sentItem.to.address) sentItem.to.address = conversation.participants.filter((participant: any) => !participant.isMe && participant.address).map((participant: any) => participant.address).join(", ");
        }
      }
      const adapter = await this.writeAdapter(provider, item.account, true);
      let sent;
      if (item.externalReceipt) {
        sent = await adapter.outboxStatus(item.externalReceipt.id);
        if (sent.status === "failed" || sent.status === "cancelled") throw new Error(sent.error || "Provider send was cancelled");
        if (!sent.externalId) return { pending: true, externalReceipt: item.externalReceipt, nextAttemptAt: new Date(Date.now() + 5_000).toISOString() };
      } else {
        if (provider.callbackBaseUrl) {
          if (provider.ownerNode !== this.node && sentItem.attachments.length) throw new Error("Attachments must be sent through the provider owner node");
          sentItem.attachments = sentItem.attachments.map(attachment => ({ ...attachment, path: path.resolve(this.diskRoot, attachment.path) }));
        }
        sent = await adapter.send(sentItem);
        if (sent.queued) {
          if (!provider.managesAgentHold || !sent.id) throw new Error("Provider returned an unsupported send receipt");
          return { pending: true, externalReceipt: { id: sent.id, executeAt: sent.executeAt }, nextAttemptAt: sent.executeAt || new Date(Date.now() + 5_000).toISOString() };
        }
      }
      if (!sent.externalId) throw new Error("Provider did not confirm the sent message");
      const account = provider.accounts.find(account => account.id === item.account);
      const timestamp = new Date().toISOString();
      conversation ??= baseConversation(provider.id, item.account, sent.conversationExternalId || sentItem.to.channel || sentItem.to.jid || sent.externalId,
        provider.kind === "mail" ? "mail-thread" : "dm", sentItem.to.subject || sentItem.to.address || provider.label, timestamp);
      const record = baseMessage(provider.id, item.account, sent.externalId, conversation.id, timestamp, timestamp);
      Object.assign(record, { direction: "out", bodyText: item.body.markdown, bodyMarkdown: item.body.markdown, subject: sentItem.to.subject || null,
        sender: { id: account?.address || item.account, name: account?.label || "Me", address: account?.address, isMe: true }, read: true });
      return { externalId: sent.externalId, message: record, conversation };
    }
    throw new Error("Unknown Messages work item");
  }
  async cancelOutbox(id: string) {
    const { items } = await this.request("GET", "outbox");
    const item: OutboxItem | undefined = items.find((entry: OutboxItem) => entry.id === id);
    if (!item) throw new Error("Send not found");
    if (item.status !== "held" && item.status !== "cancelled") throw new Error("Sending has already started");
    if (item.externalReceipt && item.status !== "cancelled") {
      const { providers } = await this.request("GET", "providers");
      const provider = providers.find((entry: Descriptor) => entry.id === item.provider);
      if (!provider) throw new Error("Provider is unavailable");
      const adapter = await this.writeAdapter(provider, item.account, true);
      await adapter.cancelSend(item.externalReceipt.id);
    }
    return this.request("POST", `outbox/${encodeURIComponent(id)}/cancel`, {});
  }
  private async drain(kind: string) {
    for (let count = 0; count < 10 && !this.stopped; count++) {
      const claim = await this.request("POST", `work/${kind}/claim`);
      if (!claim.item) return;
      let result;
      try { result = await this.executeWork(kind, claim.item); }
      catch (error: any) { result = { error: String(error.message).slice(0, 500) }; }
      const id = kind === "mirrors" ? claim.item.messageId : claim.item.id;
      await this.request("POST", `work/${kind}/${encodeURIComponent(id)}/finish`, { ...result, claimToken: claim.claimToken });
    }
  }
  async tick() {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      if (Date.now() - this.refreshedAt > 60_000) await this.refreshProviders();
      if (!this.child || Date.now() - this.refreshedAt < 5_000) await this.startIngest();
      await Promise.all([this.drain("effects"), this.drain("outbox"), this.drain("mirrors")]);
      const day = new Date().toISOString().slice(0, 10);
      if (this.lastRetention !== day) {
        await this.request("POST", "retention");
        this.lastRetention = day;
      }
    } catch (error: any) { this.log.error(`[messages] Runtime unavailable: ${error.message}`); }
    finally { this.ticking = false; }
  }
}

const runtimeGlobal = globalThis as typeof globalThis & { __garrisonMessagesRuntime?: MessagesRuntime };
export async function cancelMessageOutbox(id: string) {
  const runtime = runtimeGlobal.__garrisonMessagesRuntime ?? new MessagesRuntime();
  return runtime.cancelOutbox(id);
}
export async function invokeMessageProviderAction(providerId: string, method: string, input: unknown) {
  const runtime = runtimeGlobal.__garrisonMessagesRuntime ?? new MessagesRuntime();
  return runtime.invokeProviderAction(providerId, method, input);
}
export async function ensureMessagesRuntime(): Promise<void> {
  if (!stateEnrolled() || process.env.NODE_ENV === "test" || process.env.GARRISON_MESSAGES_DISABLE_RUNTIME === "1") return;
  if (!runtimeGlobal.__garrisonMessagesRuntime) { runtimeGlobal.__garrisonMessagesRuntime = new MessagesRuntime(); runtimeGlobal.__garrisonMessagesRuntime.start(); }
}
