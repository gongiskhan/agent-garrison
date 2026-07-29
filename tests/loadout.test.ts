// Loadout descriptor + vault-fed rendering (brief D2/D3).
//
// The property that matters most here is the NAMESPACE rule: a Loadout commits
// variable NAMES, values live only in the vault, and a project that needs a
// different value for a shared name uses a `PROJECT__VAR` override that the
// rendered .env hides entirely — the application must never learn the prefix
// exists.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isEnvSafeValue,
  listLoadouts,
  quoteEnvValueForLoadout,
  readLoadout,
  renderLoadoutEnv,
  validateLoadout,
  vaultPrefixFor,
  writeLoadout,
  type Loadout
} from "@/lib/loadout";
import { unlockVault, writeVaultSecrets } from "@/lib/vault";
import { resetMasterKeyCache } from "@/lib/keychain";

let dir: string;

function resetVaultRuntime(): void {
  (globalThis as unknown as { __agentGarrisonVault?: unknown }).__agentGarrisonVault = undefined;
  resetMasterKeyCache();
}

const base: Loadout = {
  id: "ekoa",
  repo_remote: "git@github.com:gongiskhan/ekoa.git",
  default_branch: "main",
  setup_commands: ["npm ci"],
  env_vars: ["OPENAI_API_KEY", "DATABASE_URL"],
  verify_command: "npm run typecheck"
};

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "garrison-loadout-"));
  process.env.GARRISON_HOME = dir;
  process.env.GARRISON_VAULT_PATH = path.join(dir, "vault.json");
  process.env.GARRISON_VAULT_AUDIT_PATH = path.join(dir, "audit.jsonl");
  process.env.VAULT_UNLOCKED = "true";
  resetVaultRuntime();
  await unlockVault();
});

afterEach(() => {
  delete process.env.GARRISON_HOME;
  delete process.env.GARRISON_VAULT_PATH;
  delete process.env.GARRISON_VAULT_AUDIT_PATH;
  delete process.env.VAULT_UNLOCKED;
  resetVaultRuntime();
  rmSync(dir, { recursive: true, force: true });
});

describe("validation", () => {
  it("requires a verify command", () => {
    // An environment nobody can prove works is not materialized, it is hoped
    // for — and the whole point of verifying before the model starts is that
    // failure costs zero tokens.
    const errors = validateLoadout({ ...base, verify_command: "" });
    expect(errors.some((e) => e.field === "verify_command")).toBe(true);
  });

  it("rejects a VALUE pasted into env_vars", () => {
    // The single most damaging authoring mistake: it commits a secret.
    const errors = validateLoadout({ ...base, env_vars: ["OPENAI_API_KEY=sk-real-secret"] });
    expect(errors.some((e) => e.problem.includes("NAMES ONLY"))).toBe(true);
  });

  it("rejects env var names that are not env var names", () => {
    expect(validateLoadout({ ...base, env_vars: ["not-a-name"] }).length).toBeGreaterThan(0);
    expect(validateLoadout({ ...base, env_vars: ["1LEADING_DIGIT"] }).length).toBeGreaterThan(0);
  });

  it("accepts a well-formed descriptor", () => {
    expect(validateLoadout(base)).toEqual([]);
  });
});

describe("store", () => {
  it("round-trips a loadout", async () => {
    await writeLoadout(base);
    expect(await readLoadout("ekoa")).toEqual(base);
    expect((await listLoadouts()).map((l) => l.id)).toEqual(["ekoa"]);
  });

  it("returns null for an unknown id", async () => {
    expect(await readLoadout("nope")).toBeNull();
  });

  it("refuses to write an invalid loadout", async () => {
    await expect(writeLoadout({ ...base, verify_command: "" })).rejects.toThrow();
  });
});

describe("vault prefix", () => {
  it("derives an override prefix from the project id", () => {
    expect(vaultPrefixFor("ekoa")).toBe("EKOA__");
    expect(vaultPrefixFor("ekoa-code")).toBe("EKOA_CODE__");
    expect(vaultPrefixFor("garrison.v2")).toBe("GARRISON_V2__");
  });
});

describe("renderLoadoutEnv", () => {
  it("prefers PROJECT__VAR and falls back to the bare name", async () => {
    await writeVaultSecrets([
      { key: "OPENAI_API_KEY", value: "sk-shared" },
      { key: "DATABASE_URL", value: "postgres://shared" },
      { key: "EKOA__DATABASE_URL", value: "postgres://ekoa-specific" }
    ]);

    const rendered = await renderLoadoutEnv(base);

    // The override wins for DATABASE_URL; the shared value is used for the key.
    expect(rendered.resolved.find((r) => r.name === "DATABASE_URL")?.source).toBe("EKOA__DATABASE_URL");
    expect(rendered.resolved.find((r) => r.name === "OPENAI_API_KEY")?.source).toBe("OPENAI_API_KEY");
    expect(rendered.missing).toEqual([]);

    // The rendered file uses the BARE name in both cases — the prefix is a
    // vault-side mechanism the application must never see.
    expect(rendered.content).toContain("DATABASE_URL=postgres://ekoa-specific");
    expect(rendered.content).toContain("OPENAI_API_KEY=sk-shared");
    expect(rendered.content).not.toContain("EKOA__DATABASE_URL");
  });

  it("renders ONLY the declared names, never the whole vault", async () => {
    // The pre-existing materializeEnv writes every vault entry unfiltered. A
    // loadout is scoped by construction: an undeclared secret must not travel to
    // another machine just because it exists.
    await writeVaultSecrets([
      { key: "OPENAI_API_KEY", value: "sk-shared" },
      { key: "DATABASE_URL", value: "postgres://shared" },
      { key: "UNRELATED_SECRET", value: "must-not-travel" }
    ]);

    const rendered = await renderLoadoutEnv(base);
    expect(rendered.content).not.toContain("UNRELATED_SECRET");
    expect(rendered.content).not.toContain("must-not-travel");
  });

  it("reports missing names rather than rendering a half environment", async () => {
    await writeVaultSecrets([{ key: "OPENAI_API_KEY", value: "sk-shared" }]);
    const rendered = await renderLoadoutEnv(base);
    expect(rendered.missing).toEqual(["DATABASE_URL"]);
  });

  it("REFUSES a multi-line value instead of corrupting it", async () => {
    // quoteEnvValue JSON-escapes, but neither dotenv reader un-escapes, so a PEM
    // key or service-account JSON round-trips as the literal characters `\n`.
    // Failing loudly beats handing a worker a credential that cannot work.
    await writeVaultSecrets([
      { key: "OPENAI_API_KEY", value: "sk-shared" },
      { key: "DATABASE_URL", value: "line1\nline2" }
    ]);
    await expect(renderLoadoutEnv(base)).rejects.toThrow(/multi-line/i);
  });

  it("quotes values that need it", () => {
    expect(quoteEnvValueForLoadout("plain-value_1")).toBe("plain-value_1");
    expect(quoteEnvValueForLoadout("has space")).toBe("'has space'");
    expect(quoteEnvValueForLoadout("a#b")).toBe("'a#b'");
    // A single quote cannot be escaped inside single quotes in the readers'
    // simplistic parsing, so refuse rather than corrupt.
    expect(() => quoteEnvValueForLoadout("it's")).toThrow();
  });

  it("isEnvSafeValue rejects newlines and carriage returns", () => {
    expect(isEnvSafeValue("fine")).toBe(true);
    expect(isEnvSafeValue("bad\nvalue")).toBe(false);
    expect(isEnvSafeValue("bad\rvalue")).toBe(false);
  });
});
