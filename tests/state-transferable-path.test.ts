// The state service's composition-file allow-list must stay in lockstep with
// src/lib/composition-transfer.ts — the SAME predicate guards the exporter,
// the importer, and now the API. A divergence would let a file travel one way
// and be unstorable the other.

import { describe, it, expect } from "vitest";
import { compositionExportPathAllowed } from "../src/lib/composition-transfer";
// @ts-expect-error — plain .mjs module
import { compositionPathAllowed } from "../services/state/src/lib/transferable-path.mjs";

const CORPUS = [
  // allowed
  "README.md",
  "NOTES.md",
  "routing.alt.json",
  ".garrison/routing.json",
  ".garrison/orchestrator-authored.json",
  ".garrison/prompts/orchestrator.md",
  ".garrison/prompts/dispatch.md",
  // never
  ".env",
  "local.yml",
  "apm.yml",
  "apm.lock.yaml",
  ".garrison/owner.json",
  ".garrison/last-up.json",
  ".garrison/decisions.jsonl",
  ".garrison/prompts/soul.md",
  ".garrison/assembled-system-prompt.md",
  "apm_modules/x/y.md",
  ".claude/settings.json",
  "../escape.md",
  ".garrison/../.env",
  "/abs/path.md",
  "artifacts/file.md",
  "logs/log.md",
  "",
  ".garrison/routing.json.bak",
  "uploads/u.md"
];

describe("transferable-path parity", () => {
  for (const p of CORPUS) {
    it(`agrees on ${JSON.stringify(p)}`, () => {
      expect(compositionPathAllowed(p)).toBe(compositionExportPathAllowed(p));
    });
  }

  it("both allow the authored set and refuse the node-local set", () => {
    expect(compositionPathAllowed(".garrison/routing.json")).toBe(true);
    expect(compositionPathAllowed(".env")).toBe(false);
    expect(compositionPathAllowed("local.yml")).toBe(false);
  });
});
