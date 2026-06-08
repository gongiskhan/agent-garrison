import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeStateModel, type PrimitiveRecord } from "@/lib/primitive-state";

let garrisonRoot: string;
let claudeRoot: string;
let priorHome: string | undefined;
let priorClaude: string | undefined;

function sha(s: string): string {
  return `sha256:${crypto.createHash("sha256").update(s).digest("hex")}`;
}
function write(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
function byId(records: PrimitiveRecord[], id: string): PrimitiveRecord | undefined {
  return records.find((r) => r.id === id);
}

beforeEach(() => {
  priorHome = process.env.GARRISON_HOME;
  priorClaude = process.env.GARRISON_CLAUDE_HOME;
  garrisonRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gar-ps-home-"));
  claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gar-ps-claude-"));
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

function seedLock(ruleHash: string): void {
  // The global composition lock: owned-skill + owned-rule.md are APM-managed.
  write(
    path.join(garrisonRoot, "global-composition", "apm.lock.yaml"),
    [
      "dependencies:",
      "- repo_url: _local/owned-skill",
      "  package_type: apm_package",
      "  deployed_files:",
      "  - .claude/skills/owned-skill",
      "- repo_url: _local/owned-rule",
      "  package_type: apm_package",
      "  deployed_files:",
      "  - .claude/rules/owned-rule.md",
      "  deployed_file_hashes:",
      `    .claude/rules/owned-rule.md: ${ruleHash}`,
      ""
    ].join("\n")
  );
}

describe("computeStateModel", () => {
  it("classifies owned vs loose across skills, rules, hooks, and mcp", async () => {
    const ruleBody = "owned rule body\n";
    seedLock(sha(ruleBody));

    // owned (in lock) + loose (not in lock)
    write(path.join(claudeRoot, "skills", "owned-skill", "SKILL.md"), "---\nname: owned-skill\n---\n");
    write(path.join(claudeRoot, "skills", "loose-skill", "SKILL.md"), "---\nname: loose-skill\n---\n");
    write(path.join(claudeRoot, "rules", "owned-rule.md"), ruleBody);
    write(path.join(claudeRoot, "rules", "loose-rule.md"), "hand authored\n");
    // hooks: one Garrison-owned, one hand-authored
    write(
      path.join(claudeRoot, "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { _garrison: "fitting:session-view", matcher: "*", hooks: [] },
            { hooks: [] }
          ]
        }
      })
    );
    write(path.join(claudeRoot, "mcp.json"), JSON.stringify({ mcpServers: { context7: { url: "x" } } }));

    const model = await computeStateModel();
    const r = model.records;

    expect(byId(r, "skill:owned-skill")?.state).toBe("owned");
    expect(byId(r, "skill:owned-skill")?.fittingId).toBe("owned-skill");
    expect(byId(r, "skill:loose-skill")?.state).toBe("loose");

    expect(byId(r, "rule:owned-rule")?.state).toBe("owned");
    expect(byId(r, "rule:owned-rule")?.driftedFromLock).toBe(false); // bytes match the lock hash
    expect(byId(r, "rule:loose-rule")?.state).toBe("loose");

    expect(byId(r, "hook:SessionStart#0")?.state).toBe("owned");
    expect(byId(r, "hook:SessionStart#0")?.fittingId).toBe("fitting:session-view");
    expect(byId(r, "hook:SessionStart#1")?.state).toBe("loose");

    expect(byId(r, "mcp:context7")?.state).toBe("loose"); // no APM ownership model yet

    // No parked records leak into the Quarters model (D10).
    expect(model.counts.parked).toBe(0);
    expect(model.bySurface.skill.map((x) => x.id).sort()).toEqual(["skill:loose-skill", "skill:owned-skill"]);
  });

  it("flags an owned file as drifted when its on-disk bytes diverge from the lock hash", async () => {
    seedLock(sha("the original locked body\n"));
    // On disk the rule has DIFFERENT content than the lock recorded.
    write(path.join(claudeRoot, "rules", "owned-rule.md"), "edited after install\n");

    const model = await computeStateModel();
    const rec = byId(model.records, "rule:owned-rule");
    expect(rec?.state).toBe("owned");
    expect(rec?.driftedFromLock).toBe(true);
  });

  it("treats everything as loose when no global lock exists yet", async () => {
    write(path.join(claudeRoot, "skills", "solo", "SKILL.md"), "---\nname: solo\n---\n");
    const model = await computeStateModel();
    expect(model.counts.owned).toBe(0);
    expect(byId(model.records, "skill:solo")?.state).toBe("loose");
  });
});
