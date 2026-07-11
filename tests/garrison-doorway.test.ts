// S5 (GARRISON-UNIFY-V1) — the thin doorway + one-policy grep proofs (D5/D13/
// D14) and the codex-runtime serialization lock the fitting now owns.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(__dirname, "..");
const FAMILY = path.join(ROOT, "fittings/seed/autothing-skills/.apm/skills");

const D5_ERROR =
  "Garrison Orchestrator policy not found at ~/.garrison/orchestrator/policy.json. Start Garrison; autothing does not run standalone.";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

describe("thin doorway (D13)", () => {
  const doorway = readFileSync(path.join(FAMILY, "autothing/SKILL.md"), "utf8");

  it("carries the mechanical entry steps and nothing doctrinal", () => {
    expect(doorway).toContain(D5_ERROR); // (a) read the policy
    expect(doorway).toContain("POST <board>/cards"); // (b) register the card
    expect(doorway).toContain("advanceCardPhase"); // (c) drive via the engine library
    // doctrine lives in the merged prompt, not here
    expect(doorway).not.toContain("5-attempt ceiling");
    expect(doorway).not.toContain("deliberate-red");
    expect(doorway).not.toContain("RUN_SPEC");
    expect(doorway).not.toContain("securityWall");
    // the doorway stays small — a doorway, not a brain
    expect(doorway.split("\n").length).toBeLessThan(120);
  });

  it("keeps the goal-loop hooks as the intra-phase mechanism", () => {
    for (const hook of ["goal-stop.sh", "goal-sessionstart.sh", "install.sh", "probe.sh"]) {
      expect(existsSync(path.join(FAMILY, "autothing/hooks", hook))).toBe(true);
    }
    expect(doorway).toContain("goal-stop.sh");
  });
});

describe("one policy, one brain — grep proofs (D5/D14, acceptance 3+7)", () => {
  it("no model: or effort: frontmatter in any family skill", () => {
    for (const dir of readdirSync(FAMILY)) {
      const skillMd = path.join(FAMILY, dir, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      const fm = readFileSync(skillMd, "utf8").split("\n---\n")[0];
      expect(fm, `${dir} frontmatter`).not.toMatch(/^model:/m);
      expect(fm, `${dir} frontmatter`).not.toMatch(/^effort:/m);
    }
  });

  it("every verb skill carries the SOFT policy-read preamble; only the doorway hard-stops (D12)", () => {
    for (const dir of readdirSync(FAMILY)) {
      if (dir === "autothing") continue; // the doorway legitimately hard-requires Garrison (see the doorway block)
      const skillMd = path.join(FAMILY, dir, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      const s = readFileSync(skillMd, "utf8");
      expect(s, `${dir} preamble`).toContain("Policy-read preamble");
      // D12: verb skills degrade gracefully when the policy is absent — they must NOT
      // carry the doorway's hard stop, and instead proceed standalone.
      expect(s, `${dir} no D5 hard-stop`).not.toContain(D5_ERROR);
      expect(s, `${dir} no 'does not run standalone'`).not.toContain("does not run standalone");
      expect(s, `${dir} soft standalone branch`).toMatch(/Policy absent[\s\S]*NEVER stop/);
    }
  });

  it("no `codex exec` or direct gemini invocation anywhere in the family", () => {
    for (const f of walk(FAMILY)) {
      const s = readFileSync(f, "utf8");
      expect(s, f).not.toContain("codex exec");
      expect(s, f).not.toMatch(/\bgemini\s+-m\b/);
    }
  });

  it("the checkpoint routes through the codex-runtime delegate bridge only", () => {
    const s = readFileSync(path.join(FAMILY, "autothing-codex-checkpoint/SKILL.md"), "utf8");
    expect(s).toContain("bridge.mjs delegate");
    expect(s.replace(/\s+/g, " ")).toContain("NEVER fall back to a direct");
    expect(s).toContain("degraded (codex-unavailable)");
  });
});

describe("codex-runtime owns serialization (D14)", () => {
  it("the bridge carries the machine-wide lock (acquire before delegate, release after)", () => {
    const bridge = readFileSync(path.join(ROOT, "fittings/seed/codex-runtime/scripts/bridge.mjs"), "utf8");
    expect(bridge).toContain("acquireCodexLock");
    expect(bridge).toContain("releaseCodexLock");
    expect(bridge).toContain('{ flag: "wx" }'); // O_EXCL
    expect(bridge.indexOf("acquireCodexLock()")).toBeLessThan(bridge.indexOf("await delegate(spec"));
    expect(bridge).toContain("finally {");
  });

  it("bridge --probe still answers", () => {
    const out = execFileSync("node", [path.join(ROOT, "fittings/seed/codex-runtime/scripts/bridge.mjs"), "--probe"], {
      encoding: "utf8"
    });
    expect(out.trim()).toBe("ok");
  });
});
