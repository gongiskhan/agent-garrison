import { NextResponse } from "next/server";
import { readSelfSnapshot } from "@/lib/mesh/self-snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// This node's health snapshot, and Garrison's FIRST real health endpoint —
// before this, `garrison-redeploy.sh` probed `/api/compositions` as a proxy for
// "is the app back". Three readers:
//
//   - the scheduler daemon's node-beat, every 15s, which POSTs the body
//     verbatim to the state service as this node's `health`;
//   - the mesh UI, for this node's own row;
//   - the nightly convergence card's post-restart health poll.
//
// It answers WITHOUT the state service, on purpose: a node must be able to
// report that the authority is unreachable.
export async function GET() {
  try {
    return NextResponse.json(await readSelfSnapshot());
  } catch (err) {
    // Individual probes fault-isolate themselves; reaching here means node
    // identity itself is unreadable, which is a real failure to report.
    return NextResponse.json(
      { error: "self-snapshot-failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
