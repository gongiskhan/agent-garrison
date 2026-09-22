type BeatResult = {
  beat: boolean;
  reason?: string;
  behind?: boolean;
  appReachable?: boolean | null;
};

declare module "*/scheduler/scripts/lib/node-beat.mjs" {
  export const BEAT_INTERVAL_MS: number;
  export function resolveAppUrl(env?: Record<string, string | undefined>): string | null;
  export function createNodeBeat(options?: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    log?: (message: string) => void;
    intervalMs?: number;
    readFileSync?: (path: string, enc: string) => string;
    onBeat?: (result: BeatResult) => unknown;
  }): {
    start(): void;
    stop(): void;
    beatOnce(): Promise<BeatResult>;
  };
  export function startNodeBeat(options?: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    log?: (message: string) => void;
    intervalMs?: number;
    readFileSync?: (path: string, enc: string) => string;
    onBeat?: (result: BeatResult) => unknown;
  }): { start(): void; stop(): void; beatOnce(): Promise<BeatResult> } | null;
}

declare module "*/scheduler/scripts/lib/app-watchdog.mjs" {
  export const UNREACHABLE_BUDGET_MS: number;
  export const HEAL_WINDOW_MS: number;
  export const MAX_HEALS_PER_WINDOW: number;
  export function healRecordPath(env?: Record<string, string | undefined>): string | null;
  export function resolveUnit(options?: {
    env?: Record<string, string | undefined>;
    readFileSync?: (path: string, enc: string) => string;
  }): string | null;
  type WatchdogOutcome = {
    state: "ok" | "watching" | "healing" | "no-unit" | "capped" | "healed";
    downMs?: number;
    unit?: string;
    heals?: number;
    queued?: boolean;
  };
  export function createAppWatchdog(options?: {
    env?: Record<string, string | undefined>;
    log?: (message: string) => void;
    now?: () => number;
    readFileSync?: (path: string, enc: string) => string;
    writeFileSync?: (path: string, data: string) => void;
    restart?: (unit: string) => Promise<{ queued: boolean; error?: string | null }>;
    budgetMs?: number;
  }): { record(result: BeatResult): Promise<WatchdogOutcome>; readonly downSince: number | null };
  export function startAppWatchdog(options?: {
    env?: Record<string, string | undefined>;
    log?: (message: string) => void;
    now?: () => number;
    readFileSync?: (path: string, enc: string) => string;
    writeFileSync?: (path: string, data: string) => void;
    restart?: (unit: string) => Promise<{ queued: boolean; error?: string | null }>;
    budgetMs?: number;
  }): { record(result: BeatResult): Promise<WatchdogOutcome>; readonly downSince: number | null } | null;
}
