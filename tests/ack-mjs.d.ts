declare module "*/kanban-loop/lib/ack.mjs" {
  export type AckTemplate = {
    kind: "captured" | "created" | "started" | "completed" | "failed";
    severity: "info" | "error";
    slots: string[];
    text: string;
    short?: string;
  };
  export const DEFAULT_TEMPLATES: Record<string, AckTemplate>;
  export function wakeVariants(env?: Record<string, string | undefined>): string[];
  export function wakeRegex(variants: string[]): RegExp | null;
  export function assertSpeakable(text: string, env?: Record<string, string | undefined>): string;
  export function validateTemplate(id: string, tpl: unknown): string[];
  export function loadTemplates(opts?: { env?: Record<string, string | undefined>; log?: unknown }): Record<string, AckTemplate>;
  export function renderAck(
    templateId: string,
    slots?: Record<string, unknown>,
    opts?: { templates?: Record<string, AckTemplate>; short?: boolean; env?: Record<string, string | undefined> }
  ): string;
  export function echoFingerprint(text: string): string;
  export function isAckableEventKind(kind: string): boolean;
  export function ackFromOriginEvent(
    event: { kind: string; idempotencyKey?: string | null } | null,
    card: Record<string, unknown> | null,
    opts?: { templates?: Record<string, AckTemplate>; env?: Record<string, string | undefined>; now?: () => Date }
  ): any;
}
