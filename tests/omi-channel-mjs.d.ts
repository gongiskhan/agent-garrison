// Ambient module shims so tsc can typecheck TS tests importing the
// omi-channel fitting's plain-JS libs (vitest executes the real .mjs).

declare module "*/omi-channel/lib/config.mjs" {
  export const FITTING_ID: string;
  export const CHANNEL_ID: string;
  export const DEFAULT_PORT: number;
  export function garrisonDir(env?: Record<string, string | undefined>): string;
  export function omiDir(env?: Record<string, string | undefined>): string;
  export function statusFilePath(env?: Record<string, string | undefined>): string;
  export function resolveGatewayUrl(env?: Record<string, string | undefined>): string | null;
  export function loadConfig(env?: Record<string, string | undefined>): {
    port: number;
    bindHost: string;
    gatewayUrl: string | null;
    // Resolved instance paths carried ON the config, so a consumer never
    // re-reads process.env behind its caller's back (see config.mjs).
    home: string;
    stateDir: string;
    statusFile: string;
    enabled: boolean;
    triageEnabled: boolean;
    wakeEnabled: boolean;
    notifyEnabled: boolean;
    chatEnabled: boolean;
    backfeedEnabled: boolean;
    tipsEnabled: boolean;
    publicBaseUrl: string;
    triageCron: string;
    triageBatchCap: number;
    allowedCategories: string[];
    blockedFolders: string[];
    dropDiscarded: boolean;
    wakeVariants: string[];
    wakeSilenceCloseMs: number;
    wakeMaxCaptureMs: number;
    notifyMaxPerDay: number;
    tipsMaxPerDay: number;
    backfeedKinds: string[];
    secrets: { appId: string; appSecret: string; importApiKey: string; webhookSecret: string };
  };
}

declare module "*/omi-channel/scripts/server.mjs" {
  export function repairDoubleEncodedQuery(
    query: Record<string, unknown>,
    counters?: unknown,
    expectedSecret?: string
  ): Record<string, string>;
  import type { Server } from "node:http";
  export function makeRequestHandler(ctx: unknown): (req: unknown, res: unknown) => Promise<void>;
  export function startServer(cfg?: unknown): Promise<Server>;
}

interface OmiCaptureEvent {
  id: string;
  source: string;
  uid: string | null;
  received_at: string;
  occurred_at: string;
  kind: "conversation" | "day_summary" | "wake_command";
  day_key?: string;
  normalized: {
    title: string | null;
    overview: string | null;
    category: string | null;
    folder: string | null;
    discarded: boolean;
    stats?: Record<string, number> | null;
    action_items: Array<{ description: string; completed: boolean; priority?: string | null; source_ref: string | null }>;
    events: Array<{ title: string; start?: string | null; description?: string | null }>;
    decisions: Array<{ decision: string; source_ref: string | null }>;
    questions: Array<{ question: string; source_ref: string | null }>;
    highlights: Array<{ topic: string; summary: string | null; source_ref: string | null }>;
    insights: Array<{ insight: string; source_ref: string | null }>;
    transcript_text: string | null;
  } | null;
  raw_ref?: string;
  provenance: Record<string, string | null>;
  status: "pending" | "triaged" | "dropped" | "failed";
  failure_reason?: string;
  drop_reason?: string;
  triage_attempts?: number;
  triage_result_ref: string | null;
}

declare module "*/omi-channel/lib/store.mjs" {
  export function ulid(now?: number): string;
  export function atomicWriteJSON(file: string, value: unknown): void;
  export function readJSON(file: string, fallback?: unknown): unknown;
  export function mergedCounters(root: string): Record<string, number>;
  export class Counters {
    constructor(root: string, name: string);
    file: string;
    read(): Record<string, number> & { updatedAt?: string };
    bump(key: string, by?: number): number;
  }
  export class OmiStore {
    constructor(root?: string);
    root: string;
    dirs: { rawQueue: string; raw: string; events: string };
    indexFile: string;
    stateFile: string;
    readState(): { pinnedUid?: string; pinnedAt?: string };
    pinnedUid(): string | null;
    pinUid(uid: string): string;
    enqueueRaw(entry: Record<string, unknown>): string;
    listQueue(): string[];
    removeQueued(file: string): void;
    readIndex(): { byConversation: Record<string, string>; byDay: Record<string, string>; byFingerprint: Record<string, string> };
    writeIndex(index: unknown): void;
    rebuildIndex(): unknown;
    eventFile(id: string): string;
    writeEvent(event: OmiCaptureEvent): OmiCaptureEvent;
    writeRaw(eventId: string, raw: unknown): string;
    getEvent(id: string): OmiCaptureEvent | null;
    listEvents(status?: string | null): OmiCaptureEvent[];
    updateEvent(id: string, mutate: (ev: OmiCaptureEvent) => OmiCaptureEvent): OmiCaptureEvent | null;
  }
}

