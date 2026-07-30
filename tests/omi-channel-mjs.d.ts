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
  export function makeRequestHandler(cfg: unknown): (req: unknown, res: unknown) => Promise<void>;
  export function startServer(cfg?: unknown): Promise<Server>;
}
