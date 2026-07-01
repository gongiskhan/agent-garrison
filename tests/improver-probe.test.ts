import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Slice 3 (FLOW_PLAN docs/autothing/runs/20260701-092738-9b939e7a) - --probe
// now also tolerantly reads ecosystem-update-log.json / reapply-sweep-log.json.
// It must still print exactly "ok" and exit 0 whether those files are absent
// (fresh install - verify runs hours before the first nightly firing) or present.

const CLI = join(__dirname, "..", "fittings", "seed", "improver", "scripts", "improver.mjs");

function probe(dataDir: string): string {
  return execFileSync("node", [CLI, "--probe"], {
    env: { ...process.env, IMPROVER_DATA: dataDir },
    encoding: "utf8",
  });
}

describe("improver.mjs --probe (Slice 3 extension)", () => {
  it("prints ok when neither log file exists yet (fresh install)", () => {
    const data = mkdtempSync(join(tmpdir(), "gar-probe-fresh-"));
    const out = probe(data);
    expect(out.trim()).toBe("ok");
  });

  it("prints ok when both log files already exist with real entries", () => {
    const data = mkdtempSync(join(tmpdir(), "gar-probe-populated-"));
    mkdirSync(data, { recursive: true });
    writeFileSync(
      join(data, "ecosystem-update-log.json"),
      JSON.stringify([{ at: "2026-07-01T00:00:00Z", skipped: "no apm.yml at /tmp" }]),
      "utf8"
    );
    writeFileSync(
      join(data, "reapply-sweep-log.json"),
      JSON.stringify([{ at: "2026-07-01T00:00:00Z", checked: 0, restored: 0, failed: [] }]),
      "utf8"
    );
    const out = probe(data);
    expect(out.trim()).toBe("ok");
  });

  it("prints ok even when a log file is present but malformed (genuinely exercises the tolerant-read path)", () => {
    const data = mkdtempSync(join(tmpdir(), "gar-probe-malformed-"));
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "ecosystem-update-log.json"), "{ not valid json at all", "utf8");
    writeFileSync(join(data, "reapply-sweep-log.json"), "also not json", "utf8");
    const out = probe(data);
    expect(out.trim()).toBe("ok");
  });
});
