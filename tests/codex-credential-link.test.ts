import { mkdtempSync, rmSync, existsSync, lstatSync, readlinkSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isRotatingCredential, parseAuthFile } from "@/lib/account-env";
import { importNativeLogin } from "@/lib/account-login";
import { unlockVault } from "@/lib/vault";
import { resetMasterKeyCache } from "@/lib/keychain";

// ONE MACHINE, ONE CODEX LOGIN.
//
// A ChatGPT `auth.json` holds a ROTATING refresh token: refreshing mints a new
// one and kills the old, and presenting a superseded one reads as replay, which
// revokes the whole family. So a second holder of that file is not a second
// login — it is a race whose loser is logged out. Garrison had three duplicators
// (the isolated CODEX_HOME seed, the "import this box's login as an account"
// path, and two temp-home harnesses) and between 2026-07-22 and 2026-08-16 they
// logged this box out of Codex five times.
//
// These tests pin the two halves of the fix: Garrison LINKS the credential into
// an isolated home, and REFUSES to copy a rotating one into an account.

const PROVISION = path.join(
  process.cwd(),
  "fittings/seed/codex-runtime/scripts/provision-home.mjs"
);

// Shaped like the real files (verified against codex-cli 0.147.0).
const chatgptAuth = (accountId = "acc-1"): string =>
  JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: "id", access_token: "at", refresh_token: "rt", account_id: accountId },
    last_refresh: "2026-08-16T08:54:45Z"
  });
const apiKeyAuth = JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "placeholder-key" });

let dir: string;
let boxHome: string;
let isolatedHome: string;

function provision(env: Record<string, string> = {}): string {
  return execFileSync("node", [PROVISION], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: isolatedHome,
      GARRISON_CODEX_HOME: boxHome,
      ...env
    }
  });
}

const isolatedAuth = (): string => path.join(isolatedHome, "auth.json");
const boxAuth = (): string => path.join(boxHome, "auth.json");

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "garrison-codex-link-"));
  boxHome = path.join(dir, "box-codex");
  isolatedHome = path.join(dir, "runtime-home");
  mkdirSync(boxHome, { recursive: true });
  writeFileSync(boxAuth(), chatgptAuth());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("rotating-credential detection", () => {
  it("calls an OAuth subscription login rotating, and a bare API key not", () => {
    const chatgpt = parseAuthFile("openai", chatgptAuth());
    const apiKey = parseAuthFile("openai", apiKeyAuth);
    expect(chatgpt.ok && apiKey.ok).toBe(true);
    if (!chatgpt.ok || !apiKey.ok) return;

    expect(isRotatingCredential(chatgpt.value)).toBe(true);
    expect(isRotatingCredential(apiKey.value)).toBe(false);
  });

  it("sees a top-level refresh_token too (Gemini's shape)", () => {
    const gemini = parseAuthFile("google", JSON.stringify({ access_token: "at", refresh_token: "rt" }));
    expect(gemini.ok).toBe(true);
    if (!gemini.ok) return;
    expect(isRotatingCredential(gemini.value)).toBe(true);
  });
});

