import fs from "node:fs/promises";
import path from "node:path";
import type { ProviderDescriptor, Message, SyncCursor, Attachment } from "./types";
import { createGoogleReadAdapter } from "./providers/google-read";
import { createSlackReadAdapter } from "./providers/slack-read";

export interface IngestAccount {
  provider: ProviderDescriptor; account: { id: string; label: string; address?: string };
  token?: string; callbackBaseUrl?: string;
}
export interface IngestStart { stateUrl: string; token: string; fence: number; diskRoot: string; accounts: IngestAccount[] }
type Batch = { messages: Message[]; conversations: any[]; cursor: SyncCursor; deletedExternalIds?: string[]; retryAfterMs?: number };
const segment = (value: string) => encodeURIComponent(value).replace(/\./g, "%2E");

const GOOGLE_READ_PATH = /^\/gmail\/v1\/users\/me\/(?:profile|history|threads(?:\/[^/]+)?|messages(?:\/[^/]+(?:\/attachments\/[^/]+)?)?)$/;
const SLACK_READ_METHODS = new Set(["auth.test", "users.info", "users.list", "users.conversations", "conversations.info", "conversations.history", "conversations.replies", "files.info"]);

// Adapters receive an HTTP function that cannot send, mutate labels or mark read.
export function readOnlyProviderFetch(provider: string, fetchImpl: typeof fetch = fetch, callbackBaseUrl?: string): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    const method = (init.method || (typeof input === "string" || input instanceof URL ? "GET" : input.method)).toUpperCase();
    if (url.username || url.password) throw new Error("Ingest transport refused URL credentials");
    let allowed = false;
    if (provider === "google") allowed = method === "GET" && url.origin === "https://gmail.googleapis.com" && GOOGLE_READ_PATH.test(url.pathname);
    if (provider === "slack") allowed = method === "GET" && url.protocol === "https:" && (
      url.hostname === "slack.com" && SLACK_READ_METHODS.has(url.pathname.replace(/^\/api\//, "")) ||
      url.hostname.endsWith(".slack.com") && url.pathname.startsWith("/files-pri/"));
    if (callbackBaseUrl) {
      const callback = new URL(callbackBaseUrl);
      allowed = url.origin === callback.origin && (
        ["fetchMessages", "downloadAttachment"].some(operation => url.pathname === `${callback.pathname.replace(/\/$/, "")}/${operation}`) && method === "POST" ||
        url.pathname === `${callback.pathname.replace(/\/$/, "")}/events` && method === "GET");
    }
    if (!allowed) throw new Error("Ingest transport refused a non-read provider operation");
    return fetchImpl(input, { ...init, redirect: "error" });
  }) as typeof fetch;
}

