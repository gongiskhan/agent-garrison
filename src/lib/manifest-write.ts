// The ONE way a composition manifest is written.
//
// Two bugs made this module necessary, and both were invisible from the
// outside. First, Muster had two persist paths: one that pushed the edit to
// the mesh state service and one - the one nine of the ten mutations used -
// that only wrote the local file. The state service is the source of truth
// (src/lib/composition-sync.ts), so every duty toggle, cell target and level
// edit made on a node forked shared state silently and was reverted on the
// next up() of any node that materialises from the service. Second, both paths
// dumped the parsed manifest through js-yaml, and a YAML round trip cannot
// keep comments: the first write after any hand-edit stripped every line of
// prose from the manifest, mesh-wide.
//
// So: mutate the parsed manifest as before, then apply the DIFF onto the
// original document (the `yaml` package's Document keeps comments, anchors and
// key order), write atomically, and push. A node that cannot reach the service
// fails loudly rather than forking.

import { isScalar, parseDocument, type Document } from "yaml";
import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "./atomic-write";
import { pushManifestToState } from "./composition-sync";

export const MANIFEST_LINE_WIDTH = 100;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Write `after` into `doc`, touching only the paths that actually changed.
 *
 * An unchanged node keeps its node identity and therefore its comments. Lists
 * recurse BY INDEX - appending a duty or flipping a flag three levels inside a
 * list of fittings leaves every other element, and its prose, untouched. The
 * one loss this design accepts is a REORDERED list: matching elements by index
 * then reads every position as changed, and the comments inside it are
 * rewritten with their values. Matching by identity instead is guesswork, and
 * a wrong guess moves a comment onto the wrong item, which is worse.
 */
export function applyManifestDiff(
  doc: Document,
  before: unknown,
  after: unknown,
  at: (string | number)[] = []
): number {
  if (sameValue(before, after)) return 0;
  if (Array.isArray(before) && Array.isArray(after)) {
    let changes = 0;
    const common = Math.min(before.length, after.length);
    for (let i = 0; i < common; i += 1) changes += applyManifestDiff(doc, before[i], after[i], [...at, i]);
    for (let i = before.length - 1; i >= after.length; i -= 1) {
      doc.deleteIn([...at, i]);
      changes += 1;
    }
    for (let i = before.length; i < after.length; i += 1) {
      doc.setIn([...at, i], after[i]);
      changes += 1;
    }
    return changes;
  }
  if (!isPlainObject(before) || !isPlainObject(after)) {
    if (at.length === 0) throw new Error("applyManifestDiff: the manifest root must stay a mapping");
    if (after === undefined) {
      doc.deleteIn(at);
      return 1;
    }
    // A scalar that is merely CHANGED keeps its node - `setIn` would replace
    // it, and a replaced node loses the comment written above it. This is the
    // common case (a flag flipped in Muster) and the one where the comment
    // matters most, because it says why the flag is what it is.
    const existing = doc.getIn(at, true);
    if (isScalar(existing) && (typeof after !== "object" || after === null)) {
      existing.value = after;
      return 1;
    }
    doc.setIn(at, after);
    return 1;
  }
  let changes = 0;
  for (const key of Object.keys(before)) {
    if (!(key in after)) {
      doc.deleteIn([...at, key]);
      changes += 1;
    }
  }
  for (const [key, value] of Object.entries(after)) {
    changes += applyManifestDiff(doc, (before as Record<string, unknown>)[key], value, [...at, key]);
  }
  return changes;
}

export interface ManifestWriteResult {
  raw: string;
  changed: boolean;
  pushed: boolean;
  rev?: number;
}

/**
 * Persist a mutated manifest: comment-preserving serialisation, atomic write,
 * then the mesh push. `parsedBefore` is what the caller mutated, so the diff is
 * exactly the caller's intent - never a js-yaml/`yaml` parse difference.
 */
export async function persistManifest(
  compositionId: string,
  manifestPath: string,
  parsedBefore: unknown,
  mutated: unknown
): Promise<ManifestWriteResult> {
  const rawBefore = await readFile(manifestPath, "utf8");
  const doc = parseDocument(rawBefore);
  const changes = applyManifestDiff(doc, parsedBefore, mutated);
  const raw = doc.toString({ lineWidth: MANIFEST_LINE_WIDTH });
  const changed = raw !== rawBefore;
  // An unchanged manifest is still pushed when the service is behind (a
  // previous write that never left the node), but the file is left alone so a
  // chokidar watcher does not see a no-op edit.
  if (changed) await writeFileAtomic(manifestPath, raw);
  // MESH: the edit flows back to the state service (rev CAS). An enrolled node
  // whose edit cannot reach shared state must hear about it - the local file
  // already changed, so surface loudly rather than fork silently; the next
  // up() re-syncs from the service either way.
  try {
    const pushed = await pushManifestToState(compositionId, raw);
    return { raw, changed: changes > 0 || changed, pushed: pushed.pushed, rev: pushed.rev };
  } catch (err) {
    throw new Error(
      `manifest saved locally but NOT to the mesh state service — another node may not see this edit (${
        err instanceof Error ? err.message : String(err)
      })`
    );
  }
}
