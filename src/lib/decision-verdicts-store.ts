// The queue writer for decision verdicts (RUN-SPEC-V1).
//
// Split from `decision-verdicts.ts` because that module's vocabulary is imported by
// the Decisions panel, which is a "use client" component: a single `node:path`
// import there pulls a Node builtin into the browser bundle and the Next build
// fails. So the rule is simple and enforced by the build itself — the vocabulary
// and the record builders are pure and shared; anything that reaches the state
// service lives here, and only the API route imports it. The record's id is still
// minted in the pure module with Web Crypto, and travels here to become the row's
// primary key.

import path from "node:path";
import { garrisonDir } from "./claude-home";
import { withState } from "./state-client";
import { buildVerdictRecord, type DecisionVerdictInput } from "./decision-verdicts";

/** PRE-MESH: where the queue lived before it moved into the state service and the
 *  importer renamed the file `*.pre-mesh`. Nothing on the live path reads it. */
export const FEEDBACK_QUEUE_REL = path.join("improver", "feedback-queue.jsonl");

export function feedbackQueuePath(): string {
  return path.join(garrisonDir(), FEEDBACK_QUEUE_REL);
}

/**
 * Append one verdict to the state service's feedback queue.
 *
 * The single `appendFile` call every writer of this queue relied on for atomicity
 * is now one transaction, shared by all three producers across every node.
 *
 * Returns false when the INPUT was unusable, so a caller can answer 400 rather than
 * silently accepting a verdict it never wrote. A state-service failure is a
 * different thing and is not flattened into that boolean: it throws, the route
 * answers 5xx, and the degraded banner lights up. There is no local fallback file
 * — a feedback loop that silently splits in two is worse than one that stops.
 */
export async function recordDecisionVerdict(input: DecisionVerdictInput): Promise<boolean> {
  const record = buildVerdictRecord(input);
  if (!record) return false;
  const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : undefined;
  const sessionId =
    typeof record.session_id === "string" && record.session_id.trim() ? record.session_id.trim() : undefined;
  await withState((client) =>
    client.appendFeedback({
      ...(id ? { id } : {}),
      // MIRROR of improver/lib/feedback-signals.mjs `feedbackRowFromRecord`: the
      // payload is the record VERBATIM so every reader reconstructs exactly the
      // line this used to write, and the promoted columns are only a query
      // convenience over `provenance` / `area`.
      kind: "decision-verdict",
      area: "orchestrator",
      ...(sessionId ? { sessionId } : {}),
      payload: record
    })
  );
  return true;
}
