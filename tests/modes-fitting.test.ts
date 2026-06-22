import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { capabilityKinds, singletonCapabilityKinds, facultyIds } from "../src/lib/types";
import { getFaculty } from "../src/lib/faculties";
import { parseGarrisonMetadata } from "../src/lib/metadata";
import { resolveCapabilities } from "../src/lib/capabilities";

const ROOT = join(__dirname, "..");
const MODES = JSON.parse(
  readFileSync(join(ROOT, "fittings/seed/modes/modes.json"), "utf8")
);

// The router ROLE vocabulary the per-mode bias floors/prefers must stay aligned
// with (routing-core.mjs ROLES) — keeps mode bias speaking the router's language.
const ROUTER_ROLES = new Set(["fast", "standard", "expert", "review", "image", "video"]);

describe("modes fitting (s1a) + capability kind/faculty (s1b)", () => {
  it("registers the `modes` faculty and capability kind", () => {
    expect(facultyIds).toContain("modes");
    expect(capabilityKinds).toContain("modes");
    expect(singletonCapabilityKinds).toContain("modes");
    const faculty = getFaculty("modes");
    expect(faculty.cardinality).toBe("single");
    expect(faculty.shapes).toContain("system-prompt");
  });

  it("parseGarrisonMetadata accepts a modes fitting (faculty modes, provides modes)", () => {
    const meta = parseGarrisonMetadata({
      faculty: "modes",
      cardinality_hint: "single",
      component_shape: "system-prompt",
      platforms: ["claude-code"],
      provides: [{ kind: "modes", name: "modes" }],
      verify: { command: "node scripts/verify.mjs", expect: "MODES-OK", timeout_ms: 10000 }
    });
    expect(meta.faculty).toBe("modes");
    expect(meta.provides[0].kind).toBe("modes");
  });

  it("modes.json wires three modes with souls + routing bias + channel defaults", () => {
    expect(MODES.version).toBe(1);
    for (const name of ["gary", "joe", "james"]) {
      const m = MODES.modes[name];
      expect(m, name).toBeTruthy();
      expect(typeof m.soulRef).toBe("string");
      expect(MODES.routingBias[m.routingBias]).toBeTruthy();
    }
    // the modes brief: dev-env starts in Joe, Slack starts in Gary
    expect(MODES.channelDefaults["dev-env"]).toBe("joe");
    expect(MODES.channelDefaults.slack).toBe("gary");
    // every bias floor/prefer must be a real router role
    for (const bias of Object.values<any>(MODES.routingBias)) {
      expect(ROUTER_ROLES.has(bias.floor)).toBe(true);
      expect(ROUTER_ROLES.has(bias.prefer)).toBe(true);
    }
  });

  it("the orchestrator consumes modes at optional-one alongside model-router (singleton-safe)", () => {
    const orchestratorMeta = parseGarrisonMetadata({
      faculty: "orchestrator",
      cardinality_hint: "single",
      component_shape: "system-prompt",
      platforms: ["claude-code"],
      provides: [{ kind: "orchestrator", name: "model-router" }],
      consumes: [{ kind: "modes", cardinality: "optional-one" }],
      verify: { command: "echo ok", expect: "ok", timeout_ms: 10000 }
    });
    const modesMeta = parseGarrisonMetadata({
      faculty: "modes",
      cardinality_hint: "single",
      component_shape: "system-prompt",
      platforms: ["claude-code"],
      provides: [{ kind: "modes", name: "modes" }],
      verify: { command: "node scripts/verify.mjs", expect: "MODES-OK", timeout_ms: 10000 }
    });

    const ok = resolveCapabilities([
      { id: "model-router", metadata: orchestratorMeta },
      { id: "modes", metadata: modesMeta }
    ]);
    expect(ok.ok).toBe(true);

    // a second modes provider must trip the singleton guard
    const dup = resolveCapabilities([
      { id: "model-router", metadata: orchestratorMeta },
      { id: "modes", metadata: modesMeta },
      { id: "modes-2", metadata: modesMeta }
    ]);
    expect(dup.ok).toBe(false);
  });
});
