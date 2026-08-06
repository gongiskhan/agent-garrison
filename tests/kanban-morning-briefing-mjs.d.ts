declare module "*/kanban-loop/lib/morning-briefing.mjs" {
  export const MORNING_BRIEF_SYSTEM_KEY: string;
  export const MORNING_BRIEF_WEB_THREAD: string;
  export const MORNING_BRIEF_OMI_THREAD: string;
  export function isMorningBriefOccurrence(card: unknown): boolean;
  export function calendarResultFromSummary(summary: unknown): Record<string, unknown>;
  export function calendarResultFromEvidence(evidence: unknown): Record<string, unknown>;
  export function readMorningBriefConnectorEvidence(
    card: unknown,
    env?: Record<string, string | undefined>
  ): Record<string, unknown> | null;
  export function deliverMorningBriefCompletion(
    root: string,
    cardOrId: unknown,
    options?: Record<string, unknown>
  ): Promise<any>;
  export function reconcileMorningBriefDeliveries(
    root: string,
    options?: Record<string, unknown>
  ): Promise<{ checked: number; completed: number; skipped: number; errors: Array<{ cardId: string; error: string }> }>;
  export function scheduleMorningBriefDelivery(root: string, card: unknown, options?: Record<string, unknown>): boolean;
}
