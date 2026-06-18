import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { facultyIds, capabilityKinds } from "@/lib/types";

// RC5 docs-sync gate. This test derives the ground truth from SOURCE
// (`src/lib/types.ts`) and asserts the canonical docs reflect the current
// role model — 8 roles after the 2026-06-18 sessions split (was 24 flat
// faculties before the Quarters pivot), the shrunk capability-kind
// vocabulary, and the dropped kinds explicitly marked dropped. It is
// code-derived (not a hardcoded string list) so it keeps catching doc drift
// as the source evolves.

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

// The kinds the Quarters pivot retired. Asserted absent from `capabilityKinds`
// (source truth) and required to be explicitly marked "dropped" in the docs.
// data-source left this list 2026-06-10 and automation-runner left it
// 2026-06-13 (MR wave) — both re-added as live kinds for real Fittings
// (trello-data-source; the scheduler + the nightly Improver).
const DROPPED_KINDS = ["soul", "agent-skill", "mcp-gateway"];

// The kinds the 2026-06 Dev Env consolidation retired — terminal,
// worktree-management, and session-view collapsed into the single dev-env
// Fitting/kind.
const DROPPED_KINDS_2026_06 = ["terminal-session", "worktree", "session-view"];

// The stale flat-Faculty count phrasings that must no longer appear as the
// current model. (Historical references like "24-Faculty model" do not match.)
const STALE_FACULTY_COUNT = /24 flat top-level|24 flat\b|24 Faculties/i;

describe("docs reflect the Quarters pivot (RC5 sync)", () => {
  it("source is the truth this test guards against: 6 roles, dropped kinds gone", () => {
    expect([...facultyIds].sort()).toEqual([
      "channels",
      "gateway",
      "memory",
      "observability",
      "orchestrator",
      "runtimes",
      "sessions",
      "surfaces"
    ]);
    for (const dropped of [...DROPPED_KINDS, ...DROPPED_KINDS_2026_06]) {
      expect(capabilityKinds as readonly string[], `${dropped} must not be a live kind`).not.toContain(
        dropped
      );
    }
  });

  it("CAPABILITIES.md lists every live capability kind", () => {
    const doc = read("docs/CAPABILITIES.md");
    for (const kind of capabilityKinds) {
      expect(doc, `CAPABILITIES.md must document live kind "${kind}"`).toContain(kind);
    }
  });

  it("CAPABILITIES.md explicitly marks the dropped kinds as dropped", () => {
    const doc = read("docs/CAPABILITIES.md");
    const droppedLine = doc
      .split("\n")
      .find((line) => /dropped|removed|retired/i.test(line) && DROPPED_KINDS.every((k) => line.includes(k)));
    expect(
      droppedLine,
      "CAPABILITIES.md needs one line marking all four dropped kinds as dropped/removed/retired"
    ).toBeTruthy();
  });

  it("CAPABILITIES.md explicitly marks the Dev Env consolidation's dropped kinds", () => {
    const doc = read("docs/CAPABILITIES.md");
    const droppedLine = doc
      .split("\n")
      .find(
        (line) =>
          /dropped|removed|retired|consolidat/i.test(line) &&
          DROPPED_KINDS_2026_06.every((k) => line.includes(k))
      );
    expect(
      droppedLine,
      "CAPABILITIES.md needs one line marking terminal-session/worktree/session-view as dropped into dev-env"
    ).toBeTruthy();
  });

  it("METADATA.md lists every live capability kind in its kind enum", () => {
    const doc = read("docs/METADATA.md");
    for (const kind of capabilityKinds) {
      expect(doc, `METADATA.md must document live kind "${kind}"`).toContain(kind);
    }
  });

  it("FACULTIES.md describes the 6 roles, not the retired flat-Faculty count", () => {
    const doc = read("docs/FACULTIES.md");
    for (const role of facultyIds) {
      expect(doc, `FACULTIES.md must name role "${role}"`).toContain(role);
    }
    expect(doc, "FACULTIES.md must not present the stale 24-faculty count").not.toMatch(
      STALE_FACULTY_COUNT
    );
  });

  it("CLAUDE.md names the 6 roles and drops the stale 24-faculty count", () => {
    const doc = read("CLAUDE.md");
    for (const role of facultyIds) {
      expect(doc, `CLAUDE.md must name role "${role}"`).toContain(role);
    }
    expect(doc, "CLAUDE.md must not present the stale 24-faculty count").not.toMatch(
      STALE_FACULTY_COUNT
    );
  });

  it("SPEC.md does not present the stale 24-faculty count", () => {
    expect(read("docs/SPEC.md"), "SPEC.md stale count").not.toMatch(STALE_FACULTY_COUNT);
  });
});
