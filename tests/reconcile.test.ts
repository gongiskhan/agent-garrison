import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "@/lib/reconcile";
import { capturedFittingsDir, provenanceLedgerPath } from "@/lib/claude-home";

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

beforeEach(() => {
  priorHome = process.env.GARRISON_HOME;
  priorClaude = process.env.GARRISON_CLAUDE_HOME;
  garrisonRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gar-rc-home-"));
  claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gar-rc-claude-"));
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

function seedLoosePrimitives(): void {
  write(path.join(claudeRoot, "skills", "foo", "SKILL.md"), "---\nname: foo\n---\n# Foo\n");
  write(path.join(claudeRoot, "skills", "bar", "SKILL.md"), "---\nname: bar\n---\n# Bar\n");
  write(path.join(claudeRoot, "commands", "cmd.md"), "do a thing\n");
  write(path.join(claudeRoot, "rules", "r.md"), "a rule\n");
  write(
    path.join(claudeRoot, "settings.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [] }] } }) // hand-authored (loose)
  );
  write(path.join(claudeRoot, "mcp.json"), JSON.stringify({ mcpServers: { ctx: { url: "x" } } }));
}

describe("reconcile", () => {
  it("captures loose skills/commands/rules as APM fittings; ADOPTS hooks/mcp as enabled (HV7)", async () => {
    seedLoosePrimitives();
    const report = await reconcile({ trigger: "bootstrap" });

    expect(report.imported.sort()).toEqual(["command:cmd", "rule:r", "skill:bar", "skill:foo"]);
    // HV7: present hook/mcp are presence-managed → adopted as enabled (not deferred),
    // and nothing is parked.
    expect(report.adopted).toContain("hook:Stop#0");
    expect(report.adopted).toContain("mcp:ctx");
    expect(report.deferred.hook).toBe(0);
    expect(report.deferred.mcp).toBe(0);

    const store = capturedFittingsDir();
    // skill -> .apm/skills/<name>/SKILL.md
    expect(fs.existsSync(path.join(store, "foo", "apm.yml"))).toBe(true);
    expect(fs.existsSync(path.join(store, "foo", ".apm", "skills", "foo", "SKILL.md"))).toBe(true);
    // command -> .apm/prompts/<name>.prompt.md
    expect(fs.existsSync(path.join(store, "cmd", ".apm", "prompts", "cmd.prompt.md"))).toBe(true);
    // rule -> .apm/instructions/<name>.instructions.md
    expect(fs.existsSync(path.join(store, "r", ".apm", "instructions", "r.instructions.md"))).toBe(true);

    // The emitted apm.yml is a minimal package (no x-garrison wiring needed for the control plane).
    const fooManifest = fs.readFileSync(path.join(store, "foo", "apm.yml"), "utf8");
    expect(fooManifest).toContain("type: skill");
    expect(fooManifest).toContain("includes: auto");
  });

  it("skips already-captured primitives on a second run", async () => {
    seedLoosePrimitives();
    await reconcile({ trigger: "bootstrap" });
    const second = await reconcile({ trigger: "on-demand" });
    expect(second.imported).toEqual([]);
    expect(second.skipped.sort()).toEqual(["command:cmd", "rule:r", "skill:bar", "skill:foo"]);
  });

  it("suppresses echoes — a primitive whose hash matches the ledger is not re-captured", async () => {
    write(path.join(claudeRoot, "skills", "foo", "SKILL.md"), "---\nname: foo\n---\n# Foo\n");
    // Pre-seed the ledger with foo's current hash (simulating a recent Garrison write).
    write(
      provenanceLedgerPath(),
      JSON.stringify({ "skill:foo": { surface: "skill", lastWrittenHash: sha("---\nname: foo\n---\n# Foo\n") } })
    );

    const report = await reconcile({ trigger: "post-authoring" });
    expect(report.suppressedEchoes).toEqual(["skill:foo"]);
    expect(report.imported).toEqual([]);
    expect(fs.existsSync(path.join(capturedFittingsDir(), "foo"))).toBe(false);

    // Change the content -> no longer an echo -> captured.
    write(path.join(claudeRoot, "skills", "foo", "SKILL.md"), "---\nname: foo\n---\n# Foo EDITED\n");
    const report2 = await reconcile({ trigger: "post-authoring" });
    expect(report2.imported).toEqual(["skill:foo"]);
  });
});
