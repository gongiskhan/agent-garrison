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

let cached: string | undefined;

// Test seam — drop the in-process cache so a test can point at a fresh path.
export function resetInternalTokenCache(): void {
  cached = undefined;
}

// Read the token, creating it (0600) on first use.
export async function getInternalToken(): Promise<string> {
  if (cached) return cached;
  const file = tokenPath();
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
        cached = existing;
        return existing;
      }
    }
  } catch {
    // recreate below
  }
  const token = crypto.randomBytes(32).toString("hex");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.rm(file, { force: true }).catch(() => {});
  await fs.writeFile(file, token, { mode: 0o600 });
  await fs.chmod(file, 0o600);
  cached = token;
  return token;
}

// Validate a presented token in constant time; false when absent/mismatched.
export async function verifyInternalToken(presented: string | null | undefined): Promise<boolean> {
  if (!presented) return false;
  const expected = await getInternalToken();
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
