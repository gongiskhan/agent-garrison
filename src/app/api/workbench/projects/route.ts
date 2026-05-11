import { NextResponse, type NextRequest } from "next/server";
import fsp from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const runtime = "nodejs";

const OUTPOST_HOST = "http://127.0.0.1:3702";
const DEFAULT_DEV_ROOT = "~/dev";

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") return path.join(homedir(), p.slice(2));
  return p;
}

function parseTarget(raw: string | null): { kind: "local" } | { kind: "outpost"; name: string } {
  if (!raw || raw === "local") return { kind: "local" };
  const m = raw.match(/^outpost:(.+)$/);
  if (m) return { kind: "outpost", name: m[1] };
  return { kind: "local" };
}

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
  const res = await fetch(
    `${OUTPOST_HOST}/outposts/${encodeURIComponent(outpostName)}/rpc`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "fs.list", payload: { path: resolvedRoot } }),
    }
  );
  if (!res.ok) {
    throw new Error(`outpost fs.list failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    ok: boolean;
    result?: { payload?: { entries?: FsEntry[] } };
    error?: string;
  };
  if (!data.ok) throw new Error(data.error ?? "outpost fs.list failed");
  const entries: FsEntry[] = data.result?.payload?.entries ?? [];
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
