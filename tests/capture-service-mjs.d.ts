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
    counters: unknown;
  }>;
}

declare module "*/capture-service/lib/store.mjs" {
  export function ulid(now?: number): string;
  export function atomicWriteJSON(file: string, value: unknown): void;
  export function readJSON(file: string, fallback?: unknown): unknown;
  export class CaptureStore {
    constructor(root?: string);
    root: string;
    dirs: Record<string, string>;
    writeEvent(event: { id: string } & Record<string, unknown>): string;
    getEvent(id: string): unknown;
    listEvents(status?: string | null): unknown[];
    updateEvent(id: string, patch: Record<string, unknown>): unknown;
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