export function confinedFile(root: string, relative: string): string {
  const absolute = path.resolve(root, relative);
  if (absolute === path.resolve(root) || !absolute.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("Message file must remain inside its store");
  return absolute;
}

async function writeData(root: string, relative: string, bytes: Uint8Array | string): Promise<string> {
  const file = confinedFile(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const canonicalRoot = await fs.realpath(root), canonicalParent = await fs.realpath(path.dirname(file));
  if (canonicalParent !== canonicalRoot && !canonicalParent.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error("Message file follows a path outside its store");
  const existing = await fs.lstat(file).catch(() => null);
  if (existing?.isSymbolicLink()) throw new Error("Message file cannot be a symbolic link");
  await fs.writeFile(file, bytes, { mode: 0o600 });
  return relative;
}

function readAdapter(entry: IngestAccount, root: string, fetchImpl: typeof fetch) {
  const guarded = readOnlyProviderFetch(entry.provider.id, fetchImpl, entry.callbackBaseUrl);
  const options = { token: entry.token || "", fetchImpl: guarded, accountAddress: entry.account.address,
    retentionDays: entry.provider.retentionDays,
    writeFile: async (destination: string, bytes: Uint8Array) => { await writeData(root, destination, bytes); },
    storeHtml: async (id: string, html: string, remoteImages: string[] = []) => {
      await writeData(root, `html/${id}.images.json`, JSON.stringify(remoteImages));
      return writeData(root, `html/${id}.html`, html);
    },
    storeRaw: (id: string, raw: unknown) => writeData(root, `raw/${segment(entry.provider.id)}/${segment(entry.account.id)}/${segment(id)}.json`, JSON.stringify(raw)),
  };
  const adapter = entry.provider.id === "google" ? createGoogleReadAdapter(options) : entry.provider.id === "slack" ? createSlackReadAdapter(options) : null;
  return { adapter, guarded };
}

export async function downloadIngestAttachment(entry: IngestAccount, message: Pick<Message, "ts">, attachment: Attachment, root: string, fetchImpl: typeof fetch = fetch): Promise<Attachment> {
  if (!attachment.externalRef) throw new Error("Attachment reference is unavailable");
  const ext = attachment.name.split(".").at(-1)?.replace(/[^a-z0-9]/gi, "").slice(0, 12) || "bin";
  const relative = `attachments/${segment(entry.provider.id)}/${segment(entry.account.id)}/${message.ts.slice(0, 7)}/${segment(attachment.id)}.${ext}`;
  const { adapter, guarded } = readAdapter(entry, root, fetchImpl);
  let result;
  if (entry.callbackBaseUrl) {
    const response = await guarded(`${entry.callbackBaseUrl}/downloadAttachment`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: entry.account.id, ref: attachment.externalRef }), signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Attachment download failed: HTTP ${response.status}`);
    result = await response.json();
    if (typeof result.contentBase64 !== "string" || result.contentBase64.length > 36 * 1024 * 1024) throw new Error("Attachment exceeds 25 MB or contains no data");
    const bytes = Buffer.from(result.contentBase64, "base64");
    if (bytes.length > 25 * 1024 * 1024) throw new Error("Attachment exceeds 25 MB");
    await writeData(root, relative, bytes);
    result = { mime: result.mime, size: bytes.length };
  } else {
    if (!adapter) throw new Error("Provider read adapter is unavailable");
    result = await adapter.downloadAttachment(entry.account.id, attachment.externalRef, relative);
  }
  return { ...attachment, path: relative, size: result.size, mime: result.mime && result.mime !== "application/octet-stream" ? result.mime : attachment.mime };
}

export class MessagesIngestWorker {
  private config: IngestStart;
  private next = new Map<string, number>();
  private failures = new Map<string, number>();
  private running = false;
  private stopped = false;
  private abort = new AbortController();
  private streams = new Map<string, { controller: AbortController; callback: string }>();
  constructor(config: IngestStart, private fetchImpl: typeof fetch = fetch, private report: (value: unknown) => void = () => {}) {
    if (!config.token.startsWith("msgi_") || !Number.isInteger(config.fence)) throw new Error("Ingest requires a scoped lease credential");
    this.config = config;
  }
  update(accounts: IngestAccount[]) {
    this.config.accounts = accounts;
    for (const [key, stream] of this.streams) if (!accounts.some(entry => `${entry.provider.id}/${entry.account.id}` === key && entry.callbackBaseUrl === stream.callback)) stream.controller.abort();
  }
  stop() { this.stopped = true; this.abort.abort(); for (const stream of this.streams.values()) stream.controller.abort(); }
  private async state(method: string, suffix: string, body?: unknown): Promise<any> {
    if (this.stopped) throw new Error("Ingest lease stopped");
    if (!(method === "GET" && ["sync", "providers"].includes(suffix) || method === "POST" && ["ingest", "lease/renew"].includes(suffix))) throw new Error("Ingest state operation refused");
    const response = await this.fetchImpl(`${this.config.stateUrl}/v1/messages/${suffix}`, { method,
      headers: { authorization: `Bearer ${this.config.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error",
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]) });
    const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error || result.detail || "Ingest state operation failed"), { status: response.status, stateFailure: true });
    return result;
  }
  async renew() {
    try { await this.state("POST", "lease/renew"); }
    catch (error) { this.stop(); this.report({ type: "lease-lost" }); throw error; }
  }
  private async prepareMessages(entry: IngestAccount, messages: Message[], laneFetch: typeof fetch) {
    for (const message of messages) {
      if (entry.callbackBaseUrl) {
        if (message.rawPath) message.rawOwnerNode = entry.provider.ownerNode;
        if (message.bodyHtmlPath) message.htmlOwnerNode = entry.provider.ownerNode;
        for (const attachment of message.attachments) if (attachment.path) attachment.ownerNode = entry.provider.ownerNode;
      }
      for (const attachment of message.attachments) {
        if (!attachment.externalRef || attachment.path || attachment.size > 5 * 1024 * 1024 || !["audio", "image"].includes(attachment.kind)) continue;
        try { Object.assign(attachment, await downloadIngestAttachment(entry, message, attachment, this.config.diskRoot, laneFetch)); }
        catch { /* Keep the lazy reference available for an explicit download. */ }
      }
    }
  }
  private startStream(entry: IngestAccount) {
    const key = `${entry.provider.id}/${entry.account.id}`;
    if (!entry.callbackBaseUrl || entry.provider.sync.mode !== "stream" || this.streams.has(key) || this.stopped) return;
    const controller = new AbortController(), signal = AbortSignal.any([this.abort.signal, controller.signal]);
    const stream = { controller, callback: entry.callbackBaseUrl }; this.streams.set(key, stream);
    const laneFetch: typeof fetch = (input, init = {}) => this.fetchImpl(input, { ...init, signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]) });
    const guarded = readOnlyProviderFetch(entry.provider.id, laneFetch, entry.callbackBaseUrl);
    void (async () => {
      const response = await guarded(`${entry.callbackBaseUrl}/events`, { method: "GET", headers: { accept: "text/event-stream" } });
      if (!response.ok || !response.body) throw new Error("Provider stream is unavailable");
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
      try {
        while (!signal.aborted) {
          const next = await reader.read(); if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true }).replace(/\r\n/g, "\n");
          if (buffer.length > 8 * 1024 * 1024) throw new Error("Provider stream event exceeds the message limit");
          let boundary;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
            if (!data) continue;
            const event = JSON.parse(data);
            if (!event.message || !event.conversation || event.message.account !== entry.account.id) continue;
            await this.prepareMessages(entry, [event.message], laneFetch);
            await this.state("POST", "ingest", { provider: entry.provider.id, account: entry.account.id, fence: this.config.fence,
              messages: [event.message], conversations: [event.conversation], advanceCursor: false });
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
    })().catch((error: any) => {
      if (error.stateFailure && [401, 403, 409].includes(error.status)) { this.stop(); this.report({ type: "lease-lost" }); }
      else if (!signal.aborted) this.report({ type: "provider-error", provider: entry.provider.id, account: entry.account.id, error: "Provider stream interrupted; reconciliation will resume" });
    }).finally(() => { if (this.streams.get(key) === stream) this.streams.delete(key); });
  }
  async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const { sync } = await this.state("GET", "sync");
      await Promise.all(this.config.accounts.map(async (entry) => {
        const key = `${entry.provider.id}/${entry.account.id}`;
        const saved = sync.find((row: any) => row.provider === entry.provider.id && row.account === entry.account.id);
        if ((this.next.get(key) || 0) > Date.now() && (!saved?.requested || (this.failures.get(key) || 0) > 0)) return;
        try {
          const laneFetch: typeof fetch = (input, init = {}) => this.fetchImpl(input, { ...init,
            signal: AbortSignal.any([this.abort.signal, ...(init.signal ? [init.signal] : [])]) });
          const { adapter, guarded } = readAdapter(entry, this.config.diskRoot, laneFetch);
          let batch: Batch;
          if (entry.callbackBaseUrl) {
            const response = await guarded(`${entry.callbackBaseUrl}/fetchMessages`, { method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ account: entry.account.id, cursor: saved?.cursor ?? null }), signal: AbortSignal.timeout(30_000) });
            if (!response.ok) throw new Error(`Provider callback failed: HTTP ${response.status}`);
            batch = await response.json();
          } else {
            if (!adapter) return;
            batch = await adapter.fetchMessages(entry.account.id, saved?.cursor ?? null) as Batch;
          }
          await this.prepareMessages(entry, batch.messages, laneFetch);
          await this.state("POST", "ingest", { ...batch, provider: entry.provider.id, account: entry.account.id, fence: this.config.fence });
          this.failures.delete(key);
          this.next.set(key, Date.now() + Math.max((entry.provider.sync.intervalSeconds || 30) * 1000, batch.retryAfterMs || 0));
          this.report({ type: "synced", provider: entry.provider.id, account: entry.account.id, count: batch.messages.length });
          this.startStream(entry);
        } catch (error: any) {
          if (error.stateFailure && (error.status === 401 || error.status === 409)) { this.stop(); this.report({ type: "lease-lost" }); return; }
          const attempts = (this.failures.get(key) || 0) + 1;
          this.failures.set(key, attempts);
          this.next.set(key, Date.now() + Math.max(error.retryAfterMs || 0, Math.min(15 * 60_000, 30_000 * 2 ** Math.min(attempts, 5))));
          this.report({ type: "provider-error", provider: entry.provider.id, account: entry.account.id, error: String(error.message).slice(0, 300) });
        }
      }));
    } finally { this.running = false; }
  }
}

