import * as local from "./vault";
import { recordVaultAccess } from "./vault-audit";
import type { OAuthGrant, OAuthHealth } from "./vault";
import { stateEnrolled, withState, type StateClient } from "./state-client";

// Connector credentials have one authority. Enrolled nodes never consult or
// populate the local vault: a connection made on one node works on every node.
const grantPrefix = "GARRISON_OAUTH_";
function grantKey(id: string): string {
  return grantPrefix + Buffer.from(id, "utf8").toString("hex").toUpperCase();
}

export async function credentialNames(): Promise<string[]> {
  if (stateEnrolled()) return withState(async (c) => (await c.listSecretKeys()).map((s) => s.key));
  const view = await local.vaultView();
  if (!view.unlocked) throw new Error("Credential store unavailable");
  return (view.secrets ?? []).map((s) => s.key);
}

export async function scopedSecrets(keys: string[]): Promise<{ key: string; value: string }[]> {
  if (!stateEnrolled()) return local.scopedSecrets(keys);
  return withState(async (c) => Object.entries((await c.resolveSecrets(keys)).values).map(([key, value]) => ({ key, value })));
}

export async function writeConnectorSecrets(values: Record<string, string>): Promise<void> {
  if (stateEnrolled()) {
    await withState(async (c) => { for (const [key, value] of Object.entries(values)) await c.putSecret(key, value); });
    return;
  }
  const merged = new Map((await local.readVaultSecrets()).map((s) => [s.key, s.value]));
  for (const [key, value] of Object.entries(values)) merged.set(key, value);
  await local.writeVaultSecrets([...merged].map(([key, value]) => ({ key, value })));
}

// Refresh, connect and revoke share a mesh lease so a concurrent refresh cannot
// resurrect a revoked grant. Provider calls are bounded well below the lease.
export async function withCredentialLock<T>(key: string, work: (client: StateClient) => Promise<T>): Promise<T> {
  return withState(async (client) => {
    const deadline = Date.now() + 15_000;
    let lease = await client.acquireLease({ key: `credential:${key}`, ttlMs: 120_000 });
    while (!lease.granted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      lease = await client.acquireLease({ key: `credential:${key}`, ttlMs: 120_000 });
    }
    if (!lease.granted || !lease.holderToken) throw new Error("Credential update in progress; retry shortly");
    try { return await work(client); }
    finally { await client.releaseLease({ key: `credential:${key}`, holderToken: lease.holderToken }); }
  });
}

async function readGrant(client: StateClient, id: string): Promise<OAuthGrant | undefined> {
  const key = grantKey(id);
  const value = (await client.resolveSecrets([key])).values[key];
  if (!value) return undefined;
  const grant = JSON.parse(value) as OAuthGrant;
  if (typeof grant.accessToken !== "string") throw new Error("Invalid stored OAuth grant; reconnect required");
  return grant;
}

export async function setOAuthGrant(id: string, grant: OAuthGrant): Promise<void> {
  if (!stateEnrolled()) return local.setOAuthGrant(id, grant);
  await withCredentialLock(grantKey(id), async (c) => {
    const previous = await readGrant(c, id);
    await c.putSecret(grantKey(id), JSON.stringify({
      ...grant,
      refreshToken: grant.refreshToken ?? (previous?.status !== "revoked" ? previous?.refreshToken : undefined),
      status: "valid", obtainedAt: new Date().toISOString()
    }));
  });
  await recordVaultAccess({ connector: id, secrets: ["oauth"], action: "read", outcome: "ok", detail: "grant-stored-in-authority" });
}

export async function revokeOAuthGrant(id: string): Promise<void> {
  if (!stateEnrolled()) return local.revokeOAuthGrant(id);
  await withCredentialLock(grantKey(id), async (c) => {
    // A tombstone prevents local or delayed refresh state from reviving access.
    await c.putSecret(grantKey(id), JSON.stringify({ accessToken: "", status: "revoked" }));
  });
  await recordVaultAccess({ connector: id, secrets: ["oauth"], action: "revoke", outcome: "ok" });
}

function usable(grant: OAuthGrant | undefined): asserts grant is OAuthGrant {
  if (!grant || grant.status === "revoked" || !grant.accessToken) throw new Error("Connector is not connected; sign in again");
}
function expired(grant: OAuthGrant, skewSec: number): boolean {
  return !!grant.expiresAt && (!Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now() + skewSec * 1000);
}

export async function getAccessToken(id: string, skewSec = 60): Promise<string> {
  if (!stateEnrolled()) return local.getAccessToken(id, skewSec);
  const initial = await withState((c) => readGrant(c, id));
  usable(initial);
  if (!expired(initial, skewSec)) return initial.accessToken;
  return withCredentialLock(grantKey(id), async (c) => {
    const grant = await readGrant(c, id);
    usable(grant);
    if (!expired(grant, skewSec)) return grant.accessToken;
    if (!grant.refreshToken || !grant.tokenUrl) throw new Error("OAuth token expired; sign in again");
    const secrets = grant.clientSecretKey ? (await c.resolveSecrets([grant.clientSecretKey])).values : {};
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: grant.refreshToken });
    if (grant.clientId) body.set("client_id", grant.clientId);
    if (grant.clientSecretKey) {
      if (!secrets[grant.clientSecretKey]) throw new Error("OAuth app credential unavailable");
      body.set("client_secret", secrets[grant.clientSecretKey]);
    }
    const response = await fetch(grant.tokenUrl, { method: "POST", body, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`OAuth refresh failed (${response.status}); sign in again`);
    const token = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!token.access_token || typeof token.access_token !== "string") throw new Error("OAuth refresh returned no token");
    const next = { ...grant, accessToken: token.access_token, refreshToken: token.refresh_token ?? grant.refreshToken,
      expiresAt: new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString(), obtainedAt: new Date().toISOString() };
    await c.putSecret(grantKey(id), JSON.stringify(next));
    await recordVaultAccess({ connector: id, secrets: ["oauth"], action: "refresh", outcome: "ok" });
    return next.accessToken;
  });
}

export async function oauthHealth(): Promise<OAuthHealth[]> {
  if (!stateEnrolled()) return local.oauthHealth();
  return withState(async (c) => {
    const keys = (await c.listSecretKeys()).map((s) => s.key).filter((key) => key.startsWith(grantPrefix));
    if (!keys.length) return [];
    const values = (await c.resolveSecrets(keys)).values;
    return keys.filter((key) => values[key]).map((key) => {
      const grant = JSON.parse(values[key]) as OAuthGrant;
      const connector = Buffer.from(key.slice(grantPrefix.length), "hex").toString("utf8");
      const status = grant.status === "revoked" ? "revoked" : expired(grant, 0) && !grant.refreshToken ? "expired"
        : expired(grant, 300) ? "expiring" : "valid";
      return { connector, status, expiresAt: grant.expiresAt };
    });
  });
}
