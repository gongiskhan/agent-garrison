export interface MessagesStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface PendingMessageAction { id: string; path: string; body: Record<string, any>; createdAt: string; error?: string }
export interface OfflineOptions {
  storage: MessagesStorage; transport: (path: string, body?: unknown) => Promise<any>;
  online?: () => boolean; now?: () => number; id?: () => string; key?: string;
  maxActions?: number; maxCacheBytes?: number;
}
type SavedState = { version: 1; actions: PendingMessageAction[]; cache: Record<string, { at: number; value: any }> };
const QUEUEABLE = /^(?:\/(?:conversations\/)?[A-Za-z0-9._:@+-]+\/state|\/[A-Za-z0-9._:@+-]+\/answer|\/outbox)$/;
const CACHEABLE = /^(?:\/?(?:\?.*)?|\/(?:providers|counts|conversations|views)(?:\?.*)?|\/conversations\/[A-Za-z0-9._:@+-]+|\/[A-Za-z0-9._:@+-]+)$/;
const mutableFields = new Set(["read", "archived", "deleted", "starred", "labels", "muted", "pinned"]);

/** A bounded browser queue. Sends retain their durable id across every retry. */
export class MessagesOfflineClient {
  private storage: MessagesStorage;
  private transport: OfflineOptions["transport"];
  private options: Required<Pick<OfflineOptions, "online" | "now" | "id" | "key" | "maxActions" | "maxCacheBytes">>;
  private listeners = new Set<() => void>();
  private flushing: Promise<void> | null = null;
  constructor(options: OfflineOptions) {
    this.storage = options.storage; this.transport = options.transport;
    this.options = { online: options.online ?? (() => typeof navigator === "undefined" || navigator.onLine), now: options.now ?? Date.now,
      id: options.id ?? (() => crypto.randomUUID()), key: options.key ?? "garrison.messages.offline.v1", maxActions: options.maxActions ?? 100, maxCacheBytes: options.maxCacheBytes ?? 4 * 1024 * 1024 };
  }
  private read(): SavedState {
    try {
      const value = JSON.parse(this.storage.getItem(this.options.key) || "null");
      if (value?.version === 1 && Array.isArray(value.actions) && value.cache && typeof value.cache === "object") return value;
    } catch { /* An invalid previous cache cannot become a request. */ }
    return { version: 1, actions: [], cache: {} };
  }
  private save(state: SavedState) {
    try { this.storage.setItem(this.options.key, JSON.stringify(state)); }
    catch { throw new Error("Messages could not save this action offline. Free some device storage and retry."); }
    for (const listener of this.listeners) listener();
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  pending(): PendingMessageAction[] { return this.read().actions; }
  isOnline() { return this.options.online(); }
  private transient(error: any) { return !this.options.online() || error instanceof TypeError || [408, 429].includes(error?.status) || error?.status >= 500; }
  private cache(path: string, value: any) {
    if (!CACHEABLE.test(path)) return;
    const state = this.read(); state.cache[path] = { at: this.options.now(), value };
    const oldest = Object.keys(state.cache).sort((a, b) => state.cache[a].at - state.cache[b].at);
    while (JSON.stringify(state.cache).length > this.options.maxCacheBytes && oldest.length) delete state.cache[oldest.shift()!];
    try { this.save(state); } catch { /* Reads still succeed when the browser cache is full. */ }
  }
  private projected(path: string, value: any) {
    const actions = this.pending().filter(action => !action.error && action.path.endsWith("/state"));
    const patchMessage = (message: any) => {
      if (!message) return message;
      const patch = Object.assign({}, ...actions.filter(action => action.path === `/${message.id}/state` || action.path === `/conversations/${message.conversationId}/state`).map(action => action.body));
      return { ...message, ...patch, ...(Object.keys(patch).length ? { pending: true } : {}) };
    };
    let filter: any = {};
    try { filter = JSON.parse(new URLSearchParams(path.split("?")[1] || "").get("filter") || "{}"); } catch { /* The original request already validates filter syntax. */ }
    const visible = (message: any) => (!message.deleted || filter.deleted === true) && (!message.archived || filter.archived === true) && (filter.unread !== true || !message.read) && (filter.starred !== true || message.starred);
    const patchConversation = (conversation: any) => {
      const patch = Object.assign({}, ...actions.filter(action => action.path === `/conversations/${conversation.id}/state`).map(action => action.body));
      const lastMessage = patchMessage({ ...conversation.lastMessage, conversationId: conversation.id });
      const unreadCount = patch.read === true || patch.archived === true || patch.deleted === true ? 0 : patch.read === false ? Math.max(1, conversation.unreadCount ?? 0) : conversation.unreadCount;
      return { ...conversation, ...patch, lastMessage, unreadCount, ...(lastMessage.pending || Object.keys(patch).length ? { pending: true } : {}) };
    };
    const result = structuredClone(value);
    if (Array.isArray(result.messages)) result.messages = result.messages.map(patchMessage).filter(visible);
    if (result.message) result.message = patchMessage(result.message);
    if (result.conversation) result.conversation = patchConversation(result.conversation);
    if (Array.isArray(result.conversations)) result.conversations = result.conversations.map(patchConversation).filter((conversation: any) => visible({ ...conversation.lastMessage, read: conversation.unreadCount === 0 }));
    if (result.counts) {
      const state = this.read(), conversations = new Map<string, any>();
      for (const cached of Object.values(state.cache)) for (const conversation of cached.value?.conversations ?? []) if (!conversations.has(conversation.id)) conversations.set(conversation.id, conversation);
      const providers: any[] = Object.values(state.cache).flatMap(cached => cached.value?.providers ?? []);
      for (const conversation of conversations.values()) {
        const changed = patchConversation(conversation), delta = changed.unreadCount - conversation.unreadCount;
        if (!delta) continue;
        const provider = providers.find(provider => provider.id === conversation.provider), tab = provider?.kind === "system" ? "agents" : provider?.kind === "mail" ? "mail" : provider?.kind === "chat" ? "chat" : null;
        if (typeof result.counts.all === "number") result.counts.all = Math.max(0, result.counts.all + delta);
        if (tab && typeof result.counts[tab] === "number") result.counts[tab] = Math.max(0, result.counts[tab] + delta);
      }
    }
    return result;
  }
  private enqueue(path: string, body: Record<string, any>) {
    if (!QUEUEABLE.test(path)) throw new Error("This action needs a connection.");
    if (JSON.stringify(body).length > 128 * 1024) throw new Error("This message is too large to queue offline.");
    if (path.endsWith("/state") && Object.keys(body).some(key => !mutableFields.has(key))) throw new Error("Invalid offline state action.");
    const state = this.read();
    const existing = path.endsWith("/state") ? state.actions.find(action => action.path === path && !action.error) : undefined;
    const action = existing ?? { id: this.options.id(), path, body: {}, createdAt: new Date(this.options.now()).toISOString() };
    action.body = { ...action.body, ...structuredClone(body) };
    if (path === "/outbox") action.body.id ||= action.id;
    if (!existing) { if (state.actions.length >= this.options.maxActions) throw new Error("The offline queue is full. Connect to send pending actions."); state.actions.push(action); }
    this.save(state);
    return path === "/outbox" ? { queued: true, pendingId: action.id, item: { ...action.body, status: "held", error: null, pending: true } } : { queued: true, pendingId: action.id };
  }
  async request<T>(path: string, body?: unknown): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("..") || path.includes("\\")) throw new Error("Invalid Messages route.");
    if (body === undefined) {
      try { if (!this.options.online()) throw new TypeError("Offline"); const result = await this.transport(path); this.cache(path, result); return this.projected(path, result); }
      catch (error) { const saved = this.read().cache[path]; if (this.transient(error) && saved) return this.projected(path, saved.value); throw error; }
    }
    const structured = structuredClone(body) as Record<string, any>;
    if (path === "/outbox") structured.id ||= this.options.id();
    if (!this.options.online() || this.pending().some(action => !action.error)) {
      const queued = this.enqueue(path, structured); if (this.options.online()) void this.flush(); return queued as T;
    }
    try { return await this.transport(path, structured); }
    catch (error) { if (this.transient(error)) return this.enqueue(path, structured) as T; throw error; }
  }
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.performFlush().finally(() => { this.flushing = null; }); return this.flushing;
  }
  private async performFlush() {
    if (!this.options.online()) return;
    for (const queued of this.pending().filter(action => !action.error)) {
      if (!this.options.online()) break;
      try {
        await this.transport(queued.path, queued.body);
        const state = this.read();
        const current = state.actions.find(action => action.id === queued.id);
        if (current && JSON.stringify(current.body) === JSON.stringify(queued.body)) state.actions = state.actions.filter(action => action.id !== queued.id);
        this.save(state);
      } catch (error: any) {
        if (this.transient(error)) break;
        const state = this.read(), current = state.actions.find(action => action.id === queued.id);
        if (current) current.error = String(error.message || "The action could not be applied.").slice(0, 300);
        this.save(state);
      }
    }
  }
  retry(id: string) { const state = this.read(), action = state.actions.find(action => action.id === id); if (action) { delete action.error; this.save(state); } return this.flush(); }
  discard(id: string) { const state = this.read(); state.actions = state.actions.filter(action => action.id !== id); this.save(state); }
}
