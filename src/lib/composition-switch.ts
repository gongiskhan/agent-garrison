import { computeCapabilityResolution, selectedLibraryEntries } from "./compositions";
import { readYamlFile } from "./yaml";
import {
  getActiveComposition,
  setActiveComposition,
  resolveCompositionPointer,
  type ResolvedComposition
} from "./active-composition";
import type { CapabilityIssue, FittingSelectionMap } from "./types";

// Composition switching (WS4 / D6): a clean down -> re-resolve -> up, where the
// re-resolve happens FIRST and blocks the whole switch with a readable message
// before any state changes. One active composition at a time.

export interface SwitchResult {
  ok: boolean;
  error?: string;
  id?: string;
}

export interface SwitchDeps {
  resolveTarget: (pointer: string) => Promise<TargetResolution>;
  getActive: () => Promise<string>;
  setActive: (pointer: string) => Promise<void>;
  up: (compositionId: string) => Promise<unknown>;
  down: (compositionId: string) => Promise<unknown>;
}

export interface TargetResolution {
  resolved: ResolvedComposition;
  issues: CapabilityIssue[];
}

// Read a target composition's manifest and run the capability resolver over its
// selections WITHOUT installing or running anything. Throws when the manifest is
// missing/unreadable so the caller can surface a readable block message.
export async function resolveTargetComposition(pointer: string): Promise<TargetResolution> {
  const resolved = resolveCompositionPointer(pointer);
  const manifest = await readYamlFile<{
    "x-garrison"?: { composition?: { selections?: FittingSelectionMap } };
  }>(resolved.manifestPath);
  if (!manifest) {
    throw new Error(`composition manifest not found or unreadable at ${resolved.manifestPath}`);
  }
  const selections = manifest["x-garrison"]?.composition?.selections ?? {};
  const entries = await selectedLibraryEntries(selections);
  const { issues } = computeCapabilityResolution(entries);
  return { resolved, issues };
}

export function formatResolverError(target: string, issues: CapabilityIssue[]): string {
  const lines = issues.map(
    (issue) => `  - ${issue.kind}${issue.name ? `:${issue.name}` : ""} (${issue.code}): ${issue.message}`
  );
  return `Cannot switch to "${target}" - capability resolution failed:\n${lines.join("\n")}`;
}

// The real dependency set. up/down are lazy-imported so the heavy runner module
// (chokidar, spawn helpers, gateway logic) is only loaded when a switch actually
// runs - unit tests inject fakes and never touch the runner.
const defaultDeps: SwitchDeps = {
  resolveTarget: resolveTargetComposition,
  getActive: getActiveComposition,
  setActive: setActiveComposition,
  up: async (id) => (await import("./runner")).up(id),
  down: async (id) => (await import("./runner")).down(id)
};

// Switch the active composition. Order (D6):
//   1. RESOLVE the target first. On any resolver error, return {ok:false} and
//      DO NOT touch running state or the pointer.
//   2. down() the current active composition.
//   3. set the pointer.
//   4. up() the new composition.
export async function switchComposition(
  target: string,
  overrides: Partial<SwitchDeps> = {}
): Promise<SwitchResult> {
  const deps: SwitchDeps = { ...defaultDeps, ...overrides };
  const pointer = (target ?? "").trim();
  if (pointer.length === 0) {
    return { ok: false, error: "no target composition given" };
  }

  // 1. RESOLVE FIRST — nothing has changed yet.
  let resolution: TargetResolution;
  try {
    resolution = await deps.resolveTarget(pointer);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (resolution.issues.length > 0) {
    return { ok: false, error: formatResolverError(pointer, resolution.issues) };
  }

  // 2. down the current active composition.
  const currentPointer = await deps.getActive();
  const currentId = resolveCompositionPointer(currentPointer).id;
  try {
    await deps.down(currentId);
  } catch (err) {
    // Surface the stop failure but leave the pointer on the current composition
    // rather than flipping it while the old operative is half-torn-down.
    return {
      ok: false,
      error: `failed to stop current composition "${currentId}": ${err instanceof Error ? err.message : String(err)}`
    };
  }

  // 3. set the pointer.
  await deps.setActive(pointer);

  // 4. up the new composition.
  try {
    await deps.up(resolution.resolved.id);
  } catch (err) {
    return {
      ok: false,
      id: resolution.resolved.id,
      error: `switched the pointer to "${resolution.resolved.id}" but starting it failed: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  return { ok: true, id: resolution.resolved.id };
}
