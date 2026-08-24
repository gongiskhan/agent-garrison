import { NextResponse } from "next/server";
import { listMeshProjects } from "@/lib/mesh/git-mesh";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ projects: listMeshProjects() });
}
