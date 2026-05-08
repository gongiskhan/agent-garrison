import path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readYamlFile } from "@/lib/yaml";
import { parseGarrisonMetadata } from "@/lib/metadata";
import type { GarrisonMetadata } from "@/lib/types";

const REPO_ROOT = path.resolve(__dirname, "..");
const FITTING_DIR = path.join(REPO_ROOT, "fittings/seed/morning-briefing");
const SCRIPTS = path.join(FITTING_DIR, "scripts");

interface RawManifest {
  "x-garrison"?: unknown;
}

async function loadMetadata(): Promise<GarrisonMetadata> {
  const manifest = await readYamlFile<RawManifest>(
    path.join(FITTING_DIR, "apm.yml")
  );
  return parseGarrisonMetadata(manifest!["x-garrison"]);
}

function isExecutable(file: string): boolean {
  if (!existsSync(file)) return false;
  return (statSync(file).mode & 0o111) !== 0;
}

describe("morning-briefing Fitting", () => {
  it("apm.yml declares the right capability shape", async () => {
    const md = await loadMetadata();
    expect(md.faculty).toBe("automations");
    expect(md.component_shape).toBe("cli-skill");
    expect(md.provides).toEqual([]);
    expect(md.setup?.command).toContain("scripts/setup.sh");
    expect(md.verify?.expect).toBe("ok");
  });

  it("setup, verify, and briefing scripts exist and are executable", () => {
    for (const name of ["setup.sh", "verify.sh", "briefing.sh", "briefing.py"]) {
      const file = path.join(SCRIPTS, name);
      expect(isExecutable(file), `${name} should be executable`).toBe(true);
    }
  });

  it("briefing.py --render-prompt substitutes date and weekday", () => {
    const result = spawnSync(
      "python3",
      [path.join(SCRIPTS, "briefing.py"), "--render-prompt", "2026-05-08"],
      { encoding: "utf8" }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Today is 2026-05-08 (Friday)");
    expect(result.stdout).toContain("orchestrator report_channel");
    expect(result.stdout).toContain("if report_channel is empty");
    expect(result.stdout).toContain("don't offer to do work autonomously");
  });

  it("the SKILL.md exists and references the synthetic-prompt contract", () => {
    const skill = path.join(
      FITTING_DIR,
      ".apm/skills/morning-briefing/SKILL.md"
    );
    expect(existsSync(skill)).toBe(true);
  });
});