declare module "*/omi-channel/lib/ingress.mjs" {
  export function secretMatches(presented: string | undefined, expected: string | undefined): boolean;
  export class Ingress {
    constructor(opts: {
      cfg: unknown;
      store: unknown;
      counters: unknown;
      wakeBus?: unknown;
      log?: unknown;
    });
    authorize(
      query: Record<string, unknown>,
      pathname?: string
    ): { ok: true; uid: string } | { ok: false; status: number; reason: string };
    accept(entry: { kind: string; uid: string; bodyText: string; sessionId?: string | null }): void;
    acceptRealtime(entry: { bodyText: string; sessionId?: string | null }): void;
    scheduleDrain(): Promise<void>;
    drain(): Promise<void>;
    processEntry(entry: { kind: string; uid: string; bodyText: string; receivedAt?: string }): void;
  }
}

declare module "*/omi-channel/lib/normalize.mjs" {
  export function transcriptText(segments: unknown): string;
  export function normalizeConversation(args: { id: string; uid: string; receivedAt: string; raw: unknown }): OmiCaptureEvent;
  export function normalizeDaySummary(args: { id: string; uid: string; receivedAt: string; raw: unknown }): OmiCaptureEvent;
  export function failedEvent(args: { id: string; uid?: string | null; receivedAt: string; kind?: string; reason: string }): OmiCaptureEvent;
}

declare module "*/omi-channel/lib/triage.mjs" {
  export function ruleFilter(
    event: unknown,
    cfg: unknown
  ): { action: "drop"; reason: string } | { action: "keep"; taskPath: boolean };
  export function buildTriagePrompt(args: { batch: unknown[]; projects: string[] }): string;
  export function parseTriageReply(reply: string): {
    cards: Array<Record<string, unknown> & { event_id?: string }>;
    memories: Array<Record<string, unknown>>;
    tips: Array<Record<string, unknown>>;
  } | null;
  export function tipsQueueDir(storeRoot: string): string;
  export function runTriageTick(deps: {
    cfg: unknown;
    store: unknown;
    counters: unknown;
    runFn: (args: { prompt: string }) => Promise<{ reply: string }>;
    board: unknown;
    memoryWriter: unknown;
    notifier?: unknown;
    log?: unknown;
    now?: Date;
  }): Promise<{
    modelCalls: number;
    dropped: number;
    cardsCreated: number;
    cardsDeduped: number;
    cardsSuppressed: number;
    memoriesWritten: number;
    memoriesSkipped: number;
    tipsQueued: number;
    tipsCapped: number;
    triaged: number;
    overflow: number;
    skipped: string | null;
    error: string | null;
  }>;
}

declare module "*/omi-channel/lib/gateway-client.mjs" {
  export function inferenceRunFn(
    gatewayUrl: string,
    opts?: { timeoutMs?: number; fetchImpl?: typeof fetch }
  ): (args: { prompt: string }) => Promise<{ reply: string }>;
}

