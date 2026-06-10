import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runImport } from "../scripts/import-claude-install";
import { readUntaggedHookGroups } from "@/lib/reconcile";
import { resolveArtifacts } from "@/lib/claude-install-source";
import { installFitting, readInstallLock } from "@/lib/claude-install";
import { readSettingsRaw } from "@/lib/claude-settings-file";
import { validateFitting } from "@/lib/validation";

let srcHome: string; // the ~/.claude we import FROM
let outDir: string; // where emitted fittings land
let targetHome: string; // a fresh ~/.claude we install INTO
let lockPath: string;

beforeEach(async () => {
  srcHome = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-hookimport-src-"));
  outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-hookimport-out-"));
  targetHome = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-hookimport-tgt-"));
  lockPath = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-hookimport-lock-")), "lock.json");

  fs.writeFileSync(
    path.join(srcHome, "settings.json"),
    JSON.stringify(
      {
        hooks: {
          SessionStart: [
            { matcher: "", hooks: [{ type: "command", command: "echo session-start" }] }
          ],
          PreToolUse: [
            // already Garrison-owned -> must NOT be captured
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "echo owned", timeout: 5 }],
              _garrison: "fitting:someone-else"
            }
          ]
        }
      },
      null,
      2
    )
  );
});

afterEach(async () => {
  for (const d of [srcHome, outDir, targetHome, path.dirname(lockPath)]) {
    await fsp.rm(d, { recursive: true, force: true });
  }
});

describe("S5 hook-fitting emission (Q3)", () => {
  it("reads only the untagged hook groups (skips Garrison-owned ones)", async () => {
    const groups = await readUntaggedHookGroups(srcHome);
    expect(groups).toHaveLength(1);
    expect(groups[0].event).toBe("SessionStart");
    expect(groups[0].hooks[0].command).toBe("echo session-start");
  });

  it("emits an installable component_shape: hook fitting per event", async () => {
    const report = await runImport({
      claudeHome: srcHome,
      outDir,
      write: true,
      adopt: false,
      prefix: ""
    });
    expect(report.untaggedHookGroups).toBe(1);
    expect(report.created).toContain("imported-hook-sessionstart");

    const manifest = yaml.load(
      await fsp.readFile(path.join(outDir, "imported-hook-sessionstart", "apm.yml"), "utf8")
    ) as { "x-garrison": { component_shape: string; hook_groups: { event: string; hooks: unknown[] }[] } };
    expect(manifest["x-garrison"].component_shape).toBe("hook");
    expect(manifest["x-garrison"].hook_groups[0].event).toBe("SessionStart");
  });

  it("the emitted hook fitting passes validate-fitting (four-check pipeline)", async () => {
    await runImport({ claudeHome: srcHome, outDir, write: true, adopt: false, prefix: "" });
    const report = await validateFitting(path.join(outDir, "imported-hook-sessionstart"));
    expect(report.overall, JSON.stringify(report.checks, null, 2)).toBe("pass");
  });

  it("resolveArtifacts turns the manifest into a hook-group artifact", async () => {
    await runImport({ claudeHome: srcHome, outDir, write: true, adopt: false, prefix: "" });
    const m = await resolveArtifacts("imported-hook-sessionstart", { seedDir: outDir });
    expect(m.artifacts).toHaveLength(1);
    expect(m.artifacts[0].kind).toBe("hook-group");
    expect(m.artifacts[0].hookGroups?.[0].event).toBe("SessionStart");
    expect(m.artifacts[0].hookGroups?.[0].hooks[0].command).toBe("echo session-start");
  });

  it("installing the resolved hook fitting writes an owner-scoped settings.json group", async () => {
    await runImport({ claudeHome: srcHome, outDir, write: true, adopt: false, prefix: "" });
    const m = await resolveArtifacts("imported-hook-sessionstart", { seedDir: outDir });

    const result = await installFitting(m, { claudeHome: targetHome, lockPath });
    expect(result.ok).toBe(true);

    const { json } = await readSettingsRaw(targetHome);
    const groups = (json as { hooks?: Record<string, unknown[]> }).hooks?.SessionStart ?? [];
    expect(groups).toHaveLength(1);
    const g = groups[0] as { _garrison?: string; hooks: { command: string }[] };
    expect(g._garrison).toBe("fitting:imported-hook-sessionstart");
    expect(g.hooks[0].command).toBe("echo session-start");

    // lock records the hook-group artifact with owner + events
    const lock = await readInstallLock({ claudeHome: targetHome, lockPath });
    const inst = lock.installs["imported-hook-sessionstart"];
    const hookArtifact = inst.artifacts.find((a) => a.kind === "hook-group");
    expect(hookArtifact?.owner).toBe("fitting:imported-hook-sessionstart");
    expect(hookArtifact?.events).toContain("SessionStart");
  });
});
