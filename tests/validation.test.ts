import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateFitting } from "@/lib/validation";

const SEED_DIR = path.resolve(__dirname, "..", "fittings", "seed");
const seedIds = [
  "loop-heartbeat",
  "tier-classifier",
  "memory",
  "http-gateway",
  "browser-automation",
  "trello-data-source"
] as const;

describe("validateFitting", () => {
  for (const id of seedIds) {
    it(`seed ${id} passes all four checks`, async () => {
      const report = await validateFitting(path.join(SEED_DIR, id));
      const summary = report.checks
        .filter((check) => !check.passed)
        .map((check) => `${check.name}: ${check.errors.join("; ")}`)
        .join("\n");
      expect(report.overall, summary || "expected pass").toBe("pass");
    });
  }

  it("flags an architecture failure when apm.yml has no x-garrison block", async () => {
    const report = await validateFitting(path.join(SEED_DIR));
    expect(report.overall).toBe("fail");
    const arch = report.checks.find((check) => check.name === "architecture");
    expect(arch?.passed).toBe(false);
  });
});
