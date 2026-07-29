// The queue writer for decision verdicts (RUN-SPEC-V1).
//
// Split from `decision-verdicts.ts` because that module's vocabulary is imported by
// the Decisions panel, which is a "use client" component: a single `node:path`
// import there pulls a Node builtin into the browser bundle and the Next build
// fails. So the rule is simple and enforced by the build itself — the vocabulary
// and the record builders are pure and shared; anything that touches the disk lives
// here, and only the API route imports it.

import path from "node:path";
import { promises as fs } from "node:fs";
import { garrisonDir } from "./claude-home";
import { buildVerdictRecord, type DecisionVerdictInput } from "./decision-verdicts";

/** The queue the Improver's `feedback` rule reads. One JSON object per line. */
export const FEEDBACK_QUEUE_REL = path.join("improver", "feedback-queue.jsonl");

export function feedbackQueuePath(): string {
  // garrisonDir() honors GARRISON_HOME, so a dev instance's verdicts land in the
  // dev home and never in the queue prod's nightly Improver reads.
  return path.join(garrisonDir(), FEEDBACK_QUEUE_REL);
}

/**
 * Append one verdict. Single `appendFile` call per record, which is the atomicity
 * every other writer of this queue relies on to keep concurrent appends from
 * interleaving mid-line.
 *
 * Returns false when the input was unusable, so a caller can answer 400 rather than
 * silently accepting a verdict it never wrote.
 */
export async function recordDecisionVerdict(
  input: DecisionVerdictInput,
  file: string = feedbackQueuePath()
): Promise<boolean> {
  const record = buildVerdictRecord(input);
  if (!record) return false;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(record) + "\n", "utf8");
  return true;
}