describe("provisioning an isolated CODEX_HOME", () => {
  it("links the box credential instead of copying it", () => {
    const out = provision();

    expect(out).toContain("codex-runtime-ready");
    expect(lstatSync(isolatedAuth()).isSymbolicLink()).toBe(true);
    expect(readlinkSync(isolatedAuth())).toBe(boxAuth());
  });

  it("is idempotent — a second run leaves the same link", () => {
    provision();
    const out = provision();

    expect(out).toContain("already linked");
    expect(lstatSync(isolatedAuth()).isSymbolicLink()).toBe(true);
  });

  it("propagates a re-login through the link, so the two homes cannot diverge", () => {
    provision();
    // What `codex login` does to the box file — verified live: the CLI writes
    // THROUGH the symlink, so this is the real post-login state.
    writeFileSync(boxAuth(), chatgptAuth("acc-after-relogin"));

    expect(JSON.parse(readFileSync(isolatedAuth(), "utf8")).tokens.account_id).toBe("acc-after-relogin");
  });

  it("REPAIRS a home already holding a duplicate copy (the shipped bug)", () => {
    mkdirSync(isolatedHome, { recursive: true });
    // A stale copy of the same identity: the exact landmine the old copy-based
    // setup left behind, and the thing whose next refresh revokes the box login.
    writeFileSync(isolatedAuth(), chatgptAuth());

    const out = provision();

    expect(out).toContain("replaced a duplicate copy with a link");
    expect(lstatSync(isolatedAuth()).isSymbolicLink()).toBe(true);
    expect(readlinkSync(isolatedAuth())).toBe(boxAuth());
  });

  it("never clobbers a credential belonging to a DIFFERENT identity", () => {
    mkdirSync(isolatedHome, { recursive: true });
    const foreign = chatgptAuth("someone-elses-account");
    writeFileSync(isolatedAuth(), foreign);

    const out = provision();

    expect(out).toContain("WARN");
    expect(lstatSync(isolatedAuth()).isSymbolicLink()).toBe(false);
    expect(readFileSync(isolatedAuth(), "utf8")).toBe(foreign);
  });

  it("seeds config.toml once (settings are per-instance) and never overwrites it", () => {
    writeFileSync(path.join(boxHome, "config.toml"), 'model = "gpt-5-codex"\n');
    provision();
    expect(readFileSync(path.join(isolatedHome, "config.toml"), "utf8")).toContain("gpt-5-codex");

    writeFileSync(path.join(isolatedHome, "config.toml"), 'model = "instance-local"\n');
    provision();
    expect(readFileSync(path.join(isolatedHome, "config.toml"), "utf8")).toContain("instance-local");
  });

  it("does not fail `up` when the box has no Codex login yet", () => {
    rmSync(boxAuth());

    const out = provision();

    expect(out).toContain("codex-runtime-ready");
    expect(out).toContain("codex login");
    expect(existsSync(isolatedAuth())).toBe(false);
  });

  it("leaves the box's own home alone when it IS the CODEX_HOME", () => {
    const out = provision({ CODEX_HOME: boxHome });

    expect(out).toContain("the box's own home");
    expect(lstatSync(boxAuth()).isSymbolicLink()).toBe(false);
  });
});

describe("importing the box's native login as an account", () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = mkdtempSync(path.join(tmpdir(), "garrison-codex-import-"));
    process.env.GARRISON_HOME = vaultDir;
    process.env.GARRISON_VAULT_PATH = path.join(vaultDir, "vault.json");
    (globalThis as unknown as { __agentGarrisonVault?: unknown }).__agentGarrisonVault = undefined;
    resetMasterKeyCache();
    await unlockVault();
  });

  afterEach(() => {
    delete process.env.GARRISON_HOME;
    delete process.env.GARRISON_VAULT_PATH;
    delete process.env.GARRISON_CODEX_HOME;
    (globalThis as unknown as { __agentGarrisonVault?: unknown }).__agentGarrisonVault = undefined;
    resetMasterKeyCache();
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it("refuses a rotating OAuth login, and says what to do instead", async () => {
    process.env.GARRISON_CODEX_HOME = boxHome;

    await expect(
      importNativeLogin({ name: "codex-pro", platform: "openai" })
    ).rejects.toThrow(/rotating .* login, which cannot be adopted as an account/);
    await expect(
      importNativeLogin({ name: "codex-pro", platform: "openai" })
    ).rejects.toThrow(/Machine login[\s\S]*Device login/);
  });

  it("still refuses before writing anything to the vault", async () => {
    process.env.GARRISON_CODEX_HOME = boxHome;

    await importNativeLogin({ name: "codex-pro", platform: "openai" }).catch(() => undefined);

    const vault = path.join(vaultDir, "vault.json");
    const sealed = existsSync(vault) ? readFileSync(vault, "utf8") : "";
    expect(sealed).not.toContain("codex-pro");
  });
});
