import { randomBytes } from "node:crypto";

// Short-lived CSRF state for the OAuth authorization-code flow. The same Next
// server process handles /oauth-start and /oauth-callback, so an in-memory map is
// sufficient (localhost, single-user). State binds the callback to the connector
// the user actually started, and expires fast so a stale/forged state is rejected.
interface PendingState {
  connector: string;
  redirectUri: string;
  expiresAt: number;
}

const STATE_TTL_MS = 10 * 60 * 1000;
const pending = new Map<string, PendingState>();

function sweep(now: number) {
  for (const [k, v] of pending) if (v.expiresAt <= now) pending.delete(k);
}

export function createOAuthState(connector: string, redirectUri: string, now: number = Date.now()): string {
  sweep(now);
  const state = randomBytes(24).toString("base64url");
  pending.set(state, { connector, redirectUri, expiresAt: now + STATE_TTL_MS });
  return state;
}

// Consume a state ONCE: returns its binding iff valid + matches the connector, then
// deletes it (single-use, so a replayed callback fails).
export function consumeOAuthState(state: string, connector: string, now: number = Date.now()): PendingState | null {
  sweep(now);
  const entry = state ? pending.get(state) : undefined;
  if (!entry) return null;
  pending.delete(state);
  if (entry.connector !== connector || entry.expiresAt <= now) return null;
  return entry;
}

// Test-only reset.
export function _resetOAuthState() {
  pending.clear();
}
