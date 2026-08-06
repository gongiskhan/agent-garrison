import path from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { capabilityKinds, facultyIds, singletonCapabilityKinds } from "@/lib/types";

const ROOT = path.resolve(__dirname, "..");
const SEED_DIR = path.join(ROOT, "fittings", "seed");

describe("named modes and persona fittings are retired", () => {
  it("has no modes, soul, Dispatcher, Identity Gary, or legacy delegating Orchestrator fitting", () => {
    const seeds = new Set(readdirSync(SEED_DIR));
    for (const id of ["modes", "soul", "dispatcher", "identity-gary", "garrison-orchestrator", "personal-operative"]) {
      expect(seeds.has(id) && existsSync(path.join(SEED_DIR, id, "apm.yml"))).toBe(false);
    }
    expect([...seeds].filter((id) => id.startsWith("soul-"))).toEqual([]);
  });

  it("does not expose the legacy Souls/classifier dogfood composition", () => {
    expect(existsSync(path.join(ROOT, "compositions", "dogfood-orch", "apm.yml"))).toBe(false);
  });

  it("removes modes from the public faculty and capability vocabularies", () => {
    expect(facultyIds as readonly string[]).not.toContain("modes");
    expect(capabilityKinds as readonly string[]).not.toContain("modes");
    expect(singletonCapabilityKinds as readonly string[]).not.toContain("modes");
  });

  it("Orchestrator owns identity and dispatch in one fitting", () => {
    const manifest = readFileSync(path.join(SEED_DIR, "orchestrator", "apm.yml"), "utf8");
    expect(manifest).toMatch(/kind: identity\s+name: authored/);
    expect(manifest).toMatch(/kind: duty\s+name: dispatch/);
  });
});
