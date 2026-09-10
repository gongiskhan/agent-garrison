import { NextRequest, NextResponse } from "next/server";
import { improvementOverview, improvementDecision, setImprovementAutonomy, startImprovement, maintainImprovements, improvementProbe, deliverImprovementNotice } from "@/lib/improver";
export const dynamic="force-dynamic";
export const runtime="nodejs";
function failure(error:unknown) {
  const e=error as Error & {status?:number};
  return NextResponse.json({error:e.message||String(error)},{status:e.status||500});
}
export async function GET() {try{return NextResponse.json(await improvementOverview());}catch(error){return failure(error);}}
export async function POST(request:NextRequest) {
  try {
    const origin=request.headers.get("origin");
    if(origin && new URL(origin).host!==request.headers.get("host")) return NextResponse.json({error:"Cross-origin authoring is not allowed"},{status:403});
    const body=await request.json();
    if(body.action==="deliver-notice" && typeof body.id==="string") return NextResponse.json(await deliverImprovementNotice(body.id));
    if(body.action==="probe-deliver" || body.action==="probe-answer") return NextResponse.json(await improvementProbe(body));
    if(body.action==="maintain") return NextResponse.json(await maintainImprovements());
    if(body.action==="review" || body.action==="nightly") return NextResponse.json(await startImprovement(body,body.action==="nightly"?"nightly":"review"),{status:202});
    if(body.action==="decide" && typeof body.id==="string") return NextResponse.json(await improvementDecision(body));
    if(body.action==="autonomy") return NextResponse.json(await setImprovementAutonomy(body.track,body.mode));
    return NextResponse.json({error:"Unknown Improver action"},{status:400});
  }catch(error){return failure(error);}
}
