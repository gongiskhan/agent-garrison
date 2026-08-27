import * as React from "react";

/** How a conversation payload should be rendered once opened. Inferred from the
 * reference's extension when the producer does not say. */
export type PayloadKind = "markdown" | "json" | "jsonl" | "text" | "image";

/** One payload a ledger row points at. `ref` is the OPAQUE reference the store
 * wrote (a content hash, a delegation id) - never a filesystem path, so a row can
 * never be used to name a file the serving router would not have produced. */
export interface PayloadTarget {
  ref: string;
  /** What to call it on screen. Defaults to the ref when a producer has no name. */
  name?: string;
  kind?: PayloadKind;
}

/**
 * The seam that turns a ledger row's `payloadRef` from a label into a control.
 *
 * The default is `null` ON PURPOSE: a transcript rendered by a host that has no
 * payload route (dev-env, the kanban session viewer, a related-task overlay)
 * keeps the A3 behaviour exactly - an inert reference label - rather than
 * offering a click that would 404. Only a host that CAN serve payloads
 * (ConversationView, which knows its `base`) provides a handler.
 */
export const PayloadOpenerContext = React.createContext<((target: PayloadTarget) => void) | null>(null);

const EXTENSION_KINDS: Record<string, PayloadKind> = {
  md: "markdown",
  markdown: "markdown",
  json: "json",
  jsonl: "jsonl",
  ndjson: "jsonl",
  txt: "text",
  log: "text",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
};

/** Kind from a name's extension. Unknown/absent → `text`, which renders the bytes
 * verbatim in a <pre> rather than guessing at structure that may not be there. */
export function payloadKindFromName(name: string | null | undefined, fallback: PayloadKind = "text"): PayloadKind {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(name ?? "").trim());
  if (!match) return fallback;
  return EXTENSION_KINDS[match[1].toLowerCase()] ?? fallback;
}
