import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, VAULT_PATH } from "./paths";
import { ensureDir, pathExists } from "./fs-utils";
import type { VaultSecret } from "./types";

interface VaultFile {
  version: 1;
  kdf: "scrypt";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface VaultPlaintext {
  secrets: Record<string, string>;
  updatedAt: string;
}

interface VaultRuntime {
  passphrase?: string;
  plaintext?: VaultPlaintext;
}

declare global {
  // eslint-disable-next-line no-var
  var __agentGarrisonVault: VaultRuntime | undefined;
}

function runtime(): VaultRuntime {
  globalThis.__agentGarrisonVault ??= {};
  return globalThis.__agentGarrisonVault;
}

// Fixed passphrase used only when VAULT_UNLOCKED=true is set in the
// environment. Picking a stable string lets the vault stay readable across
// restarts in dev without prompting the user for a password.
const DEV_PASSPHRASE = "__GARRISON_DEV_UNLOCK__";

export function isDevUnlock(): boolean {
  return process.env.VAULT_UNLOCKED === "true";
}

async function ensureDevUnlock(): Promise<void> {
  if (!isDevUnlock()) return;
  const state = runtime();
  if (state.plaintext && state.passphrase) return;
  await ensureDir(DATA_DIR);
  if (!(await pathExists(VAULT_PATH))) {
    const plaintext: VaultPlaintext = { secrets: {}, updatedAt: new Date().toISOString() };
    const file = await encryptVault(DEV_PASSPHRASE, plaintext);
    await fs.writeFile(VAULT_PATH, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.chmod(VAULT_PATH, 0o600);
    state.passphrase = DEV_PASSPHRASE;
    state.plaintext = plaintext;
    return;
  }
  const file = JSON.parse(await fs.readFile(VAULT_PATH, "utf8")) as VaultFile;
  try {
    const plaintext = await decryptVault(DEV_PASSPHRASE, file);
    state.passphrase = DEV_PASSPHRASE;
    state.plaintext = plaintext;
  } catch {
    // Existing vault was encrypted with a different (real) passphrase. Leave
    // it locked; the user can unlock it manually or unset VAULT_UNLOCKED.
  }
}

export async function unlockVault(
  passphrase: string
): Promise<{ unlocked: boolean; configured: boolean; needsPassword: boolean; secrets: VaultSecret[] }> {
  if (!passphrase) {
    throw new Error("Passphrase is required");
  }
  await ensureDir(DATA_DIR);
  if (!(await pathExists(VAULT_PATH))) {
    const plaintext: VaultPlaintext = { secrets: {}, updatedAt: new Date().toISOString() };
    const file = await encryptVault(passphrase, plaintext);
    await fs.writeFile(VAULT_PATH, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.chmod(VAULT_PATH, 0o600);
    runtime().passphrase = passphrase;
    runtime().plaintext = plaintext;
    return { unlocked: true, configured: true, needsPassword: false, secrets: [] };
  }

  const file = JSON.parse(await fs.readFile(VAULT_PATH, "utf8")) as VaultFile;
  const plaintext = await decryptVault(passphrase, file);
  runtime().passphrase = passphrase;
  runtime().plaintext = plaintext;
  await fs.chmod(VAULT_PATH, 0o600);
  return { unlocked: true, configured: true, needsPassword: false, secrets: secretsToArray(plaintext.secrets) };
}

export function vaultStatus(): { unlocked: boolean } {
  return { unlocked: Boolean(runtime().passphrase && runtime().plaintext) };
}

export async function vaultView(): Promise<{
  unlocked: boolean;
  configured: boolean;
  needsPassword: boolean;
  devMode: boolean;
  secrets: VaultSecret[];
}> {
  await ensureDevUnlock();
  const devMode = isDevUnlock();
  const state = runtime();
  if (state.plaintext) {
    return {
      unlocked: true,
      configured: true,
      needsPassword: false,
      devMode,
      secrets: secretsToArray(state.plaintext.secrets)
    };
  }
  if (await pathExists(VAULT_PATH)) {
    return { unlocked: false, configured: true, needsPassword: false, devMode, secrets: [] };
  }
  return { unlocked: true, configured: false, needsPassword: true, devMode, secrets: [] };
}

export async function readVaultSecrets(): Promise<VaultSecret[]> {
  await ensureDevUnlock();
  const state = runtime();
  if (!state.plaintext) {
    throw new Error("Vault is locked");
  }
  return secretsToArray(state.plaintext.secrets);
}

export async function writeVaultSecrets(secrets: VaultSecret[]): Promise<VaultSecret[]> {
  await ensureDevUnlock();
  const state = runtime();
  if (!state.passphrase || !state.plaintext) {
    throw new Error("Vault is locked");
  }
  const sanitized = Object.fromEntries(
    secrets
      .map((secret) => [secret.key.trim(), secret.value] as const)
      .filter(([key]) => key.length > 0)
  );
  state.plaintext = {
    secrets: sanitized,
    updatedAt: new Date().toISOString()
  };
  const encrypted = await encryptVault(state.passphrase, state.plaintext);
  await fs.writeFile(VAULT_PATH, JSON.stringify(encrypted, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.chmod(VAULT_PATH, 0o600);
  return secretsToArray(sanitized);
}

export async function materializeEnv(compositionDir: string): Promise<string> {
  await ensureDevUnlock();
  const state = runtime();
  if (!state.plaintext) {
    if (await pathExists(VAULT_PATH)) {
      throw new Error("Vault is locked. Unlock it in the Vault tab before running.");
    }
    const envPath = path.join(compositionDir, ".env");
    await fs.writeFile(envPath, "", { encoding: "utf8", mode: 0o600 });
    await fs.chmod(envPath, 0o600);
    return envPath;
  }
  const lines = Object.entries(state.plaintext.secrets)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${quoteEnvValue(value)}`);
  const envPath = path.join(compositionDir, ".env");
  await fs.writeFile(envPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(envPath, 0o600);
  return envPath;
}

export async function wipeMaterializedEnv(compositionDir: string): Promise<void> {
  const envPath = path.join(compositionDir, ".env");
  try {
    await fs.rm(envPath, { force: true });
  } catch {
    // Best effort cleanup; callers log the stop result.
  }
}

async function encryptVault(passphrase: string, plaintext: VaultPlaintext): Promise<VaultFile> {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(plaintext), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

async function decryptVault(passphrase: string, file: VaultFile): Promise<VaultPlaintext> {
  if (file.version !== 1 || file.kdf !== "scrypt") {
    throw new Error("Unsupported vault format");
  }
  const salt = Buffer.from(file.salt, "base64");
  const iv = Buffer.from(file.iv, "base64");
  const tag = Buffer.from(file.tag, "base64");
  const ciphertext = Buffer.from(file.ciphertext, "base64");
  const key = await deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const raw = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  return JSON.parse(raw) as VaultPlaintext;
}

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(passphrase, salt, 32, { N: 16384, r: 8, p: 1 }, (error, key) => {
      if (error) {
        reject(error);
      } else {
        resolve(key);
      }
    });
  });
}

function secretsToArray(secrets: Record<string, string>): VaultSecret[] {
  return Object.entries(secrets)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ key, value }));
}

function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@-]*$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}