declare module "*/omi-channel/lib/board-client.mjs" {
  export function boardBase(env?: Record<string, string | undefined>): string | null;
  export class BoardClient {
    constructor(opts?: { baseUrl?: string | null; fetchImpl?: typeof fetch; env?: Record<string, string | undefined> });
    base(): string | null;
    reachable(): Promise<boolean>;
    findByOriginId(originId: string): Promise<Array<Record<string, unknown>>>;
    createCard(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
    listProjects(): Promise<string[]>;
  }
}

declare module "*/omi-channel/lib/memory-writer.mjs" {
  export function vaultMemoryDir(env?: Record<string, string | undefined>): { vault: string; dir: string };
  export function redactSecrets(text: string): string;
  export class MemoryWriter {
    constructor(opts?: { dir?: string | null; env?: Record<string, string | undefined> });
    vault: string;
    dir: string;
    available(): boolean;
    write(args: {
      title: string;
      content: string;
      tags?: string[];
      provenance?: Record<string, string | null | undefined>;
      now?: Date;
    }): { ok: true; file: string } | { ok: false; skipped: string };
  }
}

declare module "*/omi-channel/lib/scheduler-jobs.mjs" {
  export const TRIAGE_JOB_ID: string;
  export function schedulerCli(env?: Record<string, string | undefined>): string;
  export function triageEnvPrefix(cfg: unknown, env?: Record<string, string | undefined>): string[];
  export function registerTriageJob(cfg: unknown, opts?: { env?: Record<string, string | undefined>; log?: unknown }): boolean;
  export function removeTriageJob(opts?: { env?: Record<string, string | undefined>; log?: unknown }): boolean;
  export function syncTriageJob(cfg: unknown, opts?: { env?: Record<string, string | undefined>; log?: unknown }): boolean;
}

interface OmiNotifyReceipt {
  means: string;
  ok: boolean;
  target?: string;
  skipped?: string;
  error?: string;
}

declare module "*/omi-channel/lib/omi-api.mjs" {
  export class OmiApi {
    constructor(opts?: {
      appId?: string;
      appSecret?: string;
      importApiKey?: string;
      baseUrl?: string;
      fetchImpl?: typeof fetch;
      sleep?: (ms: number) => Promise<void>;
      log?: unknown;
    });
    configured(): boolean;
    importConfigured(): boolean;
    sendNotification(args: { uid: string; message: string }): Promise<{
      ok: boolean;
      status?: number;
      error?: string;
      retriable?: boolean;
      attempts: number;
    }>;
    createMemories(args: {
      uid: string;
      memories: Array<{ content: string; tags?: string[] }>;
      textSourceSpec?: string;
    }): Promise<{ ok: boolean; status?: number; error?: string; retriable?: boolean; attempts: number }>;
  }
}

declare module "*/omi-channel/lib/backfeed.mjs" {
  export function fingerprint(kind: string, content: string): string;
  export class Backfeed {
    constructor(opts: {
      cfg: unknown;
      store: unknown;
      counters: unknown;
      omiApi: unknown;
      board: unknown;
      cardUrlFn?: ((id: string) => Promise<string | null>) | null;
      log?: unknown;
      now?: () => Date;
    });
    runOnce(): Promise<{ candidates: number; sent: number; deduped: number; failed: number; skipped: string | null }>;
    collectDecisions(): Array<{ kind: string; idKey: string | null; content: string; tags: string[] }>;
    buildDailyDigest(): Promise<{ kind: string; idKey: string; content: string; tags: string[] } | null>;
  }
}

declare module "*/omi-channel/lib/notify.mjs" {
  export function renderTemplate(template: string, params?: Record<string, unknown>): string;
  export function boardCardUrl(cardId: string | null, env?: Record<string, string | undefined>): Promise<string | null>;
  export class Notifier {
    constructor(opts: {
      cfg: unknown;
      store: unknown;
      counters: unknown;
      omiApi: unknown;
      fetchImpl?: typeof fetch;
      env?: Record<string, string | undefined>;
      log?: unknown;
      now?: () => Date;
    });
    cardUrl(cardId: string | null): Promise<string | null>;
    sentToday(): number;
    send(args: { template: string; params?: Record<string, unknown> }): Promise<OmiNotifyReceipt[]>;
    drainTips(): Promise<Array<{ tip: string; receipts: OmiNotifyReceipt[] }>>;
  }
}

declare module "*/omi-channel/lib/wake.mjs" {
  export function wakeRegex(variants: string[]): RegExp | null;
  export function buildWakePrompt(command: string, projects: string[]): string;
  export function parseWakeReply(reply: string): {
    intent: "create_task" | "create_event" | "query" | "note" | "unknown";
    title: string;
    description: string;
    project: string | null;
    answer: string;
    note_content: string;
  } | null;
  export class WakeBus {
    constructor(opts: {
      cfg: unknown;
      store: unknown;
      counters: unknown;
      runFn: ((args: { prompt: string }) => Promise<{ reply: string }>) | null;
      board: unknown;
      memoryWriter: unknown;
      notifier: unknown;
      log?: unknown;
      now?: () => number;
    });
    sessions: Map<string, unknown>;
    handleSegments(args: { sessionId: string; segments: unknown[] }): void;
    close(sessionId: string, reason: string): Promise<unknown>;
  }
}

declare module "*/omi-channel/lib/chat.mjs" {
  export const ASK_DEADLINE_MS: number;
  export function buildManifest(cfg: unknown): {
    tools: Array<{
      name: string;
      description: string;
      endpoint: string;
      method: string;
      parameters: { properties: Record<string, { type: string; description: string }>; required: string[] };
      auth_required: boolean;
      status_message: string;
    }>;
  };
  export function buildAskPrompt(query: string): string;
  export function manifestFingerprint(cfg: unknown): string;
  export class ChatTool {
    constructor(opts: {
      cfg: unknown;
      store: unknown;
      counters: unknown;
      runFn: ((args: { prompt: string }) => Promise<{ reply: string }>) | null;
      deadlineMs?: number;
      log?: unknown;
    });
    authorize(query: Record<string, unknown>, body: Record<string, unknown>):
      | { ok: true; uid: string }
      | { ok: false; status: number; error: string };
    handle(
      query: Record<string, unknown>,
      body: Record<string, unknown>
    ): Promise<{ status: number; body: { result?: string; error?: string } }>;
    manifest(query: Record<string, unknown>): { status: number; body: Record<string, unknown> };
  }
}

declare module "*/omi-channel/lib/tailnet-serve.mjs" {
  export function serveMapFromStatus(status: unknown): Map<number, string>;
  export function getTailnetServeMap(): Promise<Map<number, string>>;
  export function rehostToTailnet(absoluteUrl: string, map: Map<number, string>): string | null;
  export function toTailnetUrl(absoluteUrl: string): Promise<string | null>;
}

declare module "*/omi-channel/scripts/replay.mjs" {
  export function endpointForFixture(name: string): string;
  export function replayFixtures(opts: {
    base: string;
    key: string;
    uid: string;
    dir: string;
    fetchImpl?: typeof fetch;
  }): Promise<Array<{ file: string; endpoint: string; status: number; error: string | null }>>;
}
