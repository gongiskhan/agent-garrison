declare module "*/kanban-loop/lib/notify-origin.mjs" {
  export interface FanOutNotificationResult {
    id: string;
    status: number;
    ok: boolean;
  }

  export function fanOutNotification(
    payload: {
      title?: string;
      text?: string;
      actions?: unknown[];
      link?: string | null;
      tag?: string | null;
    },
    options?: {
      skipFittingIds?: string[];
      fetchImpl?: typeof fetch;
      serveMap?: Map<number, string>;
    }
  ): Promise<FanOutNotificationResult[]>;

  export function outcomeMessage(card: Record<string, unknown>, options?: { summary?: string }): string;
  export function terminalTransition(
    previous: Record<string, unknown> | null,
    next: Record<string, unknown>
  ): boolean;
  export function notifyOriginTransition(
    previous: Record<string, unknown> | null,
    next: Record<string, unknown>
  ): void;
  export function createdMessage(card: Record<string, unknown>): string;
  export function dutySummaryMessage(
    card: Record<string, unknown>,
    detail?: Record<string, unknown>
  ): string;
  export function needsInputMessage(
    card: Record<string, unknown>,
    detail?: Record<string, unknown>
  ): string;
  export function routeOriginEvent(...args: unknown[]): unknown;
  export function routeTerminalTransition(...args: unknown[]): unknown;
  export function routeNeedsInput(...args: unknown[]): unknown;
}
