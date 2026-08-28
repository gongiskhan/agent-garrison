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
    pendantEnabled: boolean;
    capturePolicy: "wake_only" | "ambient";
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
  export const COMPANION_WAKE_SOURCE: Record<string, unknown>;
  export const PENDANT_WAKE_SOURCE: Record<string, unknown>;
  export function startServer(cfg?: unknown): Promise<{
    server: Server;
    cfg: { port: number; statusFile: string; stateDir: string };
    store: unknown;
    counters: { read(): Record<string, number>; bump(key: string, by?: number): number };
    ingress: { sessions: Map<string, unknown>; close(): void };
    transcriber: unknown;
    wakeBus: unknown;
    pendantWakeBus: unknown;
    feedbackBus: {
      recentEvents(sessionId: string): Array<Record<string, unknown> & { event_id: string; name: string }>;
      emit(name: string, payload?: Record<string, unknown>): Record<string, unknown> | null;
    };
    echoGuard: unknown;
    notifier: unknown;
    ackSink: { burst: { suppressed: number; timer: unknown } };
  }>;
}

declare module "*/capture-service/lib/feedback.mjs" {
  export const FEEDBACK_EVENT_NAMES: string[];
  export class FeedbackBus {
    constructor(deps: {
      counters: unknown;
      log?: unknown;
      now?: () => number;
      wakeWindowTtlMs?: number;
      wakeProvisionalTtlMs?: number;
    });
    emit(
      name: string,
      payload?: Record<string, unknown>
    ): (Record<string, unknown> & { event_id: string; name: string; session_id: string; at: string }) | null;
    recordDeviceAck(eventId: string, opts?: { atMs?: number | null }): { name: string; latencyMs: number } | null;
    subscribeAll(fn: (event: Record<string, unknown>) => void): () => void;
    subscribe(sessionId: string, fn: (event: Record<string, unknown>) => void): () => void;
    recentEvents(sessionId: string): Array<Record<string, unknown> & { event_id: string; name: string }>;
  }
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

declare module "*/capture-service/lib/apns.mjs" {
  export function decodeP8(raw: unknown): string | null;
  export class ApnsSender {
    constructor(deps: Record<string, unknown>);
    cfg: Record<string, unknown>;
    enabled(): boolean;
    host(): string;
    providerToken(): string;
    notify(
      tokens: string[],
      alert?: { title?: string; body?: string; data?: Record<string, unknown> }
    ): Promise<{
      skipped?: string;
      error?: string;
      results: Array<{ token: string; status: number; reason: string; ok: boolean; dead: boolean; retryAfter: number | null }>;
    }>;
  }
}

declare module "*/capture-service/lib/notify.mjs" {
  export const COMPANION_THREAD_ID: string;
  export function renderTemplate(template: string, params?: Record<string, unknown>): string;
  export function isLoopbackUrl(url: string): boolean;
  export function boardCardUrl(cardId: string | null, env?: Record<string, string | undefined>): Promise<string | null>;
  export class CompanionNotifier {
    constructor(deps: Record<string, unknown>);
    cfg: Record<string, unknown>;
    apns: unknown;
    cardUrl(cardId: string | null): Promise<string | null>;
    // Two budgets since the 2026-08-15 "no feedback" incident: routine ack
    // fan-out can no longer starve the pushes that answer a spoken command.
    sentToday(priority?: "routine" | "interactive"): number;
    alreadyDelivered(idempotencyKey: string | null): boolean;
    markDelivered(idempotencyKey: string | null): void;
    send(args: { template: string; params?: Record<string, unknown> }): Promise<Array<Record<string, unknown> & { means: string; ok: boolean }>>;
    deliver(args: { title: string; body: string; link?: string | null; tag?: string | null }): Promise<Array<Record<string, unknown> & { means: string; ok: boolean }>>;
    sendWebChannelFallback(message: string): Promise<Record<string, unknown> & { means: string; ok: boolean }>;
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
declare module "*/capture-service/lib/opus-normalize.mjs" {
  // Unwraps a CBR-padded Opus packet back to its true payload length (padding
  // stalls Deepgram live); returns the bytes unchanged when there is nothing
  // to unwrap.
  export function normalizeOpusPacket(bytes: Uint8Array): Uint8Array;
}

declare module "*/capture-service/lib/tts.mjs" {
  export function textSeed(text: string): number;
  export function clipId(args: { text: string; voiceId: string; model: string }): string;
  export function looksPortuguese(text: unknown): boolean;
  export class ZecaVoice {
    constructor(deps: {
      cfg: Record<string, unknown>;
      counters: unknown;
      log?: unknown;
      fetchImpl?: (url: string, init: never) => Promise<unknown>;
      now?: () => number;
    });
    available(): { ok: boolean; reason?: string };
    readClip(id: unknown): Buffer | null;
    clipFor(text: unknown): Promise<{ id: string; cached?: boolean } | null>;
    cachedClipFor(text: unknown): { id: string; cached: boolean } | null;
    pin(id: unknown): void;
  }
}

declare module "*/capture-service/lib/cues.mjs" {
  export const CUE_TEXT: Record<string, Record<string, string> | null>;
  export class Cues {
    constructor(opts: { cfg: unknown; voice?: unknown; counters?: unknown; log?: unknown });
    enabled(): boolean;
    textFor(name: string, lang: string): string | null;
    speechFor(name: string, lang: string): { text: string; lang: string; audio_path?: string; priority: string } | null;
    ensure(text: string): Promise<{ id: string } | null>;
    prewarm(): Promise<number>;
    registerEcho(echoGuard: unknown, speak: unknown): void;
  }
}

declare module "*/capture-service/lib/language-memory.mjs" {
  export class LanguageMemory {
    constructor(opts: { stateDir: string; cfg?: unknown; counters?: unknown; now?: () => number; log?: unknown });
    note(sessionId: string | null, text: unknown): string | null;
    noteLanguage(sessionId: string | null, lang: unknown): string | null;
    markCapturing(sessionId: string, open: boolean): void;
    isCapturing(sessionId: string): boolean;
    current(sessionId?: string | null): string;
  }
}

declare module "*/capture-service/lib/echo-guard.mjs" {
  export function normalizeTokens(text: unknown): string[];
  export class EchoGuard {
    constructor(opts?: { ttlMs?: number; counters?: unknown; now?: () => number; log?: unknown });
    register(entry: { text: string; echo?: string | null }): boolean;
    registerShort(text: unknown, opts?: { ttlMs?: number }): boolean;
    shouldSuppress(segmentText: unknown): boolean;
  }
}

declare module "*/capture-service/lib/connector-call.mjs" {
  export function connectorScriptPath(connectorId: string, env?: Record<string, string | undefined>): string | null;
  export function makeConnectorFn(opts?: {
    env?: Record<string, string | undefined>;
    spawnImpl?: unknown;
    timeoutMs?: number;
  }): (connectorId: string, action: string, args?: Record<string, unknown>) => Promise<any>;
}

declare module "*/capture-service/lib/cortex-cli.mjs" {
  export function readInstallReceipt(env?: Record<string, string | undefined>): { bin: string; baseUrl: string | null } | null;
  export class CortexCli {
    constructor(opts: { cfg: unknown; counters?: unknown; env?: Record<string, string | undefined>; execImpl?: unknown; log?: unknown });
    resolve(spokenName: string): Promise<{ status: string; id?: string; name?: string; candidates?: string[] }>;
    run(automationId: string, inputs?: Record<string, unknown>, idempotencyKey?: string | null): Promise<{ runId: string | null; created: boolean }>;
    status(runId: string): Promise<unknown>;
  }
}

declare module "*/capture-service/lib/confirm-bus.mjs" {
  export function whatsappBase(env?: Record<string, string | undefined>): string | null;
  export class ConfirmBus {
    constructor(opts: Record<string, unknown>);
    enabled(): boolean;
    watch(): void;
    stop(): void;
    poll(): Promise<void>;
    onSpoken(ackId: string): void;
    consumeSegment(sessionId: string, text: unknown): boolean;
  }
}

// The wake bus is a byte-identical mirror of omi-channel's (companion-lockstep
// pins it), so the shim mirrors the shape the tests actually use.
declare module "*/capture-service/lib/wake.mjs" {
  export const DISCUSS_END: RegExp;
  export function wakeRegex(variants: string[]): RegExp | null;
  export function normalizeTitle(title: unknown): string;
  export function parseWakeReply(reply: string): Record<string, any> | null;
  export function buildWakePrompt(
    command: string,
    projects: string[],
    context?: Array<{ text: string; isUser: boolean }>,
    trailing?: string,
    now?: Date
  ): string;
  export function buildVoiceDiscussPrompt(topic: string, opts?: { context?: Array<{ text: string }> }): string;
  export function buildVoiceDiscussTurn(utterance: string): string;
  export function splitForSpeech(text: unknown, opts?: { maxChars?: number; maxChunks?: number }): string[];
  export function humanTime(iso: unknown, now?: Date, lang?: string): string;
  export class WakeBus {
    constructor(deps: Record<string, unknown>);
    delegateChain?: Promise<unknown>;
    handleSegments(args: { sessionId: string; segments: unknown[] }): void;
    close(sessionId: string, reason: string): Promise<any>;
    session(sessionId: string): { state: string; [k: string]: unknown };
    discussion(sessionId: string): { chain: Promise<unknown>; turns: number; [k: string]: unknown } | null;
    endDiscussion(sessionId: string, reason: string): { reason: string; turns: number } | null;
    resolveLanguage(command: string, parsed?: unknown): string;
  }
}
