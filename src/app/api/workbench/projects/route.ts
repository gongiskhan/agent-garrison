import { NextResponse, type NextRequest } from "next/server";
import fsp from "node:fs/promises";
import path from "node:path";
import { expandHome, parseTarget, outpostRpc } from "@/lib/outpost-rpc";

export const runtime = "nodejs";

const DEFAULT_DEV_ROOT = "~/dev";

interface FsEntry {
  name: string;
  type: "file" | "directory" | "symlink";
}

async function listLocalDirs(devRoot: string): Promise<string[]> {
  const root = expandHome(devRoot);
  const entries = await fsp.readdir(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => path.join(root, e.name))
    .sort();
}

async function listOutpostDirs(outpostName: string, devRoot: string): Promise<string[]> {
  const resolvedRoot = expandHome(devRoot);
  const payload = await outpostRpc<{ entries?: FsEntry[] }>(outpostName, "fs.list", {
    path: resolvedRoot,
  });
  const entries: FsEntry[] = payload?.entries ?? [];
  return entries
    .filter((e) => e.type === "directory" || e.type === "symlink")
    .map((e) => path.join(resolvedRoot, e.name))
    .sort();
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const rawTarget = params.get("target");
  const devRoot = params.get("devRoot") ?? DEFAULT_DEV_ROOT;
  const target = parseTarget(rawTarget);

  try {
    let projects: string[];
    if (target.kind === "local") {
      projects = await listLocalDirs(devRoot);
    } else {
      projects = await listOutpostDirs(target.name, devRoot);
    }
    return NextResponse.json({ projects });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
