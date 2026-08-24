import { NextResponse } from "next/server";
import { StateUnavailableError, stateDegraded, withState } from "@/lib/state-client";
import { readSelfSnapshot, type MeshSelfSnapshot } from "@/lib/mesh/self-snapshot";
import { mergeMeshRoster } from "@/lib/mesh/node-row";
import { resolveAccent } from "@/lib/node-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The mesh roster: every registered node, plus THIS node merged in from its own
// live snapshot rather than from the beat the registry last received.
//
// The proxy exists so the BROWSER never holds the state token. The token is a
// node credential; putting it in a page would make every tab a mesh peer.
//
// No cache and no fallback roster: when the state service is unreachable this
// returns 503 and the UI shows one degraded banner. A stale roster is worse
// than no roster — it invites acting on a node that left the mesh an hour ago.
// The merge itself lives in src/lib/mesh/node-row.ts; this route is transport.
// The palette is closed on purpose: resolveAccent takes a palette id, index, or
// palette hex and falls back to the id-derived accent for anything else. So a
// registry row seeded with a colour outside the palette still renders a stable,
// distinct, contrast-verified dot rather than a neutral placeholder.
const accentHex = (value: unknown, id: string) => resolveAccent(value, id).hex;

export async function GET() {
  // Gathered first and unconditionally: this node can describe itself whether
  // or not the authority answers, so the 503 body carries it too.
  let self: MeshSelfSnapshot | null = null;
  try {
    self = await readSelfSnapshot();
  } catch {
    self = null;
  }

  try {
    const registry = await withState((client) => client.listNodes());
    return NextResponse.json({ nodes: mergeMeshRoster(registry, self, accentHex), self, degraded: false });
  } catch (err) {
    if (err instanceof StateUnavailableError) {
      const { since } = stateDegraded();
      return NextResponse.json(
        { error: "state-unavailable", since: since ?? err.since ?? new Date().toISOString(), url: err.url, self },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: "mesh-nodes-failed", detail: err instanceof Error ? err.message : String(err), self },
      { status: 502 }
    );
  }
}