if (process.env.GARRISON_MESSAGES_INGEST_CHILD === "1") {
  let worker: MessagesIngestWorker | null = null;
  let renewTimer: NodeJS.Timeout | undefined, pollTimer: NodeJS.Timeout | undefined;
  const stop = () => { worker?.stop(); clearInterval(renewTimer); clearInterval(pollTimer); process.exitCode = 0; if (process.connected) process.disconnect(); };
  process.on("message", (event: any) => {
    if (event?.type === "start" && !worker) {
      worker = new MessagesIngestWorker(event.config, fetch, (result: any) => {
        process.send?.(result);
        if (result.type === "lease-lost") stop();
      });
      const tick = () => void worker?.tick().catch(() => stop());
      pollTimer = setInterval(tick, 5_000);
      renewTimer = setInterval(() => void worker?.renew().catch(() => stop()), 30_000);
      tick();
    } else if (event?.type === "accounts") worker?.update(event.accounts);
    else if (event?.type === "download") {
      const { entry, message, attachment, diskRoot } = event;
      void downloadIngestAttachment(entry, message, attachment, diskRoot).then(
        attachment => process.send?.({ type: "downloaded", attachment }),
        () => process.send?.({ type: "download-failed", error: "Attachment download failed" })
      ).finally(stop);
    }
    else if (event?.type === "stop") stop();
  });
  process.on("disconnect", stop);
}
