import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimComposition,
  claimCompositionForLaunch,
  readCompositionOwner
} from "@/lib/composition-owner";
import { cleanupFailedLaunchClaim } from "@/lib/runner";

const dirs: string[] = [];
const priorProfile = process.env.GARRISON_INSTANCE_ID;

function sandbox(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "garrison-failed-up-cleanup-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  if (priorProfile === undefined) delete process.env.GARRISON_INSTANCE_ID;
  else process.env.GARRISON_INSTANCE_ID = priorProfile;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("failed runner up claim cleanup", () => {
  it("wipes a materialized env and releases the exact fresh claim", async () => {
    process.env.GARRISON_INSTANCE_ID = "codex";
    const dir = sandbox();
    const claim = await claimCompositionForLaunch(dir, "glm");
    writeFileSync(path.join(dir, ".env"), "ACCOUNT__GLM__named=secret\n", { mode: 0o600 });

    expect(
      await cleanupFailedLaunchClaim(
        { ...claim, compositionDir: dir, envMaterialized: true },
        false
      )
    ).toEqual([]);
    expect(existsSync(path.join(dir, ".env"))).toBe(false);
    expect(await readCompositionOwner(dir)).toBeNull();
  });

  it("preserves a prior same-profile owner and its env on failed re-entry", async () => {
    process.env.GARRISON_INSTANCE_ID = "node";
    const dir = sandbox();
    await claimComposition(dir, "glm");
    const reentry = await claimCompositionForLaunch(dir, "glm");
    writeFileSync(path.join(dir, ".env"), "GLM_API_KEY=live-owner-secret\n", { mode: 0o600 });

    expect(reentry.acquiredFresh).toBe(false);
    expect(
      await cleanupFailedLaunchClaim(
        { ...reentry, compositionDir: dir, envMaterialized: true },
        false
      )
    ).toEqual([]);
    expect(existsSync(path.join(dir, ".env"))).toBe(true);
    expect((await readCompositionOwner(dir))?.instanceId).toBe("node");
  });

  it("preserves a fresh claim while any launched resource may still be live", async () => {
    process.env.GARRISON_INSTANCE_ID = "dev";
    const dir = sandbox();
    const claim = await claimCompositionForLaunch(dir, "glm");
    writeFileSync(path.join(dir, ".env"), "GLM_API_KEY=in-use\n", { mode: 0o600 });

    expect(
      await cleanupFailedLaunchClaim(
        { ...claim, compositionDir: dir, envMaterialized: true },
        true
      )
    ).toEqual([]);
    expect(existsSync(path.join(dir, ".env"))).toBe(true);
    expect(await readCompositionOwner(dir)).not.toBeNull();
  });
});
