declare module "*/scheduler/scripts/lib/node-beat.mjs" {
  export const BEAT_INTERVAL_MS: number;
  export function resolveAppUrl(env?: Record<string, string | undefined>): string | null;
  export function createNodeBeat(options?: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    log?: (message: string) => void;
    intervalMs?: number;
    readFileSync?: (path: string, enc: string) => string;
  }): {
    start(): void;
    stop(): void;
    beatOnce(): Promise<{ beat: boolean; reason?: string; behind?: boolean }>;
  };
  export function startNodeBeat(options?: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    log?: (message: string) => void;
    intervalMs?: number;
    readFileSync?: (path: string, enc: string) => string;
  }): { start(): void; stop(): void; beatOnce(): Promise<{ beat: boolean; reason?: string }> } | null;
}
