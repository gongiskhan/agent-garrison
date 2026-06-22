import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFitting, uninstallFitting, readInstallLock, type InstallManifest, type InstallOpts } from "@/lib/claude-install";
import { settingsPath } from "@/lib/claude-settings-file";

let claudeHome: string;
let lockPath: string;
let opts: InstallOpts;

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gar-hookinst-"));
  claudeHome = path.join(base, "claude");
  lockPath = path.join(base, "lock.json");
  fs.mkdirSync(claudeHome, { recursive: true });
  opts = { claudeHome, lockPath, now: "2026-06-07T00:00:00Z" };
});
afterEach(() => {
  fs.rmSync(path.dirname(claudeHome), { recursive: true, force: true });
});

function settings(): { hooks?: Record<string, { _garrison?: unknown }[]> } {
  return JSON.parse(fs.readFileSync(settingsPath(claudeHome), "utf8"));
}
function hookManifest(fittingId: string, event: string, cmd: string): InstallManifest {
  return {
    fittingId,
    source: "test",
    artifacts: [{ target: "hooks", kind: "hook-group", hookGroups: [{ event, matcher: "", hooks: [{ type: "command", command: cmd }] }] }]
  };
}

describe("hook fittings via the shared owner-scoped writer", () => {
  beforeEach(() => {
    // a hand-authored, untagged hook group already present (e.g. a user's own hook)
    fs.writeFileSync(
      settingsPath(claudeHome),
      JSON.stringify({ hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "USER_HOOK" }] }] } })
    );
  });

  it("installs an owner-tagged group and records it in the lock", async () => {
    const r = await installFitting(hookManifest("memory", "SessionStart", "mem"), opts);
    expect(r.ok).toBe(true);
    const grp = settings().hooks!.SessionStart;
    expect(grp).toHaveLength(1);
    expect(grp[0]._garrison).toBe("fitting:memory");

    const lock = await readInstallLock(opts);
    const art = lock.installs.memory.artifacts[0];
    expect(art.kind).toBe("hook-group");
    expect(art.owner).toBe("fitting:memory");
    expect(art.events).toEqual(["SessionStart"]);
  });

  it("two owners coexist; uninstalling one leaves the other AND the hand-authored group intact", async () => {
    await installFitting(hookManifest("memory", "Stop", "mem"), opts);
    await installFitting(hookManifest("session-view", "Stop", "sv"), opts);

    // Stop now has: USER_HOOK (untagged) + memory + session-view
    let stop = settings().hooks!.Stop;
    expect(stop).toHaveLength(3);
    expect(stop.filter((g) => g._garrison === "fitting:memory")).toHaveLength(1);
    expect(stop.filter((g) => g._garrison === "fitting:session-view")).toHaveLength(1);
    expect(stop.filter((g) => g._garrison === undefined)).toHaveLength(1); // hand-authored

    // Uninstall ONLY memory — the bare-marker bug would have stripped all three.
    const u = await uninstallFitting("memory", opts);
    expect(u.ok).toBe(true);
    stop = settings().hooks!.Stop;
    expect(stop.filter((g) => g._garrison === "fitting:memory")).toHaveLength(0);
    expect(stop.filter((g) => g._garrison === "fitting:session-view")).toHaveLength(1);
    expect(stop.filter((g) => g._garrison === undefined)).toHaveLength(1); // hand-authored survives
  });

  it("re-installing a hook fitting is idempotent (no duplicate groups)", async () => {
    await installFitting(hookManifest("memory", "SessionStart", "mem"), opts);
    await installFitting(hookManifest("memory", "SessionStart", "mem2"), opts);
    expect(settings().hooks!.SessionStart).toHaveLength(1);
  });
});
