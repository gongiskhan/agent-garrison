import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

// The vault master key lives ONLY in the OS keychain — there is NO passphrase
// anywhere (decision F1). A passphrase is a stealable/phishable attack surface
// and a leaked one is unacceptable; losing keychain access in a catastrophic
// failure is an acceptable, recoverable loss (the vault is simply reconnected).
// So Garrison would rather be unrecoverable-if-the-keychain-is-gone than hold a
// secret someone could take.
const KEYCHAIN_SERVICE = "agent-garrison-vault";
const KEYCHAIN_ACCOUNT = "vault-master-key";
const MASTER_KEY_BYTES = 32;

let cachedKey: Buffer | undefined;

// Resolve the 32-byte vault master key (creating + persisting a fresh random one
// on first use). Resolution order:
//   1. GARRISON_VAULT_TEST_KEY — an explicit key for tests/CI (a KEY, not a
//      passphrase); never touches the OS keychain.
//   2. Test runtime (VITEST / NODE_ENV=test) — a deterministic per-process
//      ephemeral key so crypto roundtrips work without prompting the real
//      keychain.
//   3. OS keychain — macOS `security`, Linux `secret-tool` (libsecret).
//   4. Degraded fallback — a 0600 key file under the Garrison home, with a loud
//      warning (only when no keychain backend is available; still no passphrase).
export async function getVaultMasterKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  cachedKey = await resolveMasterKey();
  return cachedKey;
}

// Test seam — drop the in-process cache so a test can swap GARRISON_VAULT_TEST_KEY.
export function resetMasterKeyCache(): void {
  cachedKey = undefined;
}

// Which backend the master key resolves from — surfaced in the Vault UI so the
// user can see the sealed-key guarantee is actually in force.
export async function masterKeySource(): Promise<"test-env" | "test-ephemeral" | "keychain" | "keyfile"> {
  if (process.env.GARRISON_VAULT_TEST_KEY) return "test-env";
  if (process.env.VITEST || process.env.NODE_ENV === "test") return "test-ephemeral";
  if (process.platform === "darwin" || (process.platform === "linux" && (await hasSecretTool())))
    return "keychain";
  return "keyfile";
}

async function resolveMasterKey(): Promise<Buffer> {
  const explicit = process.env.GARRISON_VAULT_TEST_KEY;
  if (explicit && explicit.length > 0) return normalizeKey(explicit);

  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return crypto.createHash("sha256").update("garrison-vault-test-ephemeral").digest();
  }

  if (process.platform === "darwin") {
    const existing = await macReadKey();
    if (existing) return existing;
    const fresh = crypto.randomBytes(MASTER_KEY_BYTES);
    await macWriteKey(fresh);
    return fresh;
  }

  if (process.platform === "linux" && (await hasSecretTool())) {
    const existing = await secretToolRead();
    if (existing) return existing;
    const fresh = crypto.randomBytes(MASTER_KEY_BYTES);
    if (await secretToolWrite(fresh)) return fresh;
  }

  return keyfileFallback();
}

// Accept a hex (64 chars), base64 (decodes to 32 bytes), or any other string
// (hashed to 32 bytes) — so any test key string is usable.
function normalizeKey(s: string): Buffer {
  const trimmed = s.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  try {
    const b = Buffer.from(trimmed, "base64");
    if (b.length === MASTER_KEY_BYTES) return b;
  } catch {
    // fall through to hash
  }
  return crypto.createHash("sha256").update(trimmed).digest();
}

// ── macOS Keychain (security(1)) ────────────────────────────────────────────
async function macReadKey(): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE,
      "-w"
    ]);
    const hex = stdout.trim();
    return hex ? normalizeKey(hex) : null;
  } catch {
    // Non-zero exit = not found (or denied). Treat as absent.
    return null;
  }
}

async function macWriteKey(key: Buffer): Promise<void> {
  // -U updates the item if it already exists. The key is stored as hex in the
  // password field; the value never leaves the keychain except into this process.
  await execFileAsync("security", [
    "add-generic-password",
    "-a",
    KEYCHAIN_ACCOUNT,
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
    key.toString("hex"),
    "-U"
  ]);
}

// ── Linux libsecret (secret-tool) ───────────────────────────────────────────
async function hasSecretTool(): Promise<boolean> {
  try {
    await execFileAsync("secret-tool", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function secretToolRead(): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileAsync("secret-tool", [
      "lookup",
      "service",
      KEYCHAIN_SERVICE,
      "account",
      KEYCHAIN_ACCOUNT
    ]);
    const hex = stdout.trim();
    return hex ? normalizeKey(hex) : null;
  } catch {
    return null;
  }
}

async function secretToolWrite(key: Buffer): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(
        "secret-tool",
        ["store", "--label", "Agent Garrison vault master key", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT],
        { stdio: ["pipe", "ignore", "ignore"] }
      );
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
      child.stdin.write(key.toString("hex"));
      child.stdin.end();
    } catch {
      resolve(false);
    }
  });
}

// ── Degraded fallback (no keychain backend present) ──────────────────────────
async function keyfileFallback(): Promise<Buffer> {
  const dir = process.env.GARRISON_HOME ?? path.join(os.homedir(), ".garrison");
  const file = path.join(dir, "vault-master.key");
  try {
    const hex = (await fs.readFile(file, "utf8")).trim();
    if (hex) return normalizeKey(hex);
  } catch {
    // create below
  }
  const fresh = crypto.randomBytes(MASTER_KEY_BYTES);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, fresh.toString("hex"), { mode: 0o600 });
  await fs.chmod(file, 0o600);
  console.warn(
    "[garrison] No OS keychain backend available — vault master key stored in a 0600 key file. " +
      "Install a keychain (macOS Keychain / libsecret) for the sealed-key guarantee."
  );
  return fresh;
}
