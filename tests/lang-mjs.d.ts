// Ambient module shim for the mirrored lang.mjs (vitest executes the real .mjs).
// One wildcard covers all three copies - capture-service, kanban-loop and
// omi-channel hold byte-identical files, pinned by companion-lockstep.

declare module "*/lib/lang.mjs" {
  export type Language = "pt" | "en";
  export function detectLanguage(text: unknown): Language | null;
  export function isLanguage(value: unknown): boolean;
  export function pickLanguage(opts?: {
    explicit?: string | null;
    remembered?: string | null;
    sample?: string | null;
    fallback?: string | null;
  }): Language;
  export const LANGUAGES: Language[];
  export const MESSAGES: Record<string, Record<string, string>>;
  export function t(key: string, params?: Record<string, unknown>, lang?: string): string;
}
