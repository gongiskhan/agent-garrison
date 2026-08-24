// Types for the branding generator consumed by tests/node-identity.test.ts.
//
// The script must run standalone under plain `node`, so it duplicates the
// palette and monogram rules from src/lib/node-identity.ts. The test imports
// both and asserts they agree, which is what stops the copies drifting.
export interface NodeAccent {
  id: string;
  hex: string;
  ink: string;
}
export interface IconSize {
  file: string;
  size: number;
}
export const NODE_ACCENTS: NodeAccent[];
export const ICON_SIZES: IconSize[];
export function garrisonHome(): string;
export function sanitizeNodeId(raw: unknown): string | null;
export function accentForNodeId(id: string): NodeAccent;
export function resolveAccent(value: unknown, id: string): NodeAccent;
export function nodeMonogram(name: string): string;
export function readIdentity(home?: string): { id: string; name: string; accent: NodeAccent };
export function bandedSvg(
  sourceSvg: string,
  parts: { hex: string; ink: string; monogram: string }
): string;
