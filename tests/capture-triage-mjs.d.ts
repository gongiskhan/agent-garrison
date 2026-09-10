// Capture triage and retained pendant wake contracts.
declare module "*/capture-service/lib/triage.mjs" {
  export const HOLD_MAX_MS: number;
  export const TRIAGE_SOURCES: Record<string, Record<string, unknown>>;
  export function sourceIdentity(event: unknown): Record<string, unknown> & { originPrefix: string; label: string };
  export function ruleFilter(
    event: unknown,
    cfg: unknown,
    now?: Date
  ): { action: "drop"; reason: string } | { action: "hold"; reason: string } | { action: "keep"; taskPath: boolean };
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
    extraStores?: unknown[];
    memoryWriterFor?: (event: unknown) => unknown;
    notifierFor?: (event: unknown) => unknown;
  }): Promise<{
    modelCalls: number;
    dropped: number;
    held: number;
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

declare module "*/capture-service/lib/wake.mjs" {
  export const PENDANT_WAKE_SOURCE: {
    id: string;
    label: string;
    originPrefix: string;
    originChannel: { channel: string; threadId: string };
    sessionProvenanceKey: string;
    logPrefix: string;
  };
  export function vagueTimeAnchors(now?: Date): Array<{ phrases: string[]; iso: string }>;
  export function buildRevisionPrompt(args: {
    command: string;
    title: string;
    description: string;
    conversation: string;
  }): string;
  export function parseRevisionReply(reply: string): {
    action: "none" | "revise";
    title: string;
    description: string;
    note: string;
  } | null;
  // WakeBus itself is declared in tests/capture-service-mjs.d.ts; a class
  // cannot be merged across ambient blocks, so the omi-source wake test widens
  // the instance type locally for the members it drives (sessions,
  // runRevision).
}

declare module "*/capture-service/lib/memory-writer.mjs" {
  export class MemoryWriter {
    constructor(opts?: { dir?: string | null; env?: Record<string, string | undefined>; prefix?: string; label?: string });
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

