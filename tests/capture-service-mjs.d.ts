// Ambient module shims so tsc can typecheck TS tests importing the
// capture-service fitting's plain-JS libs (vitest executes the real .mjs).

declare module "*/capture-service/lib/config.mjs" {
  export const FITTING_ID: string;
  export const CHANNEL_ID: string;
  export const DEFAULT_PORT: number;
  export const DEFAULT_WAKE_VARIANTS: string[];
  export function garrisonDir(env?: Record<string, string | undefined>): string;
  export function captureDir(env?: Record<string, string | undefined>): string;
  export function statusFilePath(env?: Record<string, string | undefined>): string;
  export function resolveGatewayUrl(env?: Record<string, string | undefined>): string | null;
  export function loadConfig(env?: Record<string, string | undefined>): {
    port: number;
    bindHost: string;
    gatewayUrl: string | null;
    home: string;
    stateDir: string;
    statusFile: string;
    enabled: boolean;
    transcribeEnabled: boolean;
    wakeEnabled: boolean;
    notifyEnabled: boolean;
    speakEnabled: boolean;
    sttModel: string;
    sttLanguage: string;
    classifyTarget: string;
    delegateEnabled: boolean;
    delegateTimeoutMs: number;
    wakeVariants: string[];
    wakeSilenceCloseMs: number;
    wakeSettledCloseMs: number;
    wakeMaxCaptureMs: number;
    wakeMinCaptureMs: number;
    wakeCommandWindowMs: number;
    wakeContextSegments: number;
    wakeContextMaxAgeMs: number;
    wakeCardDedupeMs: number;
    notifyMaxPerDay: number;
    apnsEnvironment: "production" | "sandbox";
    apnsTopic: string;
    sessionIdleTimeoutMs: number;
    minTranscriptWords: number;
    secrets: {
      deepgramApiKey: string;
      captureToken: string;
      apnsTeamId: string;
      apnsKeyId: string;
      apnsP8: string;
    };
    // Test escape hatch consumed off cfg, never env (omi precedent).
    syncJobs?: boolean;
  };
}

declare module "*/capture-service/scripts/server.mjs" {
  import type { Server } from "node:http";
  export function makeRequestHandler(ctx: unknown): (req: unknown, res: unknown) => Promise<void>;
  export function startServer(cfg?: unknown): Promise<{
    server: Server;
    cfg: { port: number; statusFile: string; stateDir: string };
    store: unknown;
    counters: { read(): Record<string, number>; bump(key: string, by?: number): number };
    ingress: { sessions: Map<string, unknown>; close(): void };
  }>;
}

declare module "*/capture-service/lib/ingress.mjs" {
  export const FRAME_HEADER: number;
  export function tokenMatches(presented: unknown, expected: unknown): boolean;
  export function bearerToken(req: { headers?: Record<string, string> }): string | null;
  export function parseMediaFrame(buf: Buffer): { kind: number; seq: number; ts: number; bytes: Buffer } | null;
  export function encodeMediaFrame(kind: number, seq: number, ts: number, bytes: Buffer): Buffer;
  export class CaptureIngress {
    constructor(deps: Record<string, unknown>);
    sessions: Map<string, unknown>;
    handleUpgrade(req: unknown, socket: unknown, head: unknown): void;
    finalizeSession(id: string, reason: string): void;
    close(): void;
  }
}

declare module "*/capture-service/lib/media-log.mjs" {
  export const AUDIO_RECORD_HEADER: number;
  export const REORDER_WINDOW: number;
  export function scanAudioLog(file: string): { lastSeq: number; records: number };
  export function readAudioLog(file: string): Generator<{ seq: number; ts: number; bytes: Buffer }>;
  export class SessionMedia {
    constructor(root: string, sessionId: string, opts?: Record<string, unknown>);
    acceptAudio(seq: number, ts: number, bytes: Buffer): number;
    acceptVideo(seq: number, ts: number, bytes: Buffer): number;
    highWater(): { audio: number; video: number };
    audioBytes(): number;
  }
}

declare module "*/capture-service/lib/deepgram-live.mjs" {
  export function deepgramUrl(cfg: unknown): string;
  export function segmentFromResults(msg: unknown): {
    start: number;
    end: number;
    text: string;
    speaker: number | null;
    is_user: boolean;
    final: boolean;
  } | null;
  export class TranscriptionLane {
    constructor(deps: Record<string, unknown>);
    available(): { ok: boolean; reason?: string };
    openSession(sessionId: string): boolean;
    feed(sessionId: string, bytes: Buffer): void;
    liveSegments(sessionId: string): unknown[] | null;
    subscribe(sessionId: string, listener: (segment: unknown) => void): (() => void) | null;
    end(sessionId: string): Promise<unknown[] | null>;
    close(): void;
  }
}

declare module "*/capture-service/lib/events.mjs" {
  export function transcriptProse(segments: Array<{ is_user?: boolean; speaker?: number | null; text: string }>): string;
  export function emitSessionEvent(args: {
    record: Record<string, unknown> & { id: string };
    store: unknown;
    counters: unknown;
    cfg: unknown;
    log?: unknown;
    now?: () => Date;
  }): (Record<string, unknown> & {
    id: string;
    status: string;
    source: string;
    normalized: { transcript_text: string; stats: { words: number; segments: number; hold_floor: number } };
    provenance: Record<string, unknown>;
  }) | null;
}

declare module "*/capture-service/lib/store.mjs" {
  export function ulid(now?: number): string;
  export function atomicWriteJSON(file: string, value: unknown): void;
  export function readJSON(file: string, fallback?: unknown): unknown;
  export class CaptureStore {
    constructor(root?: string);
    root: string;
    dirs: Record<string, string>;
    devicesFile: string;
    indexFile: string;
    pinnedUid(): null;
    writeEvent(event: { id: string } & Record<string, unknown>): string;
    getEvent(id: string): unknown;
    listEvents(status?: string | null): Array<Record<string, unknown> & { id: string; status?: string }>;
    updateEvent(
      id: string,
      patchOrFn: Record<string, unknown> | ((ev: Record<string, unknown>) => Record<string, unknown>)
    ): unknown;
    readIndex(): { bySession: Record<string, string> };
    sessionEventId(sessionId: string): string | null;
    recordSessionEvent(sessionId: string, eventId: string): void;
  }
  export class Counters {
    constructor(root: string, name: string);
    read(): Record<string, number>;
    bump(key: string, by?: number): number;
    set(key: string, value: number): number;
    observe(key: string, value: number): void;
  }
  export function mergedCounters(root: string): Record<string, number>;
}
