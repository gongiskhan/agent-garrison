import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installFitting,
  adoptFitting,
  uninstallFitting,
  listInstalledFittings,
  detectDrift,
  readInstallLock,
  type InstallManifest,
  type InstallOpts
} from "@/lib/claude-install";
import { resolveArtifacts } from "@/lib/claude-install-source";

let claudeHome: string;
let src: string;
let lockPath: string;
let opts: InstallOpts;

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gar-install-"));
  claudeHome = path.join(base, "claude");
  src = path.join(base, "src");
  lockPath = path.join(base, "lock.json");
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.mkdirSync(src, { recursive: true });
  opts = { claudeHome, lockPath, now: "2026-06-07T00:00:00Z" };
});
afterEach(() => {
  fs.rmSync(path.dirname(claudeHome), { recursive: true, force: true });
});

// Build a source skill dir on disk and return a manifest pointing at it.
function skillManifest(fittingId: string, skillName: string, body: string): InstallManifest {
  const dir = path.join(src, fittingId, skillName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body);
  fs.writeFileSync(path.join(dir, "scripts.sh"), "echo hi\n"); // nested file too
  return {
    fittingId,
    source: `test/${fittingId}`,
    artifacts: [{ target: `skills/${skillName}`, kind: "skill-dir", sourcePath: dir }]
  };
}

const read = (rel: string) => fs.readFileSync(path.join(claudeHome, rel), "utf8");
const onDisk = (rel: string) => fs.existsSync(path.join(claudeHome, rel));

describe("claude-install backend", () => {
  it("installs a skill green-field and records sha256 per file", async () => {
    const r = await installFitting(skillManifest("foo", "alpha", "# Alpha"), opts);
    expect(r.ok).toBe(true);
    expect(onDisk("skills/alpha/SKILL.md")).toBe(true);
    expect(read("skills/alpha/SKILL.md")).toBe("# Alpha");

    const lock = await readInstallLock(opts);
    const files = lock.installs.foo.artifacts[0].files;
    expect(Object.keys(files).sort()).toEqual(["skills/alpha/SKILL.md", "skills/alpha/scripts.sh"]);
    expect(files["skills/alpha/SKILL.md"]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("uninstall removes exactly what was installed and drops the lock record", async () => {
    await installFitting(skillManifest("foo", "alpha", "# Alpha"), opts);
    const u = await uninstallFitting("foo", opts);
    expect(u.ok).toBe(true);
    expect(u.removed).toContain("skills/alpha/SKILL.md");
    expect(onDisk("skills/alpha")).toBe(false); // empty dir cleaned
    expect((await readInstallLock(opts)).installs.foo).toBeUndefined();
  });

  it("REFUSES to clobber a hand-authored (unowned) target and writes nothing", async () => {
    // a pre-existing, hand-authored skill of the same name
    fs.mkdirSync(path.join(claudeHome, "skills", "alpha"), { recursive: true });
    fs.writeFileSync(path.join(claudeHome, "skills", "alpha", "SKILL.md"), "HAND AUTHORED");

    const r = await installFitting(skillManifest("foo", "alpha", "# Alpha"), opts);
    expect(r).toMatchObject({ ok: false, code: "unowned-collision", target: "skills/alpha" });
    // untouched
    expect(read("skills/alpha/SKILL.md")).toBe("HAND AUTHORED");
    expect((await readInstallLock(opts)).installs.foo).toBeUndefined();
  });

  it("ADOPTS a pre-existing on-disk skill (brown-field) then manages/uninstalls it", async () => {
    fs.mkdirSync(path.join(claudeHome, "skills", "garrison-browser"), { recursive: true });
    fs.writeFileSync(path.join(claudeHome, "skills", "garrison-browser", "SKILL.md"), "EXISTING");
    const manifest: InstallManifest = {
      fittingId: "browser-default",
      source: "test",
      artifacts: [{ target: "skills/garrison-browser", kind: "skill-dir" }]
    };
    const a = await adoptFitting(manifest, opts);
    expect(a.ok).toBe(true);
    expect(read("skills/garrison-browser/SKILL.md")).toBe("EXISTING"); // bytes unchanged

    const lock = await readInstallLock(opts);
    expect(lock.installs["browser-default"].adopted).toBe(true);

    const u = await uninstallFitting("browser-default", opts);
    expect(u.ok).toBe(true);
    expect(onDisk("skills/garrison-browser")).toBe(false);
  });

  it("leaves a user-edited installed file in place on uninstall (drift-skip)", async () => {
    await installFitting(skillManifest("foo", "alpha", "# Alpha"), opts);
    // user edits a Garrison-installed file
    fs.writeFileSync(path.join(claudeHome, "skills", "alpha", "SKILL.md"), "# Alpha (edited)");

    const u = await uninstallFitting("foo", opts);
    expect(u.driftedSkipped).toContain("skills/alpha/SKILL.md");
    expect(onDisk("skills/alpha/SKILL.md")).toBe(true); // left intact
    expect(read("skills/alpha/SKILL.md")).toBe("# Alpha (edited)");
  });

  it("detectDrift reports drifted and missing files", async () => {
    await installFitting(skillManifest("foo", "alpha", "# Alpha"), opts);
    fs.writeFileSync(path.join(claudeHome, "skills", "alpha", "SKILL.md"), "changed");
    fs.rmSync(path.join(claudeHome, "skills", "alpha", "scripts.sh"));
    const drift = await detectDrift(opts);
    const states = Object.fromEntries(drift.map((d) => [d.file, d.state]));
    expect(states["skills/alpha/SKILL.md"]).toBe("drifted");
    expect(states["skills/alpha/scripts.sh"]).toBe("missing");
  });

  it("re-installing the same fitting is idempotent (owns its own target)", async () => {
    await installFitting(skillManifest("foo", "alpha", "# v1"), opts);
    const r2 = await installFitting(skillManifest("foo", "alpha", "# v2"), opts);
    expect(r2.ok).toBe(true);
    expect(read("skills/alpha/SKILL.md")).toBe("# v2");
    expect((await listInstalledFittings(opts))).toHaveLength(1);
  });

  it("returns no-artifacts for a fitting with nothing to install", async () => {
    const r = await installFitting({ fittingId: "x", source: "t", artifacts: [] }, opts);
    expect(r).toMatchObject({ ok: false, code: "no-artifacts" });
  });
});

describe("claude-install-source resolver (real APM deployed_files)", () => {
  it("resolves the basic-memory fitting's skill from compositions/default", async () => {
    const manifest = await resolveArtifacts("basic-memory");
    const skill = manifest.artifacts.find((a) => a.target === "skills/garrison-memory");
    expect(skill).toBeDefined();
    expect(skill?.kind).toBe("skill-dir");
    expect(fs.existsSync(skill!.sourcePath as string)).toBe(true);
  });
});
