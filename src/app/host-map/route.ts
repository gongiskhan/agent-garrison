import { NextResponse } from "next/server";
import { getTailnetServeMap } from "@/lib/tailnet-serve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same-origin serve map (localPort -> https tailnet URL) for the host-aware URL
// rewriter (src/lib/host-rewrite.ts). Root-relative so a client on this origin
// inherits this origin's `tailscale serve` mapping; mirrors the per-fitting
// /host-map endpoints. Empty when tailscale isn't serving (local dev).
export async function GET() {
  const map = await getTailnetServeMap();
  return NextResponse.json({ map: Object.fromEntries(map) });
}
