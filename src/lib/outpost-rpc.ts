import { homedir } from "node:os";
import path from "node:path";

// Profile-shifted like every other port (dev 3702 / prod 4702 / codex 23702).
// This was a hardcoded 23702 with no env override, so the prod and dev apps
// both issued their outpost RPCs at the CODEX outpost host. The Python helpers
// (outpost-actions, vault-sync) already derived this from GARRISON_OUTPOST_PORT;
// this is the TS side catching up.
export const OUTPOST_HOST = `http://127.0.0.1:${
  process.env.GARRISON_OUTPOST_PORT?.trim() || String(3702 + Number(process.env.GARRISON_PORT_OFFSET ?? 0))
}`;

export function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") return path.join(homedir(), p.slice(2));
  return p;
}

export type Target = { kind: "local" } | { kind: "outpost"; name: string };

export function parseTarget(raw: string | null): Target {
  if (!raw || raw === "local") return { kind: "local" };
  const m = raw.match(/^outpost:(.+)$/);
  if (m) return { kind: "outpost", name: m[1] };
  return { kind: "local" };
}

export async function outpostRpc<T = unknown>(
  name: string,
  type: string,
  payload: unknown
): Promise<T> {
  const res = await fetch(
    `${OUTPOST_HOST}/outposts/${encodeURIComponent(name)}/rpc`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, payload }),
    }
  );
  if (!res.ok) throw new Error(`outpost RPC ${type} failed: HTTP ${res.status}`);
  const data = (await res.json()) as {
    ok: boolean;
    result?: { payload?: unknown };
    error?: string;
  };
  if (!data.ok) throw new Error(data.error ?? `outpost RPC ${type} failed`);
  return data.result?.payload as T;
}

export interface OutpostInfo {
  name: string;
  connected: boolean;
  lastHeartbeat?: number;
}

export async function listOutposts(): Promise<OutpostInfo[]> {
  const res = await fetch(`${OUTPOST_HOST}/outposts`, { cache: "no-store" });
  if (!res.ok) throw new Error(`failed to list outposts: HTTP ${res.status}`);
  const data = (await res.json()) as { outposts?: OutpostInfo[] };
  return data.outposts ?? [];
}
