import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHandHook, updateHandHook, deleteHandHook } from "@/lib/hooks-crud";
import { computeStateModel } from "@/lib/primitive-state";
import { runQuartersAction, type CrudResult } from "@/lib/quarters";

let claudeRoot: string;
let priorClaude: string | undefined;
let priorHome: string | undefined;
let garrisonRoot: string;

function settingsPath(): string {
  return path.join(claudeRoot, "settings.json");
}
function readSettings(): { hooks?: Record<string, unknown[]> } {
  return JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
}
function writeSettings(obj: unknown): void {
  fs.writeFileSync(settingsPath(), JSON.stringify(obj, null, 2));
}

beforeEach(() => {
  priorClaude = process.env.GARRISON_CLAUDE_HOME;
  priorHome = process.env.GARRISON_HOME;
  claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gar-hooks-claude-"));
  garrisonRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gar-hooks-home-"));
  process.env.GARRISON_CLAUDE_HOME = claudeRoot;
  process.env.GARRISON_HOME = garrisonRoot;
});
afterEach(() => {
  if (priorClaude === undefined) delete process.env.GARRISON_CLAUDE_HOME;
  else process.env.GARRISON_CLAUDE_HOME = priorClaude;
  if (priorHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = priorHome;
  fs.rmSync(claudeRoot, { recursive: true, force: true });
  fs.rmSync(garrisonRoot, { recursive: true, force: true });
});

describe("hooks-crud (hand-authored, untagged)", () => {
  it("creates an UNTAGGED hook group (no _garrison) and the state model sees it as loose", async () => {
    const r = await createHandHook({ event: "PreToolUse", matcher: "Bash", command: "echo hi" });
    expect(r.ok).toBe(true);
    expect(r.id).toBe("hook:PreToolUse#0");

    const group = readSettings().hooks!.PreToolUse[0] as Record<string, unknown>;
    expect(group._garrison).toBeUndefined(); // CRITICAL: hand-authored stays untagged
    expect(group.matcher).toBe("Bash");
    expect((group.hooks as { command: string }[])[0].command).toBe("echo hi");

    const model = await computeStateModel();
    const rec = model.records.find((x) => x.id === "hook:PreToolUse#0");
    expect(rec?.state).toBe("loose");
  });

  it("edits a hand-authored group's command + matcher", async () => {
    await createHandHook({ event: "Stop", command: "a" });
    const r = await updateHandHook("Stop", 0, { event: "Stop", matcher: "*", command: "b" });
    expect(r.ok).toBe(true);
    const group = readSettings().hooks!.Stop[0] as Record<string, unknown>;
    expect((group.hooks as { command: string }[])[0].command).toBe("b");
    expect(group.matcher).toBe("*");
  });

  it("deletes a hand-authored group and prunes the empty event", async () => {
    await createHandHook({ event: "SessionStart", command: "x" });
    const r = await deleteHandHook("SessionStart", 0);
    expect(r.ok).toBe(true);
    expect(readSettings().hooks?.SessionStart).toBeUndefined();
  });

  it("REFUSES to edit or delete a fitting-owned (_garrison-tagged) group", async () => {
    writeSettings({
      hooks: {
        SessionStart: [
          { _garrison: "fitting:session-view", hooks: [{ type: "command", command: "owned-cmd" }] }
        ]
      }
    });
    const upd = await updateHandHook("SessionStart", 0, { event: "SessionStart", command: "hijack" });
    expect(upd.ok).toBe(false);
    expect(upd.code).toBe("owned");
    const del = await deleteHandHook("SessionStart", 0);
    expect(del.ok).toBe(false);
    expect(del.code).toBe("owned");
    // untouched
    const group = readSettings().hooks!.SessionStart[0] as Record<string, unknown>;
    expect((group.hooks as { command: string }[])[0].command).toBe("owned-cmd");
  });

  it("a hand-authored hook coexists beside a fitting-owned group on the same event", async () => {
    writeSettings({
      hooks: { SessionStart: [{ _garrison: "fitting:x", hooks: [{ type: "command", command: "owned" }] }] }
    });
    await createHandHook({ event: "SessionStart", command: "mine" });
    const groups = readSettings().hooks!.SessionStart as Record<string, unknown>[];
    expect(groups).toHaveLength(2);
    expect(groups[0]._garrison).toBe("fitting:x"); // owner preserved
    expect(groups[1]._garrison).toBeUndefined(); // mine stays untagged

    const model = await computeStateModel();
    expect(model.records.find((r) => r.id === "hook:SessionStart#0")?.state).toBe("owned");
    expect(model.records.find((r) => r.id === "hook:SessionStart#1")?.state).toBe("loose");
  });

  it("dispatch round-trip create → update → delete via runQuartersAction", async () => {
    const c = (await runQuartersAction({ action: "hook.create", event: "PreCompact", command: "c1" })) as CrudResult;
    expect(c.ok).toBe(true);
    const u = (await runQuartersAction({ action: "hook.update", event: "PreCompact", index: 0, command: "c2" })) as CrudResult;
    expect(u.ok).toBe(true);
    const d = (await runQuartersAction({ action: "hook.delete", event: "PreCompact", index: 0 })) as CrudResult;
    expect(d.ok).toBe(true);
    expect(readSettings().hooks?.PreCompact).toBeUndefined();
  });

  it("validates event + command", async () => {
    expect((await createHandHook({ event: "", command: "x" })).code).toBe("invalid");
    expect((await createHandHook({ event: "Bad Event", command: "x" })).code).toBe("invalid");
    expect((await createHandHook({ event: "Stop", command: "  " })).code).toBe("invalid");
  });
});
