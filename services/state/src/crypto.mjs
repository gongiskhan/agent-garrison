// Per-row secret sealing for the state service.
//
// Same crypto substance as src/lib/vault.ts: AES-256-GCM, per-row random salt,
// row key HKDF-SHA256-derived from the machine master key. Per-row rather than
// one blob because the service resolves single keys constantly and a partial
// corruption then costs one secret rather than all of them.
//
// Master key resolution mirrors src/lib/keychain.ts's order, minus macOS
// (the service only ever runs on dev-madrid):
//   1. GARRISON_STATE_MASTER_KEY_HEX  (tests only)
//   2. Linux secret-tool (libsecret)
//   3. 0600 keyfile fallback at ~/.garrison/vault-master.key — the live path
//      on this box, shared with the vault so the importer can decrypt the
//      existing vault.json with the same key.

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const HKDF_INFO = "garrison-state-secret-v1";
let cachedKey = null;

export function getMasterKey() {
  if (cachedKey) return cachedKey;
  const testHex = process.env.GARRISON_STATE_MASTER_KEY_HEX?.trim();
  if (testHex) {
    const buf = Buffer.from(testHex, "hex");
    if (buf.length !== 32) throw new Error("GARRISON_STATE_MASTER_KEY_HEX must be 32 bytes of hex");
    cachedKey = buf;
    return cachedKey;
  }
  try {
    const out = execFileSync(
      "secret-tool",
      ["lookup", "service", "agent-garrison", "account", "vault-master-key"],
      { encoding: "utf8" }
    ).trim();
    if (out) {
      const buf = Buffer.from(out, "base64");
      if (buf.length === 32) {
        cachedKey = buf;
        return cachedKey;
      }
    }
  } catch {
    // No libsecret backend — fall through to the keyfile.
  }
  const keyfile = path.join(os.homedir(), ".garrison", "vault-master.key");
  const raw = readFileSync(keyfile, "utf8").trim();
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(`vault master keyfile at ${keyfile} did not decode to 32 bytes`);
  }
  cachedKey = buf;
  return cachedKey;
}

function deriveRowKey(masterKey, salt) {
  return Buffer.from(crypto.hkdfSync("sha256", masterKey, salt, HKDF_INFO, 32));
}

export function seal(value) {
  const masterKey = getMasterKey();
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveRowKey(masterKey, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64")
  });
}

export function unseal(ciphertext) {
  const masterKey = getMasterKey();
  const { salt, iv, tag, ct } = JSON.parse(ciphertext);
  const key = deriveRowKey(masterKey, Buffer.from(salt, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString(
    "utf8"
  );
}

export function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function timingSafeEqualHex(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
