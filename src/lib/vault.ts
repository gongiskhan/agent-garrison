import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, VAULT_PATH } from "./paths";
import { pathExists } from "./fs-utils";
import { writeFileAtomic, writeJsonAtomic } from "./atomic-write";
import { getVaultMasterKey, masterKeySource } from "./keychain";
import { recordVaultAccess } from "./vault-audit";
import type { MaskedVaultSecret, VaultSecret, VaultSecretUpdate } from "./types";
import { stateEnrolled, withState } from "./state-client";

// An OAuth grant the vault holds on a connector's behalf. The refresh token is
// stored sealed; getAccessToken auto-rotates an expired access token. A revoked
// grant flips the connector to "Reconnect".
export interface OAuthGrant {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string; // ISO; absent = non-expiring
  tokenUrl?: string; // refresh endpoint
  clientId?: string;
  clientSecretKey?: string; // name of a plain vault secret holding the client secret
  scopes?: string[];
  status?: "valid" | "revoked";
  obtainedAt?: string;
}

export interface OAuthHealth {
  connector: string;
  status: "valid" | "expiring" | "expired" | "revoked";
  expiresAt?: string;
}

// Vault file format. `kdf: "hkdf-sha256"` is the current keychain-sealed format
// (the per-file AES key is HKDF-derived from the keychain master key + the
// random per-file salt). `kdf: "scrypt"` is the legacy passphrase format, read
// only to MIGRATE an existing dev vault (decrypted with the legacy dev
// passphrase, then re-sealed under the keychain key).
interface VaultFile {
  version: 1;
  kdf: "hkdf-sha256" | "scrypt";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface VaultPlaintext {
  secrets: Record<string, string>;
  oauth?: Record<string, OAuthGrant>;
  updatedAt: string;
}

interface VaultRuntime {
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

// The vault file location, resolved at call-time so a sandbox (tests, an
// alternate Garrison home) can point it elsewhere via GARRISON_VAULT_PATH
// without clobbering the real data/vault.json. Defaults to the canonical path.
function vaultFilePath(): string {
  if (process.env.GARRISON_VAULT_PATH) return process.env.GARRISON_VAULT_PATH;
  // An alternate Garrison home is an isolation boundary, not merely a place
  // for status files. Reusing the repository vault with a different home's
  // master key makes the isolated instance both collide and fail to unlock.
  if (process.env.GARRISON_HOME) return path.join(process.env.GARRISON_HOME, "vault.json");
  return VAULT_PATH;
}

// Legacy dev passphrase — used ONLY to migrate an existing scrypt-format vault
// that was written by the retired dev-unlock path. No passphrase is ever used
// to seal a vault going forward (decision F1: keychain-only).
const LEGACY_DEV_PASSPHRASE = "__GARRISON_DEV_UNLOCK__";

// VAULT_UNLOCKED gates auto-unlock (headless/dev) — it is NOT a passphrase, just
// a "consider the vault unlocked this session" switch. The key always comes from
// the keychain.
export function isDevUnlock(): boolean {
  return process.env.VAULT_UNLOCKED === "true";
}

// Auto-unlock when VAULT_UNLOCKED is set and the vault is not yet loaded. Leaves
// the vault locked (no throw) when a legacy real-passphrase vault cannot be
// migrated with the keychain key — the user reconnects.
async function ensureUnlock(): Promise<void> {
  if (!isDevUnlock()) return;
  if (runtime().plaintext) return;
  try {
    await unlockVault();
  } catch {
    // Legacy vault sealed with a real passphrase we cannot recover; stay locked.
  }
}

// Unlock the vault using the keychain master key — NO passphrase. The legacy
// `passphrase` argument is accepted (and ignored) only so existing callers keep
// compiling; it is never used to derive a key.
export async function unlockVault(
  _passphrase?: string
): Promise<{ unlocked: boolean; configured: boolean; needsPassword: boolean; secrets: VaultSecret[] }> {
  await fs.mkdir(path.dirname(vaultFilePath()), { recursive: true }).catch(() => {});
  await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  const masterKey = await getVaultMasterKey();
  const state = runtime();

  if (!(await pathExists(vaultFilePath()))) {
    const plaintext: VaultPlaintext = { secrets: {}, updatedAt: new Date().toISOString() };
    await persist(masterKey, plaintext);
    state.plaintext = plaintext;
    return { unlocked: true, configured: true, needsPassword: false, secrets: [] };
  }

  const file = JSON.parse(await fs.readFile(vaultFilePath(), "utf8")) as VaultFile;
  const { plaintext, migrated } = await decryptAny(masterKey, file);
  state.plaintext = plaintext;
  if (migrated) {
    // Re-seal a legacy vault under the keychain key so future reads need no
    // passphrase.
    await persist(masterKey, plaintext);
  }
  return { unlocked: true, configured: true, needsPassword: false, secrets: secretsToArray(plaintext.secrets) };
}

export function vaultStatus(): { unlocked: boolean } {
  return { unlocked: Boolean(runtime().plaintext) };
}

export async function vaultView(): Promise<{
  unlocked: boolean;
  configured: boolean;
  needsPassword: boolean;
  devMode: boolean;
  keySource: string;
  secrets: VaultSecret[];
}> {
  await ensureUnlock();
  const devMode = isDevUnlock();
  const keySource = await masterKeySource();
  const state = runtime();
  if (state.plaintext) {
    return {
      unlocked: true,
      configured: true,
      needsPassword: false,
      devMode,
      keySource,
      secrets: secretsToArray(state.plaintext.secrets)
    };
  }
  if (await pathExists(vaultFilePath())) {
    return { unlocked: false, configured: true, needsPassword: false, devMode, keySource, secrets: [] };
  }
  return { unlocked: true, configured: false, needsPassword: false, devMode, keySource, secrets: [] };
}

export async function readVaultSecrets(): Promise<VaultSecret[]> {
  await ensureUnlock();
  const state = runtime();
  if (!state.plaintext) {
    throw new Error("Vault is locked");
  }
  return secretsToArray(state.plaintext.secrets);
}

// ── Masked HTTP surface ──────────────────────────────────────────────────────
// Everything below exists because the vault's plaintext must not ride a routine
// page load. See MaskedVaultSecret in types.ts for the why.

// Head+tail hint. Deliberately lossy: at most 8 characters of a value ever
// appear, and only for a value long enough that they cannot reconstruct it. A
// short value (<= 12 chars) shows nothing but its length, because head+tail of
// a short secret IS the secret.
export function maskSecretValue(value: string): string {
  if (!value) return "";
  const len = value.length;
  if (len <= 12) return `••••• (${len} chars)`;
  // Collapse whitespace in the hint. Several real secrets are pretty-printed
  // JSON (Google/OpenAI service accounts), whose head and tail are newlines and
  // indentation — rendered raw in a single-line input they read as mangled
  // punctuation rather than a recognisable fingerprint. Length still comes from
  // the ORIGINAL value.
  const flat = value.replace(/\s+/g, " ");
  return `${flat.slice(0, 4)}…${flat.slice(-4)} (${len} chars)`;
}

export function maskSecrets(secrets: readonly VaultSecret[]): MaskedVaultSecret[] {
  return secrets.map((secret) => ({
    key: secret.key,
    set: secret.value.length > 0,
    preview: maskSecretValue(secret.value)
  }));
}

// The vault as the HTTP layer may describe it: same envelope as vaultView(),
// with `secrets` masked. Server-side callers that genuinely need plaintext
// (materializeEnv, scopedSecrets, spawn redaction) keep calling vaultView /
// readVaultSecrets directly — this is the wire boundary, not a new store.
export async function vaultViewMasked(): Promise<{
  unlocked: boolean;
  configured: boolean;
  needsPassword: boolean;
  devMode: boolean;
  keySource: string;
  secrets: MaskedVaultSecret[];
}> {
  const view = await vaultView();
  const secrets = maskSecrets(view.secrets);
  if (stateEnrolled()) {
    // Mesh: the authority's keys are the ones up() renders from, so the Vault
    // surface lists them even though their values never leave dev-madrid.
    const local = new Set(secrets.map((s) => s.key));
    const held = await withState((client) => client.listSecretKeys());
    for (const row of held) {
      if (!local.has(row.key)) secrets.push({ key: row.key, set: true, preview: MESH_HELD_PREVIEW });
    }
    secrets.sort((a, b) => a.key.localeCompare(b.key));
  }
  return { ...view, secrets };
}

// What the Vault surface shows for a key the mesh authority holds and this
// node's local file does not. Not a mask of the value: the value is never here.
export const MESH_HELD_PREVIEW = "held by the mesh (dev-madrid)";

// Reveal exactly ONE value, by name, and record it. Bulk extraction is the
// thing being prevented; a named single read is the legitimate case (the user
// clicking "reveal" on a row, or copying a credential out).
//
// This is NOT authentication — the app has no auth layer, so a caller that can
// reach the API can still reveal keys one at a time. What it buys is that
// secrets no longer ride an ordinary GET (browser history, caches, screenshots,
// a shared screen, an errant log), and that every plaintext read is attributable
// in the audit log. Real access control is an app-level concern.
export async function revealVaultSecret(key: string): Promise<string | null> {
  await ensureUnlock();
  const state = runtime();
  if (!state.plaintext) throw new Error("Vault is locked");
  const name = key.trim();
  const has = Object.prototype.hasOwnProperty.call(state.plaintext.secrets, name);
  await recordVaultAccess({
    connector: "ui:vault",
    secrets: [name],
    action: "read",
    outcome: has ? "ok" : "denied",
    detail: has ? "plaintext revealed over HTTP" : "no such secret"
  });
  return has ? state.plaintext.secrets[name] : null;
}

// Apply a partial update. An entry whose `value` is ABSENT keeps whatever is
// stored, so a UI holding masks can round-trip a full list (add / rename /
// remove rows) without ever having seen the plaintext. Keys absent from
// `updates` entirely are DELETED — the list is still authoritative about which
// secrets exist, exactly as the old whole-array PUT was.
//
// Mesh (2026-09-04): the state service on dev-madrid is the secret authority
// every node's up() and every own-port fitting renders from; this file is the
// standalone store, which the mesh leaves empty. The Vault surface used to
// write only this file, so a key saved here after enrolment (the ElevenLabs
// key on dev-madrid) reached no node, its own included. An enrolled node now
// writes through: every value the user saves goes to the authority FIRST (an
// unreachable authority fails the save loudly, nothing half-written), then to
// this file. Removing a row does not delete from the authority - a page that
// never listed a mesh key must not be able to drop it - so the row comes back
// on reload; a mesh secret is deleted through the state service.
export async function applyVaultSecretUpdates(
  updates: readonly VaultSecretUpdate[]
): Promise<MaskedVaultSecret[]> {
  await ensureUnlock();
  if (!runtime().plaintext) await unlockVault();
  const enrolled = stateEnrolled();
  if (enrolled) {
    const changed = updates.flatMap((u) =>
      u.key.trim() && typeof u.value === "string" ? [{ key: u.key.trim(), value: u.value }] : []
    );
    if (changed.length > 0) {
      await withState(async (client) => {
        for (const u of changed) await client.putSecret(u.key, u.value);
      });
    }
  }
  const existing = runtime().plaintext?.secrets ?? {};
  const merged: VaultSecret[] = [];
  for (const update of updates) {
    const key = update.key.trim();
    if (!key) continue;
    if (update.value === undefined) {
      // A round-tripped row keeps what is stored. A key this file never held
      // (a mesh-held row) is not invented as "" on an enrolled node.
      if (Object.prototype.hasOwnProperty.call(existing, key)) merged.push({ key, value: existing[key] });
      else if (!enrolled) merged.push({ key, value: "" });
      continue;
    }
    merged.push({ key, value: update.value });
  }
  const written = await writeVaultSecrets(merged);
  if (!enrolled) return maskSecrets(written);
  return (await vaultViewMasked()).secrets;
}

export async function writeVaultSecrets(secrets: VaultSecret[]): Promise<VaultSecret[]> {
  await ensureUnlock();
  const state = runtime();
  if (!state.plaintext) {
    // Auto-create on first write when the keychain key is available (no
    // passphrase prompt). Mirrors unlockVault's create path.
    await unlockVault();
  }
  const masterKey = await getVaultMasterKey();
  const sanitized = Object.fromEntries(
    secrets
      .map((secret) => [secret.key.trim(), secret.value] as const)
      .filter(([key]) => key.length > 0)
  );
  const plaintext: VaultPlaintext = {
    secrets: sanitized,
    // Preserve OAuth grants — writing the plain-secret map must not drop them.
    oauth: runtime().plaintext?.oauth,
    updatedAt: new Date().toISOString()
  };
  await persist(masterKey, plaintext);
  runtime().plaintext = plaintext;
  return secretsToArray(sanitized);
}

// ── Per-connector scoping (A2) ───────────────────────────────────────────────
// Return ONLY the named secrets — the real per-connector scoping that replaces
// the historical all-or-nothing delivery. A connector declares the secrets it
// may read in x-garrison.secret_scope; only those materialize into its process.
export async function scopedSecrets(scope: readonly string[]): Promise<VaultSecret[]> {
  await ensureUnlock();
  const state = runtime();
  if (!state.plaintext) {
    throw new Error("Vault is locked");
  }
  const set = new Set(scope);
  const filtered = Object.fromEntries(
    Object.entries(state.plaintext.secrets).filter(([key]) => set.has(key))
  );
  return secretsToArray(filtered);
}

// Snapshot of current secret VALUES (plain secrets + OAuth tokens) for JIT
// redaction in logs / run records. Sync + tolerant: returns [] when locked.
export function currentSecretValuesSync(): string[] {
  const pt = runtime().plaintext;
  if (!pt) return [];
  const values = Object.values(pt.secrets);
  for (const grant of Object.values(pt.oauth ?? {})) {
    if (grant.accessToken) values.push(grant.accessToken);
    if (grant.refreshToken) values.push(grant.refreshToken);
  }
  return values;
}

// ── OAuth refresh + rotation (A2) ────────────────────────────────────────────
type OAuthRefresher = (
  grant: OAuthGrant,
  clientSecret?: string
) => Promise<{ accessToken: string; expiresInSec?: number; refreshToken?: string }>;

let oauthRefresher: OAuthRefresher = defaultHttpRefresher;

// Per-connector in-flight refresh lock. Concurrent getAccessToken calls for the
// same expired connector would otherwise each POST the refresh token; with a
// rotating refresh token that races and loses the new token. The second caller
// awaits the first's refresh instead.
const refreshLocks = new Map<string, Promise<string>>();

// Injection seam — a test (or a connector with a non-standard refresh flow)
// swaps the refresher. Passing null restores the default HTTP refresher.
export function setOAuthRefresher(fn: OAuthRefresher | null): void {
  oauthRefresher = fn ?? defaultHttpRefresher;
}

async function defaultHttpRefresher(
  grant: OAuthGrant,
  clientSecret?: string
): Promise<{ accessToken: string; expiresInSec?: number; refreshToken?: string }> {
  if (!grant.tokenUrl || !grant.refreshToken) {
    throw new Error("OAuth grant missing tokenUrl/refreshToken");
  }
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", grant.refreshToken);
  if (grant.clientId) body.set("client_id", grant.clientId);
  if (clientSecret) body.set("client_secret", clientSecret);
  const res = await fetch(grant.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!res.ok) {
    throw new Error(`OAuth refresh failed: ${res.status}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in?: number; refresh_token?: string };
  return { accessToken: json.access_token, expiresInSec: json.expires_in, refreshToken: json.refresh_token };
}

async function mutatePlaintext(fn: (pt: VaultPlaintext) => void): Promise<void> {
  await ensureUnlock();
  if (!runtime().plaintext) {
    await unlockVault();
  }
  const pt = runtime().plaintext;
  if (!pt) throw new Error("Vault is locked");
  fn(pt);
  pt.updatedAt = new Date().toISOString();
  await persist(await getVaultMasterKey(), pt);
}

export async function setOAuthGrant(connector: string, grant: OAuthGrant): Promise<void> {
  await mutatePlaintext((pt) => {
    pt.oauth = {
      ...(pt.oauth ?? {}),
      [connector]: { status: "valid", obtainedAt: new Date().toISOString(), ...grant }
    };
  });
  await recordVaultAccess({ connector, secrets: ["oauth"], action: "read", outcome: "ok", detail: "grant-stored" });
}

export async function revokeOAuthGrant(connector: string): Promise<void> {
  await mutatePlaintext((pt) => {
    const grant = pt.oauth?.[connector];
    if (grant) grant.status = "revoked";
  });
  await recordVaultAccess({ connector, secrets: ["oauth"], action: "revoke", outcome: "ok" });
}

// Return a valid access token for the connector, auto-refreshing an expired one.
// Throws (and audits "denied") when the grant is missing, revoked, or expired
// with no refresh token — the connector must be reconnected.
export async function getAccessToken(connector: string, skewSec = 60): Promise<string> {
  await ensureUnlock();
  const state = runtime();
  if (!state.plaintext) throw new Error("Vault is locked");
  const grant = state.plaintext.oauth?.[connector];
  if (!grant || grant.status === "revoked") {
    await recordVaultAccess({
      connector,
      secrets: ["oauth"],
      action: "denied",
      outcome: "denied",
      detail: grant ? "revoked" : "no-grant"
    });
    throw new Error(`Connector ${connector} is not connected (reconnect required)`);
  }
  const expired = grant.expiresAt ? Date.parse(grant.expiresAt) <= Date.now() + skewSec * 1000 : false;
  if (expired && grant.refreshToken) {
    const inFlight = refreshLocks.get(connector);
    if (inFlight) return inFlight;
    const refreshPromise = (async () => {
      try {
        const clientSecret = grant.clientSecretKey ? state.plaintext!.secrets[grant.clientSecretKey] : undefined;
        const refreshed = await oauthRefresher(grant, clientSecret);
        const next: OAuthGrant = {
          ...grant,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? grant.refreshToken,
          expiresAt: refreshed.expiresInSec
            ? new Date(Date.now() + refreshed.expiresInSec * 1000).toISOString()
            : grant.expiresAt,
          obtainedAt: new Date().toISOString(),
          status: "valid"
        };
        await mutatePlaintext((pt) => {
          pt.oauth = { ...(pt.oauth ?? {}), [connector]: next };
        });
        await recordVaultAccess({ connector, secrets: ["oauth"], action: "refresh", outcome: "ok" });
        return next.accessToken;
      } finally {
        refreshLocks.delete(connector);
      }
    })();
    refreshLocks.set(connector, refreshPromise);
    return refreshPromise;
  }
  if (expired && !grant.refreshToken) {
    await recordVaultAccess({
      connector,
      secrets: ["oauth"],
      action: "denied",
      outcome: "denied",
      detail: "expired-no-refresh"
    });
    throw new Error(`Connector ${connector} token expired and cannot refresh (reconnect required)`);
  }
  await recordVaultAccess({ connector, secrets: ["oauth"], action: "read", outcome: "ok" });
  return grant.accessToken;
}

export async function oauthHealth(): Promise<OAuthHealth[]> {
  await ensureUnlock();
  const oauth = runtime().plaintext?.oauth ?? {};
  return Object.entries(oauth).map(([connector, grant]) => {
    let status: OAuthHealth["status"] = "valid";
    if (grant.status === "revoked") {
      status = "revoked";
    } else if (grant.expiresAt) {
      const ms = Date.parse(grant.expiresAt) - Date.now();
      if (ms <= 0) status = "expired";
      else if (ms < 5 * 60 * 1000) status = "expiring";
    }
    return { connector, status, expiresAt: grant.expiresAt };
  });
}

export async function materializeEnv(compositionDir: string): Promise<string> {
  await ensureUnlock();
  const state = runtime();
  const envPath = path.join(compositionDir, ".env");
  if (!state.plaintext) {
    if (await pathExists(vaultFilePath())) {
      throw new Error("Vault is locked. Unlock it in the Vault tab before running.");
    }
    await writeFileAtomic(envPath, "", { mode: 0o600 });
    return envPath;
  }
  const lines = Object.entries(state.plaintext.secrets)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${quoteEnvValue(value)}`);
  await writeFileAtomic(envPath, lines.length ? `${lines.join("\n")}\n` : "", { mode: 0o600 });
  return envPath;
}

export async function wipeMaterializedEnv(
  compositionDir: string,
  options: { strict?: boolean } = {}
): Promise<void> {
  const envPath = path.join(compositionDir, ".env");
  try {
    await fs.rm(envPath, { force: true });
  } catch (error) {
    if (options.strict) throw error;
    // Best effort cleanup; callers log the stop result.
  }
}

async function persist(masterKey: Buffer, plaintext: VaultPlaintext): Promise<void> {
  const encrypted = encryptVault(masterKey, plaintext);
  await writeJsonAtomic(vaultFilePath(), encrypted, { mode: 0o600 });
}

function encryptVault(masterKey: Buffer, plaintext: VaultPlaintext): VaultFile {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveFileKey(masterKey, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    kdf: "hkdf-sha256",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

// Decrypt either format; `migrated` is true when a legacy scrypt vault was read
// so the caller re-seals it under the keychain key.
async function decryptAny(
  masterKey: Buffer,
  file: VaultFile
): Promise<{ plaintext: VaultPlaintext; migrated: boolean }> {
  if (file.version !== 1) {
    throw new Error("Unsupported vault format");
  }
  if (file.kdf === "hkdf-sha256") {
    return { plaintext: decryptWithFileKey(deriveFileKey(masterKey, Buffer.from(file.salt, "base64")), file), migrated: false };
  }
  if (file.kdf === "scrypt") {
    // Legacy passphrase format — migrate it. Only the retired dev passphrase is
    // recoverable; a real-passphrase vault throws (the user reconnects).
    const legacyKey = await legacyScryptKey(LEGACY_DEV_PASSPHRASE, Buffer.from(file.salt, "base64"));
    return { plaintext: decryptWithFileKey(legacyKey, file), migrated: true };
  }
  throw new Error("Unsupported vault format");
}

function decryptWithFileKey(key: Buffer, file: VaultFile): VaultPlaintext {
  const iv = Buffer.from(file.iv, "base64");
  const tag = Buffer.from(file.tag, "base64");
  const ciphertext = Buffer.from(file.ciphertext, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const raw = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  return JSON.parse(raw) as VaultPlaintext;
}

// HKDF-SHA256 derives the per-file AES key from the high-entropy keychain master
// key + the random per-file salt. (HKDF is the right KDF for a high-entropy
// input — scrypt's work factor only matters for low-entropy passphrases, which
// the keychain model no longer uses.)
function deriveFileKey(masterKey: Buffer, salt: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", masterKey, salt, Buffer.from("garrison-vault-v2"), 32));
}

function legacyScryptKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(passphrase, salt, 32, { N: 16384, r: 8, p: 1 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
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
