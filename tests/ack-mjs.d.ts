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
  export function loadTemplates(opts?: { env?: Record<string, string | undefined>; log?: unknown; lang?: string }): Record<string, AckTemplate>;
  export function loadTemplateSets(opts?: { env?: Record<string, string | undefined>; log?: unknown }): Record<string, Record<string, AckTemplate>>;
  export const PT_TEMPLATES: Record<string, AckTemplate>;
  export const TEMPLATES_BY_LANG: Record<string, Record<string, AckTemplate>>;
  export const ACK_LANGUAGES: string[];
  export function ackLanguage(env?: Record<string, string | undefined>): string | null;
  export function ackLanguageFor(
    card: unknown,
    opts?: { lang?: string | null; env?: Record<string, string | undefined>; defaultLang?: string | null }
  ): string;
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
    opts?: {
      templates?: Record<string, AckTemplate> | null;
      templateSets?: Record<string, Record<string, AckTemplate>>;
      lang?: string | null;
      defaultLang?: string | null;
      env?: Record<string, string | undefined>;
      now?: () => Date;
    }
  ): any;
}

// The echo guard shim lives in capture-service-mjs.d.ts (the module moved there
// with the wake bus on 2026-09-02).
