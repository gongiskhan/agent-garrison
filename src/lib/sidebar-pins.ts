import path from "node:path";
import { readFileTolerant, writeJsonAtomic } from "./atomic-write";
import { garrisonDir } from "./claude-home";

// The sidebar Fittings menu's pinned list — the user drags fitting rows into
// the Pinned group and the choice must survive restarts and browsers, so it
// lives server-side under GARRISON_HOME (per-instance, like every other
// Garrison preference) rather than in localStorage. Order is meaningful: the
// Pinned group renders in stored order and drops insert at position.

export interface SidebarPins {
  version: 1;
  pinned: string[];
}

// Must accept every legal library id — including CLONES, whose user-supplied
// ids allow dots and underscores (CLONE_ID_RE in src/lib/clone.ts). The ids
// are stored as JSON content (never used as paths), so the gate is about
// well-formedness, not path safety.
const FITTING_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

export function sidebarPinsPath(): string {
  return path.join(garrisonDir(), "sidebar-pins.json");
}

function emptyPins(): SidebarPins {
  return { version: 1, pinned: [] };
}

export async function readSidebarPins(): Promise<SidebarPins> {
  let result;
  try {
    result = await readFileTolerant(sidebarPinsPath(), {
      validate: (text) => {
        JSON.parse(text);
      }
    });
  } catch {
    return emptyPins();
  }
  if (!result.exists) {
    return emptyPins();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    return emptyPins();
  }
  if (parsed === null || typeof parsed !== "object") {
    return emptyPins();
  }
  const raw = (parsed as { pinned?: unknown }).pinned;
  if (!Array.isArray(raw)) {
    return emptyPins();
  }
  // Keep only well-formed ids, first occurrence wins (stable order).
  const seen = new Set<string>();
  const pinned: string[] = [];
  for (const id of raw) {
    if (typeof id !== "string" || !FITTING_ID_PATTERN.test(id) || seen.has(id)) continue;
    seen.add(id);
    pinned.push(id);
  }
  return { version: 1, pinned };
}

// Replace the whole list (the client sends its full, reordered state — pin,
// unpin, and reorder are all this one write). A malformed id is dropped with
// a warning rather than rejecting the write: one bad entry must never block
// persisting every other pin in the list.
export async function writeSidebarPins(pinned: string[]): Promise<SidebarPins> {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const id of pinned) {
    if (typeof id !== "string" || !FITTING_ID_PATTERN.test(id)) {
      console.warn(`[garrison] dropping malformed id from pinned list: ${JSON.stringify(id)}`);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    clean.push(id);
  }
  const next: SidebarPins = { version: 1, pinned: clean };
  await writeJsonAtomic(sidebarPinsPath(), next);
  return next;
}
