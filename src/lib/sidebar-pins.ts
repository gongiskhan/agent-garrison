import path from "node:path";
import { readFileTolerant, writeJsonAtomic } from "./atomic-write";
import { garrisonDir } from "./claude-home";
import { StateUnavailableError, StateApiError, stateEnrolled, withState } from "./state-client";

// The sidebar's Pinned group — the user drags menu rows into it and the choice
// must survive restarts, browsers, AND MACHINES: the menu is meant to look the
// same on every node in the mesh, so the list is a SHARED state document
// (config doc `sidebar.pins` / scope `global`), not a per-node preference.
//
// The file under GARRISON_HOME survives as two narrower things:
//   - the whole store on a STANDALONE Garrison (no state service enrolled —
//     open-source single-machine install), and
//   - this node's materialisation of the shared list, so a state outage
//     degrades to the last known pins instead of an empty menu.
//
// Order is meaningful: the Pinned group renders in stored order and a drop
// inserts at position.

export interface SidebarPins {
  version: 1;
  pinned: string[];
}

// Two id shapes share the list: a fitting id, and a `nav:` command item (the
// fixed Garrison routes — Vault, Quarters, Mesh, …), which is why the pin store
// is no longer fitting-only. Fitting ids must accept every legal library id,
// including CLONES, whose user-supplied ids allow dots and underscores
// (CLONE_ID_RE in src/lib/clone.ts). Ids are stored as JSON content (never used
// as paths), so the gate is about well-formedness, not path safety.
const PIN_ID_PATTERN = /^(?:nav:)?[a-z0-9][a-z0-9._-]*$/i;

const NAMESPACE = "sidebar.pins";
const SCOPE = "global";

export function sidebarPinsPath(): string {
  return path.join(garrisonDir(), "sidebar-pins.json");
}

function emptyPins(): SidebarPins {
  return { version: 1, pinned: [] };
}

// Keep only well-formed ids, first occurrence wins (stable order). A malformed
// id is dropped rather than rejecting the whole list: one bad entry must never
// eat every other pin.
function sanitize(raw: unknown, { warn = false } = {}): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const id of raw) {
    if (typeof id !== "string" || !PIN_ID_PATTERN.test(id)) {
      if (warn) console.warn(`[garrison] dropping malformed id from pinned list: ${JSON.stringify(id)}`);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    clean.push(id);
  }
  return clean;
}

// ── the shared document ───────────────────────────────────────────────────
// Injected as one seam so the store can be tested on both sides of the mesh
// boundary without a live service (and so no test can reach the real one).

export interface SidebarPinsMeshStore {
  enrolled(): boolean;
  read(): Promise<{ pinned: string[]; rev: number } | null>;
  write(pinned: string[], ifMatchRev: number): Promise<void>;
}

const liveMeshStore: SidebarPinsMeshStore = {
  enrolled: () => stateEnrolled(),
  read: () =>
    withState(async (client) => {
      const doc = await client.getConfig(NAMESPACE, SCOPE);
      if (!doc) return null;
      return { pinned: sanitize((doc.body as { pinned?: unknown } | null)?.pinned), rev: doc.rev };
    }),
  write: (pinned, ifMatchRev) =>
    withState(async (client) => {
      await client.putConfig(NAMESPACE, SCOPE, { version: 1, pinned }, { ifMatchRev });
    })
};

let meshStore: SidebarPinsMeshStore = liveMeshStore;

/** Tests only: swap the shared-document seam (null restores the real one). */
export function setSidebarPinsMeshStore(store: SidebarPinsMeshStore | null): void {
  meshStore = store ?? liveMeshStore;
}

// ── the local file ────────────────────────────────────────────────────────

async function readLocalPins(): Promise<SidebarPins> {
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
  if (!result.exists) return emptyPins();
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    return emptyPins();
  }
  if (parsed === null || typeof parsed !== "object") return emptyPins();
  return { version: 1, pinned: sanitize((parsed as { pinned?: unknown }).pinned) };
}

// Hash-compare before writing: a read must not churn the file on every poll.
async function materialize(pinned: string[], current: string[]): Promise<void> {
  if (current.length === pinned.length && current.every((id, i) => id === pinned[i])) return;
  await writeJsonAtomic(sidebarPinsPath(), { version: 1, pinned } satisfies SidebarPins);
}

// ── the store ─────────────────────────────────────────────────────────────

export async function readSidebarPins(): Promise<SidebarPins> {
  const local = await readLocalPins();
  if (!meshStore.enrolled()) return local;
  try {
    const shared = await meshStore.read();
    if (!shared) {
      // No node has ever written the shared list. Adopt THIS node's pins as the
      // mesh seed so an existing install keeps its menu; losing the race to
      // another node is fine (the next read picks up whatever landed).
      if (local.pinned.length > 0) {
        try {
          await meshStore.write(local.pinned, 0);
        } catch {
          // seeding is best-effort; the local list still renders
        }
      }
      return local;
    }
    await materialize(shared.pinned, local.pinned);
    return { version: 1, pinned: shared.pinned };
  } catch (err) {
    // Degraded READ: the last materialisation is the best truth available.
    // Writes still refuse (below) — a fork is worse than a clear stop.
    if (err instanceof StateUnavailableError) return local;
    throw err;
  }
}

// Replace the whole list (the client sends its full, reordered state — pin,
// unpin, and reorder are all this one write).
//
// The shared document is authoritative: when the state service is unreachable
// the write FAILS rather than forking this node's menu from the mesh, which is
// exactly the drift the shared list exists to remove.
export async function writeSidebarPins(pinned: string[]): Promise<SidebarPins> {
  const clean = sanitize(pinned, { warn: true });
  if (meshStore.enrolled()) {
    const current = await meshStore.read();
    try {
      await meshStore.write(clean, current?.rev ?? 0);
    } catch (err) {
      // A 409 means another node wrote between the read and the put. This list
      // is a preference the user just authored in full, so the resolution is
      // last-writer-wins — retry ONCE against the fresh revision rather than
      // handing the user a conflict they cannot act on.
      if (!(err instanceof StateApiError) || err.status !== 409) throw err;
      const fresh = await meshStore.read();
      await meshStore.write(clean, fresh?.rev ?? 0);
    }
  }
  const next: SidebarPins = { version: 1, pinned: clean };
  await writeJsonAtomic(sidebarPinsPath(), next);
  return next;
}
