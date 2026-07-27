// Regression: the spawn record (~/.garrison/logs/<pid>/meta.json) must never
// persist a secret VALUE in the clear.
//
// It did. redactEnv masked by NAME pattern only (_TOKEN$|_KEY$|_SECRET$|…), and
// the account-registry keys — ANTHROPIC_ACCOUNT__<name>, ACCOUNT__<platform>__<name>
// — end in an ACCOUNT NAME, so they matched nothing. Setup/verify hooks are
// spawned with the whole materialized .env merged in, so every one of those
// tokens reached disk in cleartext: 1384 meta.json files on the dev box held a
// live `sk-ant-oat01…`. The stdout/stderr tee already redacted by value; meta.json
// was the hole.
//
// This matters beyond hygiene for Outpost Dispatch: D3 requires that the
// materializer write secret values to `.env` and nowhere else, and a worker
// rendering env on three machines multiplies every leak site by three.

import { mkdtempSync, rmSync } from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unlockVault, writeVaultSecrets } from "@/lib/vault";
import { resetMasterKeyCache } from "@/lib/keychain";
import { REDACTED } from "@/lib/secret-redaction";
import { spawnTracked, type MetaJson } from "@/lib/spawn";

const ACCOUNT_TOKEN = "sk-ant-oat01-not-a-real-token-abcdef0123456789";
const PLAIN_SECRET = "trello-secret-value-xyz";

let dir: string;
const dirsToClean: string[] = [];

function resetVaultRuntime(): void {
  (globalThis as unknown as { __agentGarrisonVault?: unknown }).__agentGarrisonVault = undefined;
  resetMasterKeyCache();
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "garrison-spawn-redact-"));
  process.env.GARRISON_VAULT_PATH = path.join(dir, "vault.json");
  process.env.GARRISON_VAULT_AUDIT_PATH = path.join(dir, "audit.jsonl");
  process.env.VAULT_UNLOCKED = "true";
  resetVaultRuntime();
  await unlockVault();
  await writeVaultSecrets([
    { key: "ANTHROPIC_ACCOUNT__temp-a", value: ACCOUNT_TOKEN },
    { key: "TRELLO_KEY", value: PLAIN_SECRET }
  ]);
});

afterEach(async () => {
  delete process.env.GARRISON_VAULT_PATH;
  delete process.env.GARRISON_VAULT_AUDIT_PATH;
  delete process.env.VAULT_UNLOCKED;
  resetVaultRuntime();
  rmSync(dir, { recursive: true, force: true });
  for (const d of dirsToClean.splice(0)) {
    await fsp.rm(d, { recursive: true, force: true }).catch(() => null);
  }
});

async function spawnAndReadMeta(
  env: Record<string, string>,
  args: string[] = ["-e", "process.exit(0)"]
): Promise<MetaJson> {
  // Deliberately minimal env — the assertions below then see exactly the keys
  // under test and nothing inherited from the developer's shell. PATH is needed
  // to find `node`; NODE_ENV because the project's ProcessEnv type requires it.
  const result = spawnTracked(
    "node",
    args,
    {
      env: {
        PATH: process.env.PATH ?? "",
        NODE_ENV: process.env.NODE_ENV ?? "test",
        ...env
      }
    },
    { spawnSite: "test:redaction" }
  );
  dirsToClean.push(result.logsDir);
  await new Promise<void>((resolve) => result.child.on("close", () => resolve()));
  return JSON.parse(await fsp.readFile(result.metaPath, "utf8")) as MetaJson;
}

describe("spawn meta.json redaction", () => {
  it("redacts an account token whose KEY matches no suffix pattern", async () => {
    const meta = await spawnAndReadMeta({
      ANTHROPIC_ACCOUNT__temp_a: ACCOUNT_TOKEN,
      PLAIN_VAR: "keep-me"
    });

    expect(JSON.stringify(meta)).not.toContain(ACCOUNT_TOKEN);
    expect(meta.env.PLAIN_VAR).toBe("keep-me");
  });

  it("redacts a vault secret delivered under an innocuous KEY (value pass)", async () => {
    // The key is the point: DATABASE_URL matches no name pattern, so only
    // value-based redaction can catch the secret embedded in it.
    const meta = await spawnAndReadMeta({
      DATABASE_URL: `postgres://user:${PLAIN_SECRET}@localhost/db`,
      PLAIN_VAR: "keep-me"
    });

    expect(JSON.stringify(meta)).not.toContain(PLAIN_SECRET);
    expect(meta.env.DATABASE_URL).toContain(REDACTED);
    expect(meta.env.DATABASE_URL).toContain("postgres://user:");
    expect(meta.env.PLAIN_VAR).toBe("keep-me");
  });

  it("redacts secrets passed on the command line, not just in the env", async () => {
    const meta = await spawnAndReadMeta({ PLAIN_VAR: "keep-me" }, [
      "-e",
      "process.exit(0)",
      `--token=${ACCOUNT_TOKEN}`
    ]);

    expect(JSON.stringify(meta)).not.toContain(ACCOUNT_TOKEN);
    expect(meta.args.join(" ")).toContain(REDACTED);
  });

  it("still redacts by NAME when the vault is locked (no value list)", async () => {
    // A locked vault makes currentSecretValuesSync() return [], so the name pass
    // is the only defence left. It must still cover the account prefixes.
    resetVaultRuntime();
    delete process.env.VAULT_UNLOCKED;

    const meta = await spawnAndReadMeta({
      ANTHROPIC_ACCOUNT__temp_a: ACCOUNT_TOKEN,
      ACCOUNT__openai__work: "sk-openai-secret",
      SOME_TOKEN: "suffix-matched",
      PLAIN_VAR: "keep-me"
    });

    expect(meta.env.ANTHROPIC_ACCOUNT__temp_a).toBe(REDACTED);
    expect(meta.env.ACCOUNT__openai__work).toBe(REDACTED);
    expect(meta.env.SOME_TOKEN).toBe(REDACTED);
    expect(meta.env.PLAIN_VAR).toBe("keep-me");
  });

  it("does not redact ordinary keys that merely contain a secret-ish word", async () => {
    const meta = await spawnAndReadMeta({
      KEYBINDINGS: "ctrl-a",
      MONKEY_PATCH: "on",
      PLAIN_VAR: "keep-me"
    });

    expect(meta.env.KEYBINDINGS).toBe("ctrl-a");
    expect(meta.env.MONKEY_PATCH).toBe("on");
    expect(meta.env.PLAIN_VAR).toBe("keep-me");
  });
});
