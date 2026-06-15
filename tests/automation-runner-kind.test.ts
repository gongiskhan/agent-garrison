import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { capabilityKinds } from "@/lib/types";
import { parseGarrisonMetadata, validateSelection } from "@/lib/metadata";

// MR0b — re-add the `automation-runner` capability kind (dropped 2026-06-07) and
// repair the scheduler manifest + its automation ecosystem so they parse + are
// selectable under the live 6-roles schema. Faculties are shape/cardinality
// driven: `observability` accepts `script` (scheduler, loop-heartbeat);
// `sessions` is the only role accepting `cli-skill` (morning-briefing,
// google-calendar, vault-sync). Satisfies brief §3 token `scheduler-manifest-ok`.

const ROOT = path.resolve(__dirname, "..");

function xgarrison(fitting: string): unknown {
  const raw = yaml.load(
    fs.readFileSync(path.join(ROOT, "fittings/seed", fitting, "apm.yml"), "utf8")
  ) as Record<string, unknown>;
  return raw["x-garrison"];
}

describe("MR0b — automation-runner kind re-add + scheduler manifest repair", () => {
  it("automation-runner is back in the capability-kind vocabulary", () => {
    expect(capabilityKinds).toContain("automation-runner");
  });

  it("the scheduler fitting parses, validates, and is selectable", () => {
    const m = parseGarrisonMetadata(xgarrison("scheduler"));
    expect(m.faculty).toBe("observability");
    expect(m.provides).toContainEqual({ kind: "automation-runner", name: "scheduler" });
    // Selectable: faculty match + cardinality + accepted shape + claude-code platform.
    expect(() => validateSelection("observability", 1, [m])).not.toThrow();
  });

  it("the automation-runner ecosystem fittings parse + validate (shape-driven role)", () => {
    const expected: Record<string, "observability" | "sessions"> = {
      "loop-heartbeat": "observability",
      "morning-briefing": "sessions",
      "google-calendar": "sessions",
      "vault-sync": "sessions"
    };
    for (const [fitting, faculty] of Object.entries(expected)) {
      const m = parseGarrisonMetadata(xgarrison(fitting));
      expect(m.faculty, `${fitting} faculty`).toBe(faculty);
      expect(() => validateSelection(faculty, 1, [m]), `${fitting} selectable`).not.toThrow();
    }
  });
});
