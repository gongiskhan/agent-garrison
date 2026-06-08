import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promote, park, unpark } from "@/lib/state-transitions";
import { computeStateModel } from "@/lib/primitive-state";
import {
  claudeHome,
  capturedFittingsDir,
  parkedStoreDir,
  provenanceLedgerPath
} from "@/lib/claude-home";
import type { ApmRunner } from "@/lib/apm-exec";

let garrisonRoot: string;
let claudeRoot: string;
let priorHome: string | undefined;
let priorClaude: string | undefined;

function write(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// A stub apm that models the verified real behavior: deploy each CURRENT dep's
// .apm content through the .claude symlink, write apm.lock.yaml listing ONLY
// current deps, and LEAVE files for removed deps on disk (orphans).
function makeStubApm(): ApmRunner {
  return async (_args, cwd) => {
    const manifest = yaml.load(fs.readFileSync(path.join(cwd, "apm.yml"), "utf8")) as {
      dependencies?: { apm?: Array<string | { path: string }> };
    };
    const deps = manifest?.dependencies?.apm ?? [];
    const lockDeps: unknown[] = [];
    for (const dep of deps) {
      const depPath = typeof dep === "string" ? dep : dep.path;
      const name = path.basename(depPath);
      const deployedFiles: string[] = [];
      const apmSkills = path.join(depPath, ".apm", "skills");
      if (fs.existsSync(apmSkills)) {
        for (const skillName of fs.readdirSync(apmSkills)) {
          const target = path.join(cwd, ".claude", "skills", skillName);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.cpSync(path.join(apmSkills, skillName), target, { recursive: true });
          deployedFiles.push(`.claude/skills/${skillName}`);
        }
      }
      lockDeps.push({
        repo_url: `_local/${name}`,
        package_type: "apm_package",
        local_path: depPath,
        deployed_files: deployedFiles
      });
    }
    fs.writeFileSync(path.join(cwd, "apm.lock.yaml"), yaml.dump({ dependencies: lockDeps }));
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
}

const stub = makeStubApm();

async function seedAndPromoteFoo(): Promise<void> {
  write(path.join(claudeRoot, "skills", "foo", "SKILL.md"), "---\nname: foo\n---\n# Foo\n");
  await promote("skill:foo", { runApm: stub });
}

beforeEach(() => {
  priorHome = process.env.GARRISON_HOME;
  priorClaude = process.env.GARRISON_CLAUDE_HOME;
  garrisonRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gar-tx-home-"));
  claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gar-tx-claude-"));
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

describe("promote (loose -> owned)", () => {
  it("packages the loose primitive, installs it, and flips it to owned", async () => {
    await seedAndPromoteFoo();

    const model = await computeStateModel();
    expect(model.records.find((r) => r.id === "skill:foo")?.state).toBe("owned");
    expect(fs.existsSync(path.join(capturedFittingsDir(), "foo", "apm.yml"))).toBe(true);

    // Ledger snapshot pre-suppresses the watcher echo.
    const ledger = JSON.parse(fs.readFileSync(provenanceLedgerPath(), "utf8"));
    expect(ledger["skill:foo"].lastWrittenHash).toMatch(/^sha256:/);
  });

  it("returns ok 'already' without error when the primitive is already owned", async () => {
    await seedAndPromoteFoo();
    const again = await promote("skill:foo", { runApm: stub });
    expect(again.ok).toBe(true);
    expect(again.fittingId).toBe("foo");
  });

  it("returns not-found for an unknown primitive", async () => {
    const r = await promote("skill:does-not-exist", { runApm: stub });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("not-found");
  });
});

describe("park (owned -> parked)", () => {
  it("drops the dep, cleans the orphan APM left, and saves a parked copy", async () => {
    await seedAndPromoteFoo();
    const r = await park("foo", { runApm: stub });

    expect(r.ok).toBe(true);
    expect(r.cleanedOrphans).toEqual(["skills/foo"]);
    // The orphan APM left on disk is gone...
    expect(fs.existsSync(path.join(claudeHome(), "skills", "foo"))).toBe(false);
    // ...a parked copy exists...
    expect(fs.existsSync(path.join(parkedStoreDir(), "foo", "apm.yml"))).toBe(true);
    // ...and the classifier no longer sees it.
    const model = await computeStateModel();
    expect(model.records.find((x) => x.id === "skill:foo")).toBeUndefined();
  });

  it("does not over-delete a still-owned sibling", async () => {
    await seedAndPromoteFoo();
    write(path.join(claudeHome(), "skills", "bar", "SKILL.md"), "---\nname: bar\n---\n# Bar\n");
    await promote("skill:bar", { runApm: stub });

    await park("foo", { runApm: stub });
    // bar remains owned and on disk.
    expect(fs.existsSync(path.join(claudeHome(), "skills", "bar"))).toBe(true);
    const model = await computeStateModel();
    expect(model.records.find((x) => x.id === "skill:bar")?.state).toBe("owned");
  });
});

describe("unpark (parked -> owned | loose)", () => {
  it("restores to owned", async () => {
    await seedAndPromoteFoo();
    await park("foo", { runApm: stub });

    const r = await unpark("foo", "owned", { runApm: stub });
    expect(r.ok).toBe(true);
    expect(r.deployed).toContain("skills/foo");
    expect(fs.existsSync(path.join(parkedStoreDir(), "foo"))).toBe(false);
    const model = await computeStateModel();
    expect(model.records.find((x) => x.id === "skill:foo")?.state).toBe("owned");
  });

  it("restores to loose (on disk, not added back to apm.yml)", async () => {
    await seedAndPromoteFoo();
    await park("foo", { runApm: stub });

    const r = await unpark("foo", "loose", { runApm: stub });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(claudeHome(), "skills", "foo", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(parkedStoreDir(), "foo"))).toBe(false);
    const model = await computeStateModel();
    expect(model.records.find((x) => x.id === "skill:foo")?.state).toBe("loose");
  });
});
