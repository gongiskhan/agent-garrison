import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CompositionOwnedByOtherInstanceError,
  claimComposition,
  ownerFilePath,
  readCompositionOwner,
  releaseComposition
} from "@/lib/composition-owner";

// prod, dev and codex all run out of ONE checkout, so they resolve the same
// compositions/<id>/ working tree. `apm install`, every fitting setup hook, and
// materializeEnv/wipeMaterializedEnv all write in there — a second instance
// running `up` would rewrite the files the first instance's operative is
// executing from and delete its .env secrets. This guard is what stops that.

const dirs: string[] = [];
const priorProfile = process.env.GARRISON_INSTANCE_ID;

function sandbox(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "garrison-owner-"));
  dirs.push(dir);
  return dir;
}

function asProfile(profile: string): void {
  process.env.GARRISON_INSTANCE_ID = profile;
}

afterEach(() => {
  if (priorProfile === undefined) delete process.env.GARRISON_INSTANCE_ID;
  else process.env.GARRISON_INSTANCE_ID = priorProfile;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("composition working-tree ownership", () => {
  it("records the claiming instance and its pid", async () => {
    const dir = sandbox();
    asProfile("prod");
    const owner = await claimComposition(dir, "default");

    expect(owner.instanceId).toBe("prod");
    expect(owner.pid).toBe(process.pid);
    expect(owner.compositionId).toBe("default");
    expect(existsSync(ownerFilePath(dir))).toBe(true);
    expect(JSON.parse(readFileSync(ownerFilePath(dir), "utf8")).instanceId).toBe("prod");
  });

  it("refuses a second instance — the case that would clobber prod's apm_modules and .env", async () => {
    const dir = sandbox();
    asProfile("prod");
    await claimComposition(dir, "default");

    asProfile("codex");
    await expect(claimComposition(dir, "default")).rejects.toThrow(
      CompositionOwnedByOtherInstanceError
    );

    // The prod claim must survive the rejected attempt.
    expect((await readCompositionOwner(dir))?.instanceId).toBe("prod");
  });

  it("names the owner and the remedy in the error", async () => {
    const dir = sandbox();
    asProfile("prod");
    await claimComposition(dir, "default");
    asProfile("dev");

    await expect(claimComposition(dir, "default")).rejects.toThrow(/already in use by the prod/);
    await expect(claimComposition(dir, "default")).rejects.toThrow(/different composition/);
  });

  it("allows same-profile re-entry so a restart or redeploy is never blocked", async () => {
    const dir = sandbox();
    asProfile("prod");
    const first = await claimComposition(dir, "default");
    // A systemd restart re-enters with a new pid; the profile is what matters.
    const second = await claimComposition(dir, "default");

    expect(second.instanceId).toBe("prod");
    expect(second.claimedAt >= first.claimedAt).toBe(true);
  });

  it("releases only for the owning profile, so another instance cannot give away a live tree", async () => {
    const dir = sandbox();
    asProfile("prod");
    await claimComposition(dir, "default");

    asProfile("codex");
    await releaseComposition(dir);
    expect((await readCompositionOwner(dir))?.instanceId).toBe("prod");

    asProfile("prod");
    await releaseComposition(dir);
    expect(await readCompositionOwner(dir)).toBeNull();

    // Released — a different instance may now take it.
    asProfile("codex");
    expect((await claimComposition(dir, "default")).instanceId).toBe("codex");
  });

  it("treats a corrupt or absent record as unowned rather than wedging up()", async () => {
    const dir = sandbox();
    expect(await readCompositionOwner(dir)).toBeNull();

    asProfile("prod");
    await claimComposition(dir, "default");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(ownerFilePath(dir), "{ not json");

    expect(await readCompositionOwner(dir)).toBeNull();
    asProfile("codex");
    await expect(claimComposition(dir, "default")).resolves.toMatchObject({ instanceId: "codex" });
  });
});
