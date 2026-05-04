import { spawn } from "node:child_process";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { getLibraryEntry } from "@/lib/library";
import { ROOT_DIR } from "@/lib/paths";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const entry = await getLibraryEntry(String(body.id ?? ""));
    if (!entry) {
      throw new Error("Unknown library fitting");
    }

    const kind = body.kind === "repo" ? "repo" : "local";
    const target = kind === "repo" ? entry.ratings.github_stars_url ?? entry.repo : localTarget(entry);
    if (!target) {
      throw new Error(`No ${kind} source is available for ${entry.name}`);
    }

    const child = spawn("open", [target], { detached: true, stdio: "ignore" });
    child.unref();
    return NextResponse.json({ opened: target });
  } catch (error) {
    return jsonError(error, 400);
  }
}

function localTarget(entry: Awaited<ReturnType<typeof getLibraryEntry>>): string | undefined {
  if (!entry?.localPath) {
    return undefined;
  }
  const resolved = path.resolve(ROOT_DIR, entry.localPath);
  const root = path.resolve(ROOT_DIR);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Refusing to open a path outside the project");
  }
  return resolved;
}
