import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { capabilityKinds, singletonCapabilityKinds, facultyIds } from "../src/lib/types";
import { getFaculty } from "../src/lib/faculties";
import { parseGarrisonMetadata } from "../src/lib/metadata";
import { resolveCapabilities } from "../src/lib/capabilities";

const ROOT = join(__dirname, "..");
const MODES = JSON.parse(
  readFileSync(join(ROOT, "fittings/seed/modes/modes.json"), "utf8")
);

// Mode-bias floor/prefer are COMPUTE roles only — biasRole ranks via the compute
// ladder (fast<standard<expert) and leaves the task-specific roles (image/video/
// review) untouched, so a non-compute bias would type-check loosely and silently
// no-op. The bias vocabulary is therefore narrower than the full router role set.
const COMPUTE_ROLES = new Set(["fast", "standard", "expert"]);

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
      expect(COMPUTE_ROLES.has(bias.floor)).toBe(true);
      expect(COMPUTE_ROLES.has(bias.prefer)).toBe(true);
    }
  });

  it("every per-mode faculty is a REAL faculty id (s1a cross-model gate: no invented roles like 'knowledge')", () => {
    const validFaculties = new Set<string>(facultyIds as readonly string[]);
    for (const [name, mode] of Object.entries<any>(MODES.modes)) {
      for (const fac of mode.faculties ?? []) {
        expect(validFaculties.has(fac), `mode "${name}" faculty "${fac}" must be a real faculty id`).toBe(true);
      }
    }
  });

  it("setup.mjs creates the briefs dir at an ABSOLUTE MODES_BRIEFS_PATH (s1a cross-model gate: the actual write target exists)", () => {
    const target = join(mkdtempSync(join(tmpdir(), "modes-briefs-")), "briefs");
    expect(existsSync(target)).toBe(false);
    execFileSync("node", [join(ROOT, "fittings/seed/modes/scripts/setup.mjs")], {
      env: { ...process.env, MODES_BRIEFS_PATH: target },
      stdio: "ignore"
    });
    expect(existsSync(target)).toBe(true);
  });

  it.each([
    ["a missing file", "voice/DOES-NOT-EXIST.md"],
    ["a directory (not a file)", "voice"]
  ])("verify.mjs FAILS when a configured ref (sharedVoiceRef) points at %s (s1a r2/r3 regression)", (_label, badRef) => {
    const dir = mkdtempSync(join(tmpdir(), "modes-verify-"));
    cpSync(join(ROOT, "fittings/seed/modes"), join(dir, "modes"), { recursive: true });
    const cfgPath = join(dir, "modes", "modes.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    cfg.sharedVoiceRef = badRef;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
    let failed = false;
    try {
      execFileSync("node", [join(dir, "modes", "scripts", "verify.mjs")], { stdio: "ignore" });
    } catch {
      failed = true; // non-zero exit = verify correctly rejected the broken ref
    }
    expect(failed).toBe(true);
  });

  it.each([
    ["a non-compute role", { floor: "fast", prefer: "image" }],
    ["a non-object profile (primitive)", "fast"],
    ["a non-object profile (array)", ["fast", "standard"]]
  ])("verify.mjs FAILS when a routingBias profile is %s (s1e r2/r3 regression)", (_label, badBias) => {
    const dir = mkdtempSync(join(tmpdir(), "modes-bias-"));
    cpSync(join(ROOT, "fittings/seed/modes"), join(dir, "modes"), { recursive: true });
    const cfgPath = join(dir, "modes", "modes.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    cfg.routingBias["standard-toward-fast"] = badBias;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
    let failed = false;
    try {
      execFileSync("node", [join(dir, "modes", "scripts", "verify.mjs")], { stdio: "ignore" });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  it("the orchestrator consumes modes at optional-one alongside the orchestrator fitting (singleton-safe)", () => {
    const orchestratorMeta = parseGarrisonMetadata({
      faculty: "orchestrator",
      cardinality_hint: "single",
      component_shape: "system-prompt",
      platforms: ["claude-code"],
      provides: [{ kind: "orchestrator", name: "orchestrator" }],
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
      { id: "orchestrator", metadata: orchestratorMeta },
      { id: "modes", metadata: modesMeta }
    ]);
    expect(ok.ok).toBe(true);

    // a second modes provider must trip the singleton guard
    const dup = resolveCapabilities([
      { id: "orchestrator", metadata: orchestratorMeta },
      { id: "modes", metadata: modesMeta },
      { id: "modes-2", metadata: modesMeta }
    ]);
    expect(dup.ok).toBe(false);
  });
});
