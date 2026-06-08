import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promote, park } from "@/lib/state-transitions";
import { computeStateModel } from "@/lib/primitive-state";
import { claudeHome, parkedStoreDir } from "@/lib/claude-home";

// Real-APM round-trip for the EA4 transitions, tagged OUT of the default gate.
// Guards the engine keystone against reality: APM leaves orphans on dep removal,
// and Garrison cleans them on park. Run with GARRISON_INTEGRATION=1.

const RUN = process.env.GARRISON_INTEGRATION === "1";

let garrisonRoot: string;
let claudeRoot: string;
let priorHome: string | undefined;
let priorClaude: string | undefined;

beforeEach(() => {
  priorHome = process.env.GARRISON_HOME;
  priorClaude = process.env.GARRISON_CLAUDE_HOME;
  garrisonRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gar-tx-int-home-"));
  claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gar-tx-int-claude-"));
  process.env.GARRISON_HOME = garrisonRoot;
  process.env.GARRISON_CLAUDE_HOME = claudeRoot;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = priorHome;
  if (priorClaude === undefined) delete process.env.GARRISON_CLAUDE_HOME;
  else process.env.GARRISON_CLAUDE_HOME = priorClaude;
  fs.rmSync(garrisonRoot, { recursive: true, force: true });
  fs.rmSync(claudeRoot, { recursive: true, force: true });
});

describe.skipIf(!RUN)("state transitions (real apm)", () => {
  it(
    "promote then park: real apm install owns it, park cleans the real orphan",
    async () => {
      // A loose, hand-authored skill on disk.
      const skillMd = path.join(claudeRoot, "skills", "promote-me", "SKILL.md");
      fs.mkdirSync(path.dirname(skillMd), { recursive: true });
      fs.writeFileSync(skillMd, "---\nname: promote-me\ndescription: x\n---\n# Promote Me\n");

      const up = await promote("skill:promote-me", {});
      expect(up.ok).toBe(true);
      let model = await computeStateModel();
      expect(model.records.find((r) => r.id === "skill:promote-me")?.state).toBe("owned");

      const down = await park("promote-me", {});
      expect(down.ok).toBe(true);
      // The real orphan APM left is cleaned by Garrison...
      expect(fs.existsSync(path.join(claudeHome(), "skills", "promote-me"))).toBe(false);
      // ...and a parked copy is kept.
      expect(fs.existsSync(path.join(parkedStoreDir(), "promote-me"))).toBe(true);
      model = await computeStateModel();
      expect(model.records.find((r) => r.id === "skill:promote-me")).toBeUndefined();
    },
    180000
  );
});
