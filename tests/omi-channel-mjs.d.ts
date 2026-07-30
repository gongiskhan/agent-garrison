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
    constructor(opts: { cfg: unknown; store: unknown; counters: unknown; log?: unknown });
    authorize(query: Record<string, unknown>): { ok: true; uid: string } | { ok: false; status: number; reason: string };
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
