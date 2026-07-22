import { NextResponse, type NextRequest } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { garrisonDir } from "@/lib/claude-home";
import { COMPOSITIONS_DIR } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same-origin file server for the host-aware file-path rewriter
// (src/lib/host-rewrite.ts filePathMarkedExtension): renders an operative
// reply's absolute paths (uploaded attachments under a composition's
// .garrison/uploads, run artifacts under ~/.garrison/runs) as inline images /
// links instead of dead text. Root-relative, so it inherits this origin's
// `tailscale serve` mapping. Confined by realpath to Garrison-owned roots; never
// trusts the raw client path.

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
};
const TEXT_MIME: Record<string, string> = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
};
// Never serve secrets even if they somehow land under a confined root.
const SENSITIVE = /(?:^|\/)(?:\.env(?:\.|$)|id_rsa|id_ed25519|[^/]*\.pem|vault\.json)|\/\.git\//i;

// Resolve `target` and require its realpath to stay within one of `roots`
// (realpath collapses any symlink in the chain, so a symlink can't escape).
async function realpathConfined(target: string, roots: string[]): Promise<string | null> {
  let real: string;
  try {
    real = await fs.realpath(target);
  } catch {
    return null;
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await fs.realpath(root);
    } catch {
      continue;
    }
    if (real === realRoot || real.startsWith(realRoot + path.sep)) return real;
  }
  return null;
}

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("path") ?? "";
  if (!raw || !path.isAbsolute(raw)) {
    return NextResponse.json({ error: "absolute path required" }, { status: 400 });
  }
  if (SENSITIVE.test(raw)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const roots = [garrisonDir(), COMPOSITIONS_DIR];
  const confined = await realpathConfined(raw, roots);
  if (!confined) {
    return NextResponse.json({ error: "not found or out of bounds" }, { status: 404 });
  }
  let stat;
  try {
    stat = await fs.stat(confined);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!stat.isFile()) {
    return NextResponse.json({ error: "not a file" }, { status: 404 });
  }
  const ext = path.extname(confined).toLowerCase();
  const image = IMAGE_MIME[ext];
  const text = TEXT_MIME[ext];
  const buf = await fs.readFile(confined);
  const headers = new Headers();
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  headers.set("Cache-Control", "private, max-age=60");
  if (image) {
    headers.set("Content-Type", image);
  } else if (text) {
    headers.set("Content-Type", text);
  } else {
    // Unknown / active types (incl. .svg, .html) are served inert as a download,
    // never as a navigable document.
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Disposition", `attachment; filename="${path.basename(confined).replace(/["\r\n]/g, "")}"`);
  }
  return new NextResponse(new Uint8Array(buf), { status: 200, headers });
}
