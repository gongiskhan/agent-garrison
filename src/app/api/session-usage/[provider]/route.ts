import { NextResponse } from "next/server";
import { sessionUsage } from "@/lib/session-usage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, {params}: {params:{provider:string}}) {
  const {provider} = params;
  if (!["claude", "codex", "cursor"].includes(provider)) return NextResponse.json({error:"Unknown usage provider"}, {status:400});
  return NextResponse.json({accounts:await sessionUsage(provider)}, {headers:{"cache-control":"no-store"}});
}
