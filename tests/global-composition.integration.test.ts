import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claudeHome } from "@/lib/claude-home";
import { writeGlobalApmManifest, apmInstall } from "@/lib/global-composition";

// Real-APM integration: tagged OUT of the default per-slice gate (like
// orchestrator-integration.test.ts). Run with GARRISON_INTEGRATION=1.
// Proves the symlink-confined global composition deploys a real seed skill into
// a SANDBOX ~/.claude via the actual `apm` binary.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN = process.env.GARRISON_INTEGRATION === "1";

let garrisonRoot: string;
let claudeRoot: string;
let priorHome: string | undefined;
let priorClaude: string | undefined;

beforeAll(() => {
  priorHome = process.env.GARRISON_HOME;
  priorClaude = process.env.GARRISON_CLAUDE_HOME;
  garrisonRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gar-gc-int-home-"));
  claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gar-gc-int-claude-"));
  process.env.GARRISON_HOME = garrisonRoot;
  process.env.GARRISON_CLAUDE_HOME = claudeRoot;
});

afterAll(() => {
  if (priorHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = priorHome;
  if (priorClaude === undefined) delete process.env.GARRISON_CLAUDE_HOME;
  else process.env.GARRISON_CLAUDE_HOME = priorClaude;
  fs.rmSync(garrisonRoot, { recursive: true, force: true });
  fs.rmSync(claudeRoot, { recursive: true, force: true });
});

describe.skipIf(!RUN)("global-composition (real apm)", () => {
  it(
    "deploys a seed skill through the symlink AND preserves a pre-existing loose primitive",
    async () => {
      const seed = path.resolve(REPO_ROOT, "fittings/seed/documents");
      expect(fs.existsSync(seed)).toBe(true);

      // The load-bearing property the whole architecture rests on: a hand-authored
      // primitive that is NOT a dep must survive `apm install --force` untouched.
      const loose = path.join(claudeHome(), "skills", "hand-authored", "SKILL.md");
      fs.mkdirSync(path.dirname(loose), { recursive: true });
      fs.writeFileSync(loose, "---\nname: hand-authored\n---\nloose-sentinel-9281\n");

      await writeGlobalApmManifest([{ absPath: seed }]);
      const lock = await apmInstall(); // real defaultApmRunner

      // (a) the dep deployed THROUGH the symlink into the sandbox ~/.claude...
      expect([...lock.allDeployedFiles].some((f) => f.startsWith("skills/"))).toBe(true);
      expect(fs.existsSync(path.join(claudeHome(), "skills"))).toBe(true);
      // ...and the lock claims ONLY the dep, never the loose primitive.
      expect([...lock.allDeployedFiles].some((f) => f.includes("hand-authored"))).toBe(false);

      // (b) the loose primitive is still on disk, byte-intact.
      expect(fs.existsSync(loose)).toBe(true);
      expect(fs.readFileSync(loose, "utf8")).toContain("loose-sentinel-9281");
    },
    180000
  );
});
