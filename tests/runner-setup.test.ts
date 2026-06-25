import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runFittingSetup, setupConfigEnv } from "@/lib/runner";
import type { GarrisonMetadata } from "@/lib/types";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

async function makeComposition(fittingId: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "garrison-setup-"));
  tempRoots.push(root);
  const fittingDir = path.join(root, "apm_modules", "_local", fittingId);
  await fs.mkdir(fittingDir, { recursive: true });
  return root;
}

function fittingEntry(
  id: string,
  setup: GarrisonMetadata["setup"]
): { id: string; metadata: GarrisonMetadata } {
  const metadata: GarrisonMetadata = {
    faculty: "memory",
    cardinality_hint: "single",
    component_shape: "skill",
    platforms: ["claude-code"],
    config_schema: [],
    provides: [],
    consumes: [],
    setup,
    verify: { command: "echo ok", expect: "ok", timeout_ms: 10000 }
  };
  return { id, metadata };
}

describe("runFittingSetup", () => {
  it("succeeds when the setup command exits 0", async () => {
    const compositionDir = await makeComposition("happy");
    const entry = fittingEntry("happy", [{
      command: "echo hello-from-setup",
      idempotent: true
    }]);

    const result = await runFittingSetup(entry, compositionDir);

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello-from-setup");
  });

  it("reports failure when the setup command exits non-zero", async () => {
    const compositionDir = await makeComposition("sad");
    const entry = fittingEntry("sad", [{
      command: "echo failing && exit 7",
      idempotent: false
    }]);

    const result = await runFittingSetup(entry, compositionDir);

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toContain("failing");
  });

  it("is a no-op when no setup block is declared", async () => {
    const compositionDir = await makeComposition("no-setup");
    const entry = fittingEntry("no-setup", undefined);

    const result = await runFittingSetup(entry, compositionDir);

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("projects the fitting's config into <FITTING_ID>_<KEY> env vars", () => {
    expect(setupConfigEnv("improver", { cron: "30 3 * * *", memory_primary: true })).toEqual({
      IMPROVER_CRON: "30 3 * * *",
      IMPROVER_MEMORY_PRIMARY: "true",
    });
    // dashed ids normalise to underscores; nested values are skipped
    expect(setupConfigEnv("vault-git-sync", { cron: "0 4 * * *", nested: { a: 1 } })).toEqual({
      VAULT_GIT_SYNC_CRON: "0 4 * * *",
    });
  });

  it("config values reach the setup command as env vars", async () => {
    const compositionDir = await makeComposition("vault-git-sync");
    const entry = fittingEntry("vault-git-sync", [{
      command: 'echo "cron=$VAULT_GIT_SYNC_CRON"',
      idempotent: true
    }]);

    const result = await runFittingSetup(entry, compositionDir, { cron: "0 4 * * *" });

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("cron=0 4 * * *");
  });

  it("setup running in apm_modules/_local/<id>/ sees .env materialised at the composition root", async () => {
    // Reproduces the slack-channel bug: setup runs in the fitting's
    // installed dir, several levels deep, but the materialised .env
    // sits at the composition root. The runner must walk up to find it.
    const compositionDir = await makeComposition("slack-channel");
    await fs.writeFile(
      path.join(compositionDir, ".env"),
      "SLACK_BOT_TOKEN=xoxb-fake\nSLACK_SIGNING_SECRET=secret-fake\n",
      "utf8"
    );
    const entry = fittingEntry("slack-channel", [{
      command: 'echo "token=$SLACK_BOT_TOKEN" "secret=$SLACK_SIGNING_SECRET"',
      idempotent: true
    }]);

    const result = await runFittingSetup(entry, compositionDir);

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("token=xoxb-fake");
    expect(result.stdout).toContain("secret=secret-fake");
  });

  it("runs multiple setup steps in order and aggregates their output", async () => {
    const compositionDir = await makeComposition("multi");
    const entry = fittingEntry("multi", [
      { command: "echo step-one", idempotent: true },
      { command: "echo step-two", idempotent: true },
      { command: "echo step-three", idempotent: true }
    ]);

    const result = await runFittingSetup(entry, compositionDir);

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    // Order preserved in the aggregated stdout.
    const idxOne = result.stdout.indexOf("step-one");
    const idxTwo = result.stdout.indexOf("step-two");
    const idxThree = result.stdout.indexOf("step-three");
    expect(idxOne).toBeGreaterThanOrEqual(0);
    expect(idxTwo).toBeGreaterThan(idxOne);
    expect(idxThree).toBeGreaterThan(idxTwo);
  });

  it("aborts on the first failing step and never runs later steps", async () => {
    const compositionDir = await makeComposition("abort");
    const entry = fittingEntry("abort", [
      { command: "echo before-failure", idempotent: true },
      { command: "echo boom && exit 5", idempotent: false },
      { command: "echo should-not-run", idempotent: true }
    ]);

    const result = await runFittingSetup(entry, compositionDir);

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(5);
    expect(result.stdout).toContain("before-failure");
    expect(result.stdout).toContain("boom");
    // The step after the failure must not have executed.
    expect(result.stdout).not.toContain("should-not-run");
  });
});
