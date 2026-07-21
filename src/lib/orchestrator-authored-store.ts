// Authored-section write store for the Muster orchestrator panel (S5c).
//
// The layered orchestrator prompt (orchestrator-sections.ts) is two classes of
// section: GENERATED + LOCKED blocks that regenerate from the resolved model and
// are NEVER hand-edited (constraint 12), and AUTHORED + EDITABLE doctrine
// sections. This module is the WRITE half of the authored overrides that
// readAuthoredOverrides (orchestrator-projection.ts) reads back: it persists ONE
// authored section's text into the composition's flat {sectionId: markdown} JSON.
//
// Constraint 12 is enforced HERE, not just in the UI: this store refuses any
// section id that is not a known authored id, so a crafted request can never
// write a "capabilities"/"duties-and-levels"/"readiness" (locked) key - and even
// if a stale/foreign key sat in the JSON, readAuthoredOverrides filters to known
// authored ids and buildLockedSections regenerates locked blocks from the model,
// so locked content can never come off disk.

import path from "node:path";
import { writeJsonAtomic } from "./atomic-write";
import { AUTHORED_OVERRIDES_REL, readAuthoredOverrides } from "./orchestrator-projection";
import { AUTHORED_SECTION_IDS, type AuthoredSectionId } from "./orchestrator-authored-defaults";

// A generous ceiling so a single doctrine section can't be used to write an
// unbounded file, while never truncating realistic prose (the shipped defaults
// are ~600 bytes each).
export const MAX_AUTHORED_SECTION_BYTES = 100_000;

export function isAuthoredSectionId(id: unknown): id is AuthoredSectionId {
  return typeof id === "string" && (AUTHORED_SECTION_IDS as readonly string[]).includes(id);
}

// Persist one authored section's text for a composition. Merges into the existing
// overrides JSON so untouched authored sections keep their prior edits. An empty
// (whitespace-only) body RESETS the section to its shipped default by dropping
// the key rather than persisting a blank override (readAuthoredOverrides already
// ignores blank values; dropping keeps the file clean). Returns the full merged
// override set that is now on disk.
export async function writeAuthoredOverride(
  compositionDir: string,
  sectionId: string,
  content: string
): Promise<Partial<Record<AuthoredSectionId, string>>> {
  if (!isAuthoredSectionId(sectionId)) {
    // Constraint 12: refuse a locked/unknown id outright. The caller surfaces
    // this as a 400 - a locked section is only ever regenerated, never written.
    throw new Error(
      `orchestrator: "${sectionId}" is not an editable section - only ${AUTHORED_SECTION_IDS.join(", ")} can be authored`
    );
  }
  if (typeof content !== "string") {
    throw new Error("orchestrator: authored section content must be a string");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_AUTHORED_SECTION_BYTES) {
    throw new Error(
      `orchestrator: authored section exceeds the ${MAX_AUTHORED_SECTION_BYTES}-byte cap`
    );
  }

  const overrides = await readAuthoredOverrides(compositionDir);
  if (content.trim().length === 0) {
    delete overrides[sectionId];
  } else {
    overrides[sectionId] = content;
  }
  const target = path.join(compositionDir, AUTHORED_OVERRIDES_REL);
  await writeJsonAtomic(target, overrides);
  return overrides;
}
