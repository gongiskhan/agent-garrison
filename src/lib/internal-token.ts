import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// A per-machine internal capability token for server-to-server calls that return
// secrets (e.g. the connector auth-env route). It lives in a 0600 file only the
// user's own processes can read, so a casual local process cannot pull a
// connector's secrets/tokens out of the backend without it. (Defense-in-depth on
// the single-user localhost model; the file is the same trust boundary as the
// vault key file.)
function tokenPath(): string {
  const home = process.env.GARRISON_HOME ?? path.join(os.homedir(), ".garrison");
  return process.env.GARRISON_INTERNAL_TOKEN_PATH ?? path.join(home, "internal-token");
}

const cached = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

// Test seam — drop the in-process cache so a test can point at a fresh path.
export function resetInternalTokenCache(): void {
  cached.clear();
  pending.clear();
}

async function readOrCreateToken(file: string): Promise<string> {
  const cachedForFile = cached.get(file);
  try {
    // Enforce the trust boundary: reject a symlink (don't follow it), and only
    // accept a regular file whose mode is no broader than 0600 — repairing a
    // loosened mode rather than silently honoring a world/group-readable token.
    const st = await fs.lstat(file);
    if (st.isSymbolicLink()) {
      throw new Error("internal token path is a symlink");
    }
    if (st.isFile()) {
      if (st.mode & 0o077) {
        await fs.chmod(file, 0o600);
      }
      const existing = (await fs.readFile(file, "utf8")).trim();
      if (existing) {
        cached.set(file, existing);
        return existing;
      }
    }
  } catch {
    // recreate below
  }
  // If the file disappeared after this process cached it, restore the same
  // capability instead of rotating the token underneath already-running
  // children. A genuinely new token path receives a fresh capability.
  const token = cachedForFile ?? crypto.randomBytes(32).toString("hex");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.rm(file, { force: true }).catch(() => {});
  await fs.writeFile(file, token, { mode: 0o600 });
  await fs.chmod(file, 0o600);
  cached.set(file, token);
  return token;
}

// Read the token, creating it (0600) on first use. Calls for one token path are
// serialized so concurrent fitting starts cannot mint competing capabilities.
export async function getInternalToken(): Promise<string> {
  const file = tokenPath();
  const inFlight = pending.get(file);
  if (inFlight) return inFlight;

  const operation = readOrCreateToken(file);
  pending.set(file, operation);
  try {
    return await operation;
  } finally {
    if (pending.get(file) === operation) {
      pending.delete(file);
    }
  }
}

// Validate a presented token in constant time; false when absent/mismatched.
export async function verifyInternalToken(presented: string | null | undefined): Promise<boolean> {
  if (!presented) return false;
  const expected = await getInternalToken();
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
