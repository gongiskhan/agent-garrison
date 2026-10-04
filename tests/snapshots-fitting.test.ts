import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatRestoreCommand,
  readSnapshotsState,
  resolveScriptsDir
} from "@/app/api/snapshots/core";

const SCRIPTS_DIR = path.resolve(
  __dirname,
  "..",
  "fittings",
  "seed",
  "snapshots-default",
  "scripts"
);

const resticAvailable = spawnSync("restic", ["version"], { encoding: "utf8" }).status === 0;

let sandbox = "";
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "snapfit-"));
});
afterEach(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("readSnapshotsState", () => {
  it("reads a well-formed state.json", () => {
    const dir = path.join(sandbox, "snapshots");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({ lastRun: "2026-07-10T03:00:00Z", ok: true, bytes: 4096 })
    );
    const state = readSnapshotsState(dir);
    expect(state).toEqual({ lastRun: "2026-07-10T03:00:00Z", ok: true, bytes: 4096 });
  });

  it("carries a failure record through", () => {
    const dir = path.join(sandbox, "snapshots");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({ lastRun: "2026-07-10T03:00:00Z", ok: false, error: "no RESTIC_PASSWORD" })
    );
    expect(readSnapshotsState(dir)).toMatchObject({ ok: false, error: "no RESTIC_PASSWORD" });
  });

  it("returns null when the file is missing", () => {
    expect(readSnapshotsState(path.join(sandbox, "does-not-exist"))).toBeNull();
  });

  it("returns null on malformed JSON or wrong shape", () => {
    const dir = path.join(sandbox, "snapshots");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "state.json"), "{ not json");
    expect(readSnapshotsState(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ foo: 1 }));
    expect(readSnapshotsState(dir)).toBeNull();
  });
});

describe("formatRestoreCommand", () => {
  it("formats the exact restic restore command", () => {
    expect(formatRestoreCommand("gs:my-bucket:/garrison", "217272de", "/home/u/restore")).toBe(
      "restic -r gs:my-bucket:/garrison restore 217272de --target /home/u/restore"
    );
  });

  it("falls back to placeholders when a value is missing", () => {
    expect(formatRestoreCommand("", "", "")).toBe(
      "restic -r <repo> restore <snapshot-id> --target <target-dir>"
    );
  });
});

describe("resolveScriptsDir", () => {
  it("falls back to the in-repo seed scripts when no composition is active", () => {
    const prev = process.env.GARRISON_COMPOSITION_DIR;
    delete process.env.GARRISON_COMPOSITION_DIR;
    try {
      expect(resolveScriptsDir()).toBe(SCRIPTS_DIR);
    } finally {
      if (prev !== undefined) process.env.GARRISON_COMPOSITION_DIR = prev;
    }
  });
});

