import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildOrchestratorInstructions,
  projectOrchestrator,
  orchestratorAppendSystemPrompt,
  ORCHESTRATOR_PRIMITIVE_ID,
  ORCHESTRATOR_RULE_REL
} from "@/lib/orchestrator-projection";
import { computeStateModel } from "@/lib/primitive-state";
import { claudeHome, provenanceLedgerPath } from "@/lib/claude-home";
import type { ApmRunner } from "@/lib/apm-exec";
import type { GarrisonMetadata, LibraryEntry } from "@/lib/types";

let garrisonRoot: string;
let claudeRoot: string;
let priorHome: string | undefined;
let priorClaude: string | undefined;

// Stub apm modelling the verified real behavior: deploy each CURRENT dep's .apm
// content through the .claude symlink. instructions/<x>.instructions.md ->
// rules/<x>.md; skills/<x>/ -> skills/<x>/. Writes apm.lock.yaml listing only
// current deps with deployed_files + deployed_file_hashes.
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
      const deployedHashes: Record<string, string> = {};

      const apmInstr = path.join(depPath, ".apm", "instructions");
      if (fs.existsSync(apmInstr)) {
        for (const file of fs.readdirSync(apmInstr)) {
          const ruleName = file.replace(/\.instructions\.md$/, "");
          const target = path.join(cwd, ".claude", "rules", `${ruleName}.md`);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const content = fs.readFileSync(path.join(apmInstr, file));
          fs.writeFileSync(target, content);
          const rel = `.claude/rules/${ruleName}.md`;
          deployedFiles.push(rel);
          deployedHashes[rel] = `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
        }
      }

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
        deployed_files: deployedFiles,
        deployed_file_hashes: deployedHashes
      });
    }
    fs.writeFileSync(path.join(cwd, "apm.lock.yaml"), yaml.dump({ dependencies: lockDeps }));
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
}

const stub = makeStubApm();

function providerEntry(id: string, kind: GarrisonMetadata["provides"][number]["kind"], name: string, summary: string): LibraryEntry {
  const metadata: GarrisonMetadata = {
    faculty: "channels",
    cardinality_hint: "multi",
    component_shape: "script",
    platforms: ["claude-code"],
    summary,
    config_schema: [],
    provides: [{ kind, name }],
    consumes: [],
    verify: { command: "echo ok", expect: "ok", timeout_ms: 10000 }
  };
  return { id, name: id, faculty: "channels", repo: `local:fittings/seed/${id}`, summary, platforms: ["claude-code"], ratings: {}, metadata };
}

beforeEach(() => {
  priorHome = process.env.GARRISON_HOME;
  priorClaude = process.env.GARRISON_CLAUDE_HOME;
  garrisonRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gar-orch-home-"));
  claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gar-orch-claude-"));
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

describe("buildOrchestratorInstructions (pure fold + capabilities substitution)", () => {
  it("leads with identity, then behavior, and substitutes {{capabilities}}", () => {
    const out = buildOrchestratorInstructions({
      soul: "You are the soul.",
      orchestrator: "## Behavior\n\nTools available:\n{{capabilities}}",
      entries: [providerEntry("slack-channel", "channel", "slack", "Slack inbound/outbound")]
    });
    expect(out.startsWith("You are the soul.")).toBe(true);
    expect(out.indexOf("You are the soul.")).toBeLessThan(out.indexOf("## Behavior"));
    expect(out).toContain("- channel:slack — Slack inbound/outbound");
    expect(out).not.toContain("{{capabilities}}");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("renders the empty-capabilities placeholder when no providers are present", () => {
    const out = buildOrchestratorInstructions({ orchestrator: "Tools:\n{{capabilities}}", entries: [] });
    expect(out).toContain("no Faculties currently installed");
  });

  it("omits the identity block when no soul is given", () => {
    const out = buildOrchestratorInstructions({ orchestrator: "Just behavior.", entries: [] });
    expect(out).toBe("Just behavior.\n");
  });
});

describe("projectOrchestrator (APM-managed instructions primitive)", () => {
  it("deploys the prompt to ~/.claude/rules/<id>.md and flips it to owned", async () => {
    const instructions = "You are the soul.\n\n## Behavior\n\nDo the thing.\n";
    const r = await projectOrchestrator({ instructions, runApm: stub });

    expect(r.ok).toBe(true);
    expect(r.rulePath).toBe(ORCHESTRATOR_RULE_REL);
    expect(r.deployed).toContain(ORCHESTRATOR_RULE_REL);

    // the rule landed on disk through the symlink with the exact instructions
    const ruleAbs = path.join(claudeHome(), ORCHESTRATOR_RULE_REL);
    expect(fs.existsSync(ruleAbs)).toBe(true);
    expect(fs.readFileSync(ruleAbs, "utf8")).toBe(instructions);

    // the classifier sees it as OWNED (in the lock), owned by our fitting
    const model = await computeStateModel();
    const rec = model.records.find((x) => x.id === `rule:${ORCHESTRATOR_PRIMITIVE_ID}`);
    expect(rec?.state).toBe("owned");
    expect(rec?.fittingId).toBe(ORCHESTRATOR_PRIMITIVE_ID);

    // provenance snapshot pre-suppresses the watcher echo
    const ledger = JSON.parse(fs.readFileSync(provenanceLedgerPath(), "utf8"));
    expect(ledger[`rule:${ORCHESTRATOR_PRIMITIVE_ID}`].lastWrittenHash).toMatch(/^sha256:/);
  });

  it("re-projection updates in place (no duplicate dep, content refreshed)", async () => {
    await projectOrchestrator({ instructions: "v1\n", runApm: stub });
    await projectOrchestrator({ instructions: "v2 updated\n", runApm: stub });

    const ruleAbs = path.join(claudeHome(), ORCHESTRATOR_RULE_REL);
    expect(fs.readFileSync(ruleAbs, "utf8")).toBe("v2 updated\n");

    const model = await computeStateModel();
    const owned = model.records.filter((x) => x.id === `rule:${ORCHESTRATOR_PRIMITIVE_ID}`);
    expect(owned).toHaveLength(1);
    expect(owned[0].state).toBe("owned");
  });
});

describe("orchestratorAppendSystemPrompt (launch-time fallback)", () => {
  it("returns the instructions verbatim for --append-system-prompt", () => {
    const text = "You are the soul.\n\nBehavior.\n";
    expect(orchestratorAppendSystemPrompt(text)).toBe(text);
  });
});
