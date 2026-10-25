import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { capabilityKinds } from "@/lib/types";
import { PROFILE_PORT_OFFSET } from "@/lib/instance-profile";
// @ts-ignore
import { servePort } from "../fittings/seed/preflight/lib/preflight-core.mjs";
// @ts-ignore
import { readCapabilityKinds, readHookScripts } from "../fittings/seed/preflight/lib/collect.mjs";
// @ts-ignore
import { findHookCwdAsymmetry } from "../fittings/seed/preflight/lib/preflight-core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

// Preflight is a plain .mjs fitting that must run on a cold machine, so it
// cannot import these .ts sources. It reads what it can as text and copies the
// rest. Copies drift, and a doctor whose whole value is being RIGHT about these
// invariants must not be the last to know -- so the copies are pinned here.
describe("preflight agrees with the sources it audits", () => {
  it("reads the same capability vocabulary the app defines", () => {
    const parsed = readCapabilityKinds(ROOT) as Set<string>;
    expect(parsed).toBeInstanceOf(Set);
    expect([...parsed].sort()).toEqual([...capabilityKinds].sort());
  });

  it("derives serve ports with the formula both publishers commit to", () => {
    for (const rel of ["src/lib/tailnet-publish.ts", "scripts/tailnet-serve-views.mjs"]) {
      expect(read(rel)).toContain("8400 + (localPort % 1000)");
    }
    expect(servePort(8098)).toBe(8498);
    expect(servePort(7098)).toBe(8498);
  });

  // The publishers bump past these; preflight must know the same set, or it
  // reports a reserved landing as fine.
  it("reserves every serve port the publishers refuse", () => {
    const core = read("fittings/seed/preflight/lib/preflight-core.mjs");
    const reserved = core.match(/RESERVED_SERVE = new Set\(\[([^\]]*)\]\)/);
    expect(reserved).not.toBeNull();
    const got = new Set(reserved![1].split(",").map((s) => Number(s.trim())));
    for (const port of [443, 8443, 8444, 8445]) expect(got.has(port)).toBe(true);
  });

  it("uses the app's own profile offsets", () => {
    expect(PROFILE_PORT_OFFSET).toEqual({ node: 0, dev: 10000, codex: 20000 });
    expect(read("fittings/seed/preflight/lib/collect.mjs")).toContain("PROFILE_PORT_OFFSET");
  });
});

// A live, open blocker: basic-memory computes the same MODULES_DIR in setup and
// verify, so setup looks for the kanban fitting under fittings/ (never there)
// and tears its consumer down, while verify looks under apm_modules (present)
// and demands it. Pinned here so the detector cannot silently stop finding it.
describe("the hook-cwd detector still catches the basic-memory divergence", () => {
  it("fails KANBAN_FITTING_DIR with both resolved paths as evidence", () => {
    // The REAL basic-memory hooks, copied into a root that stations them in a
    // composition whose apm_modules holds kanban-loop — the layout the runner
    // produces — so the test does not depend on a composition existing on the
    // machine that runs it.
    const root = mkdtempSync(path.join(os.tmpdir(), "preflight-basic-memory-"));
    const seed = path.join(root, "fittings", "seed", "basic-memory", "scripts");
    mkdirSync(seed, { recursive: true });
    mkdirSync(path.join(root, "compositions", "c1", "apm_modules", "_local", "kanban-loop"), { recursive: true });
    writeFileSync(path.join(root, "fittings", "seed", "basic-memory", "apm.yml"), read("fittings/seed/basic-memory/apm.yml"));
    for (const hook of ["setup.sh", "verify.sh"]) writeFileSync(path.join(seed, hook), read(`fittings/seed/basic-memory/scripts/${hook}`));
    const compositions = [{
      compositionId: "c1",
      parsed: { selections: [{ faculty: "memory", id: "basic-memory", pins: [] }], unfitted: [] }
    }];
    const entries = readHookScripts(root, compositions, "c1") as Array<{ id: string }>;
    const basicMemory = entries.find((e) => e.id === "basic-memory");
    expect(basicMemory, "basic-memory must still declare both hooks").toBeDefined();

    const findings = findHookCwdAsymmetry([basicMemory]) as Array<{ id: string; status: string; detail: string }>;
    const kanban = findings.find((f) => f.id === "basic-memory:KANBAN_FITTING_DIR");
    expect(kanban?.status).toBe("fail");
    expect(kanban?.detail).toContain("fittings/_local/kanban-loop");
    expect(kanban?.detail).toContain("apm_modules/_local/kanban-loop");
  });
});

// An inline `basename "$X"` guards ONE branch; a named predicate is a
// deliberate statement about the whole script. Treating the two the same would
// have been a silent false negative: basic-memory always had an inline guard on
// its skill block, and reading that as cover for KANBAN_FITTING_DIR would have
// hidden the exact bug this check exists to find.
describe("hook-cwd tells an inline guard from a declared predicate", () => {
  function tree(setupBody: string) {
    const root = mkdtempSync(path.join(os.tmpdir(), "preflight-guard-"));
    const seed = path.join(root, "fittings", "seed", "probe", "scripts");
    const comp = path.join(root, "compositions", "c1", "apm_modules", "_local");
    mkdirSync(seed, { recursive: true });
    mkdirSync(path.join(comp, "kanban-loop"), { recursive: true });
    writeFileSync(path.join(root, "fittings", "seed", "probe", "apm.yml"),
      "x-garrison:\n  setup:\n    command: bash scripts/setup.sh\n  verify:\n    command: bash apm_modules/_local/probe/scripts/verify.sh\n");
    const derive = [
      'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      'MODULES_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"',
      'TARGET="$MODULES_DIR/_local/kanban-loop"'
    ].join("\n");
    writeFileSync(path.join(seed, "setup.sh"), `${derive}\n${setupBody}\n`);
    writeFileSync(path.join(seed, "verify.sh"), `${derive}\n`);
    const compositions = [{ compositionId: "c1", parsed: { selections: [{ faculty: "f", id: "probe", pins: [] }], unfitted: [] } }];
    const entries = readHookScripts(root, compositions, "c1") as Array<{ id: string }>;
    return findHookCwdAsymmetry(entries) as Array<{ id: string; status: string }>;
  }

  it("still fails when only an unrelated inline branch tests the base", () => {
    const f = tree('if [ "$(basename "$MODULES_DIR")" != "apm_modules" ]; then :; fi');
    expect(f.find((x) => x.id === "probe:TARGET")?.status).toBe("fail");
  });

  it("quiets once a named predicate states the invariant", () => {
    const f = tree('installed() { [ "$(basename "$MODULES_DIR")" = "apm_modules" ]; }\nif ! installed; then :; fi');
    expect(f.find((x) => x.id === "probe:TARGET")?.status).toBe("info");
  });

  it("ignores a predicate that is defined but never called", () => {
    const f = tree('installed() { [ "$(basename "$MODULES_DIR")" = "apm_modules" ]; }');
    expect(f.find((x) => x.id === "probe:TARGET")?.status).toBe("fail");
  });
});
