// The delay-buffer libs are plain JS Fitting modules (whatsapp-web ESM,
// slack-channel CJS — each Fitting keeps its own module system). These ambient
// declarations give the TS tests types so tsc --noEmit doesn't flag the JS
// imports as implicit-any, exactly like tests/connector-mjs.d.ts does for the
// connector executors.

interface GarrisonOutboxEntry {
  id: string;
  action: string;
  payload: Record<string, any>;
  summary: string;
  context: string;
  status: "pending" | "sending" | "sent" | "cancelled" | "failed";
  queuedAt: string;
  executeAt: string;
  settledAt: string | null;
  result: unknown;
  error: string | null;
}

interface GarrisonOutboxOptions {
  file: string;
  send: (entry: GarrisonOutboxEntry, batch: GarrisonOutboxEntry[]) => Promise<unknown>;
  delaySeconds?: number;
  /** Set only where the transport rate-limits per destination (Slack). */
  groupKey?: ((entry: GarrisonOutboxEntry) => string) | null;
  now?: () => number;
  setTimer?: (fn: () => void, delay: number) => any;
  clearTimer?: (handle: any) => void;
  log?: (message: string) => void;
}

interface GarrisonOutboxCancelOutcome {
  ok: boolean;
  status: string;
  error?: string;
  entry?: GarrisonOutboxEntry | null;
}

declare class GarrisonOutbox {
  constructor(options: GarrisonOutboxOptions);
  delayMs: number;
  read(): GarrisonOutboxEntry[];
  write(entries: GarrisonOutboxEntry[]): GarrisonOutboxEntry[];
  get(id: string): GarrisonOutboxEntry | null;
  pending(): GarrisonOutboxEntry[];
  enqueue(input: { action: string; payload: Record<string, any>; summary?: string; context?: string }): GarrisonOutboxEntry;
  schedule(entry: GarrisonOutboxEntry): void;
  fire(id: string): Promise<GarrisonOutboxEntry | null>;
  unschedule(id: string): void;
  settle(ids: string | string[], patch: Partial<GarrisonOutboxEntry>): GarrisonOutboxEntry | null;
  cancel(id: string): GarrisonOutboxCancelOutcome;
  rearm(): GarrisonOutboxEntry[];
}

declare module "*/whatsapp-web/lib/outbox.mjs" {
  export const OUTBOUND_DELAY_SECONDS: number;
  export function resolveSendContext(env?: Record<string, string | undefined>): "human" | "agent" | "automation";
  export class Outbox extends GarrisonOutbox {}
}

declare module "*/slack-channel/lib/outbox.js" {
  const api: {
    OUTBOUND_DELAY_SECONDS: number;
    resolveSendContext(env?: Record<string, string | undefined>): "human" | "agent" | "automation";
    Outbox: typeof GarrisonOutbox;
    publicEntry(entry: GarrisonOutboxEntry): Record<string, unknown>;
    slackDestination(entry: GarrisonOutboxEntry): string;
    renderBatch(entries: GarrisonOutboxEntry[]): string;
    createOutboxRoutes(options: {
      outbox: GarrisonOutbox;
      baseUrl?: string;
      announce?: ((entry: GarrisonOutboxEntry) => Promise<void>) | null;
      log?: (message: string) => void;
    }): {
      list(): { status: number; body: any };
      enqueue(body: any): Promise<{ status: number; body: any }>;
      cancel(id: string): { status: number; body: any };
    };
    renderQueuedNotice(entry: GarrisonOutboxEntry): { title: string; text: string; idempotencyKey: string };
  };
  export default api;
}
