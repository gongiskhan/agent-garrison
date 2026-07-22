// Per-project auth session bookkeeping for Drill runs. The browser fitting's
// persistent profile is the real session cache — cookies/localStorage survive
// across runs — so this file holds no credentials and no cookies. It records
// only WHEN Drill last established a good session for a project, so a Book with
// `auth.cacheMinutes` can proactively re-run the full login flow once the
// session ages out (rather than expiring mid-run), and so the UI can show
// "last authenticated". Keyed by a hash of the project root; a fingerprint of
// the Book's auth config invalidates a prior record when the login changes.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { drillHomeDir } from "./runs-store.mjs";

function authDir() {
  return path.join(drillHomeDir(), "auth");
}

function authStateFile(root) {
  const hash = createHash("sha256").update(String(root ?? "")).digest("hex").slice(0, 16);
  return path.join(authDir(), `${hash}.json`);
}

// A stable fingerprint of the Book's auth config: changing the login URL,
// steps, or success signal invalidates a prior "fresh" record so the TTL
// short-circuit never trusts a session established under a different login.
export function authFingerprint(auth) {
  if (!auth || typeof auth !== "object") return "none";
  return createHash("sha256")
    .update(JSON.stringify({ loginPath: auth.loginPath ?? null, steps: auth.steps ?? [], success: auth.success ?? null }))
    .digest("hex")
    .slice(0, 16);
}

export async function readAuthState(root) {
  try {
    return JSON.parse(await fs.readFile(authStateFile(root), "utf8"));
  } catch {
    return null;
  }
}

export async function writeAuthState(root, state) {
  const file = authStateFile(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tmp, file);
  return state;
}