describe("excludes.txt", () => {
  const lines = fs
    .readFileSync(path.join(SCRIPTS_DIR, "excludes.txt"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  it("excludes the heavy/rebuildable dirs", () => {
    expect(lines).toContain("node_modules");
    expect(lines).toContain("apm_modules");
    expect(lines).toContain(".cache");
    expect(lines).toContain(".next");
    expect(lines).toContain(".turbo");
  });

  it("excludes the Files trash", () => {
    expect(lines.some((l) => l.includes(".garrison/files/.trash"))).toBe(true);
  });

  it("excludes the fitting's own state home (the local repo must never back itself up)", () => {
    // Regression: without this the local-fallback repo under
    // ~/.garrison/snapshots/repo entered every snapshot, compounding the
    // repo size on each nightly run (24G -> 37G across two backups).
    expect(lines.some((l) => l.includes(".garrison/snapshots"))).toBe(true);
  });
});

// Run env.sh in a clean shell and read back the vars it resolved. env.sh is a
// sourced fragment, so we source it and print the values we care about.
function resolveEnv(opts: {
  home: string;
  compDir?: string;
  extra?: Record<string, string>;
}): Record<string, string> {
  const script =
    `. "${path.join(SCRIPTS_DIR, "env.sh")}"\n` +
    `printf 'RESTIC_REPOSITORY=%s\\n' "\${RESTIC_REPOSITORY:-}"\n` +
    `printf 'RESTIC_PASSWORD=%s\\n' "\${RESTIC_PASSWORD:-}"\n` +
    `printf 'SHARED=%s\\n' "\${SHARED:-}"\n` +
    `printf 'ONLYFALLBACK=%s\\n' "\${ONLYFALLBACK:-}"\n` +
    `printf 'SNAPSHOTS_PROJECTS_ROOT=%s\\n' "\${SNAPSHOTS_PROJECTS_ROOT:-}"\n` +
    `printf 'SNAPSHOTS_HOST=%s\\n' "\${SNAPSHOTS_HOST:-}"\n`;
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    PATH: process.env.PATH ?? "",
    HOME: opts.home,
    ...(opts.compDir ? { GARRISON_COMPOSITION_DIR: opts.compDir } : {}),
    ...(opts.extra ?? {})
  };
  const res = spawnSync("bash", ["-c", script], { encoding: "utf8", env });
  expect(res.status, res.stderr).toBe(0);
  const out: Record<string, string> = {};
  for (const line of res.stdout.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

describe("env.sh source order + defaults", () => {
  it("Vault-materialized env wins; the fallback file only fills gaps", () => {
    const home = path.join(sandbox, "home");
    const fallbackDir = path.join(home, ".garrison", "snapshots");
    fs.mkdirSync(fallbackDir, { recursive: true });
    fs.writeFileSync(
      path.join(fallbackDir, "env"),
      "SHARED=fromfallback\nONLYFALLBACK=fb\nSNAPSHOTS_BUCKET=my-bucket\n"
    );
    const compDir = path.join(sandbox, "comp");
    fs.mkdirSync(compDir, { recursive: true });
    fs.writeFileSync(path.join(compDir, ".env"), "SHARED=fromvault\nRESTIC_PASSWORD=vaultpw\n");

    const out = resolveEnv({ home, compDir });
    expect(out.SHARED).toBe("fromvault"); // vault precedence
    expect(out.RESTIC_PASSWORD).toBe("vaultpw"); // vault-only
    expect(out.ONLYFALLBACK).toBe("fb"); // fallback fills the gap
    expect(out.RESTIC_REPOSITORY).toBe("gs:my-bucket:/garrison"); // bucket -> gs default
    expect(out.SNAPSHOTS_PROJECTS_ROOT).toBe(path.join(home, "dev")); // default projects root
  });

  it("an explicit RESTIC_REPOSITORY override is never clobbered by the bucket default", () => {
    const home = path.join(sandbox, "home");
    const fallbackDir = path.join(home, ".garrison", "snapshots");
    fs.mkdirSync(fallbackDir, { recursive: true });
    fs.writeFileSync(path.join(fallbackDir, "env"), "SNAPSHOTS_BUCKET=my-bucket\n");

    const out = resolveEnv({ home, extra: { RESTIC_REPOSITORY: "/tmp/local-repo" } });
    expect(out.RESTIC_REPOSITORY).toBe("/tmp/local-repo");
  });

  it("resolves a stable restic host: explicit, node name, scheduling receipt, then hostname", () => {
    const home = path.join(sandbox, "home");
    const stateDir = path.join(home, ".garrison", "snapshots");
    fs.mkdirSync(stateDir, { recursive: true });

    const hostname = spawnSync("hostname", { encoding: "utf8" }).stdout.trim();
    expect(resolveEnv({ home }).SNAPSHOTS_HOST).toBe(hostname);

    fs.writeFileSync(
      path.join(stateDir, "schedule.json"),
      JSON.stringify({ version: 1, node: "receipt-node", jobs: [{ id: "snapshots.backup" }] }, null, 2) + "\n"
    );
    expect(resolveEnv({ home }).SNAPSHOTS_HOST).toBe("receipt-node");
    expect(resolveEnv({ home, extra: { GARRISON_NODE_NAME: "mesh-node" } }).SNAPSHOTS_HOST).toBe("mesh-node");
    expect(
      resolveEnv({ home, extra: { GARRISON_NODE_NAME: "mesh-node", SNAPSHOTS_HOST: "pinned" } }).SNAPSHOTS_HOST
    ).toBe("pinned");
  });
});

// A full local round trip through the actual scripts, gated on restic being
// installed. Uses a throwaway on-disk repo (no cloud, no secrets).
describe.skipIf(!resticAvailable)("restic round trip (local repo)", () => {
  it("backs up, records state, lists, verifies, and restores - honoring excludes", () => {
    const home = path.join(sandbox, "home");
    const repo = path.join(sandbox, "repo");
    const restore = path.join(sandbox, "restore");
    const stateDir = path.join(home, ".garrison", "snapshots");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(path.join(home, ".garrison", "files", ".trash"), { recursive: true });
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, "dev", "proj", "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(home, "dev", "proj", "file.txt"), "hello-snapshot\n");
    fs.writeFileSync(path.join(home, "dev", "proj", "node_modules", "junk.txt"), "EXCLUDED\n");
    fs.mkdirSync(path.join(home, "dev", "proj", ".next", "cache"), { recursive: true });
    fs.writeFileSync(path.join(home, "dev", "proj", ".next", "cache", "build.bin"), "EXCLUDED\n");
    fs.writeFileSync(path.join(home, ".garrison", "files", ".trash", "old.txt"), "EXCLUDED\n");
    fs.writeFileSync(path.join(stateDir, "env"), `RESTIC_REPOSITORY=${repo}\nRESTIC_PASSWORD=test\n`, {
      mode: 0o600
    });

    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PATH: process.env.PATH ?? "",
      HOME: home,
      RESTIC_CACHE_DIR: path.join(sandbox, "cache"),
      GARRISON_NODE_NAME: "roundtrip-node"
    };

    // backup
    const backup = spawnSync("bash", [path.join(SCRIPTS_DIR, "backup.sh")], { encoding: "utf8", env });
    expect(backup.status, backup.stderr).toBe(0);

    // state.json
    const state = readSnapshotsState(stateDir);
    expect(state?.ok).toBe(true);
    expect(state?.bytes ?? 0).toBeGreaterThan(0);

    // status envelope
    const status = spawnSync("bash", [path.join(SCRIPTS_DIR, "status.sh")], { encoding: "utf8", env });
    expect(status.status, status.stderr).toBe(0);
    const envelope = JSON.parse(status.stdout.trim()) as {
      repository: string;
      error: string;
      snapshots: Array<{ short_id?: string; paths?: string[]; hostname?: string }>;
    };
    expect(envelope.repository).toBe(repo);
    expect(envelope.error).toBe("");
    expect(envelope.snapshots.length).toBeGreaterThanOrEqual(1);
    expect(envelope.snapshots.map((s) => s.hostname)).toEqual(["roundtrip-node"]);

    // verify (restic check)
    const verify = spawnSync("bash", [path.join(SCRIPTS_DIR, "verify.sh")], { encoding: "utf8", env });
    expect(verify.status, verify.stderr).toBe(0);
    expect(`${verify.stdout}${verify.stderr}`).toMatch(/no errors were found/);

    // restore + exclude enforcement
    const restoreEnv: NodeJS.ProcessEnv = { ...env, RESTIC_REPOSITORY: repo, RESTIC_PASSWORD: "test" };
    const restored = spawnSync("restic", ["restore", "latest", "--target", restore], {
      encoding: "utf8",
      env: restoreEnv
    });
    expect(restored.status, restored.stderr).toBe(0);
    expect(fs.existsSync(path.join(restore, home, "dev", "proj", "file.txt"))).toBe(true);
    expect(fs.existsSync(path.join(restore, home, "dev", "proj", "node_modules", "junk.txt"))).toBe(false);
    expect(fs.existsSync(path.join(restore, home, "dev", "proj", ".next", "cache", "build.bin"))).toBe(false);
    expect(fs.existsSync(path.join(restore, home, ".garrison", "files", ".trash", "old.txt"))).toBe(false);
  });

  it("prunes one node's history as one group even when its backup set changes", () => {
    // Regression: restic's default host+paths grouping gave every backup-set
    // variant its own retention group, so prune kept each variant's dailies.
    const home = path.join(sandbox, "home");
    const repo = path.join(sandbox, "repo");
    const stateDir = path.join(home, ".garrison", "snapshots");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(path.join(home, "dev", "proj"), { recursive: true });
    fs.writeFileSync(path.join(home, "dev", "proj", "file.txt"), "hello-prune\n");
    fs.writeFileSync(path.join(stateDir, "env"), `RESTIC_REPOSITORY=${repo}\nRESTIC_PASSWORD=test\n`, {
      mode: 0o600
    });
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PATH: process.env.PATH ?? "",
      HOME: home,
      RESTIC_CACHE_DIR: path.join(sandbox, "cache"),
      GARRISON_NODE_NAME: "prune-node"
    };
    const run = (script: string) => {
      const res = spawnSync("bash", [path.join(SCRIPTS_DIR, script)], { encoding: "utf8", env });
      expect(res.status, res.stderr).toBe(0);
    };

    run("backup.sh");
    run("backup.sh");
    // A new path joins the backup set; same node, same day.
    fs.mkdirSync(path.join(home, ".garrison", "mesh-conversations"), { recursive: true });
    fs.writeFileSync(path.join(home, ".garrison", "mesh-conversations", "c.json"), "{}\n");
    run("backup.sh");
    run("prune.sh");

    const listed = spawnSync("restic", ["snapshots", "--json"], {
      encoding: "utf8",
      env: { ...env, RESTIC_REPOSITORY: repo, RESTIC_PASSWORD: "test" }
    });
    expect(listed.status, listed.stderr).toBe(0);
    // One group: restic keeps the oldest (short history) and the newest daily,
    // and drops the middle run. Split by paths, all three would survive.
    const snapshots = JSON.parse(listed.stdout) as Array<{ hostname: string; paths: string[]; time: string }>;
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every((s) => s.hostname === "prune-node")).toBe(true);
    const newest = snapshots.sort((a, b) => a.time.localeCompare(b.time)).at(-1)!;
    expect(newest.paths).toContain(path.join(home, ".garrison", "mesh-conversations"));
  });
});
