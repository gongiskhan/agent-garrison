import fs from "node:fs/promises";
import path from "node:path";
import { nodeBrandingDir } from "@/lib/node-identity";

// Serves this node's branded icons.
//
// Resolution order per file: $GARRISON_HOME/branding/<file> (written by
// scripts/node-branding.mjs at install time), then public/icons/<file>, then
// the generic shipped mark this name stands in for. So a checkout that never
// ran the installer still has a favicon and a dock icon - just an unbranded one.
//
// The URL names are `node-*` and NOT the names already in public/icons: Next
// serves a static public file BEFORE reaching a route handler at the same
// path, so `/icons/icon-192.png` here would never be invoked. Verified against
// Next 14 rather than assumed.
export const dynamic = "force-dynamic";

// Generic marks to fall back to, per branded name.
const SHIPPED_FALLBACK: Record<string, string> = {
  "node.svg": "icon.svg",
  "node-512.png": "icon-512.png",
  "node-192.png": "icon-192.png",
  "node-180.png": "apple-touch-icon.png",
  "node-32.png": "favicon-32.png",
  "node-16.png": "favicon-16.png"
};

const CONTENT_TYPE: Record<string, string> = {
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

// Lowercase, no dots beyond the extension, no separators - so `..`, `/`, `%2f`
// and absolute paths are all rejected before any path join happens.
const SAFE_NAME = /^[a-z0-9-]+\.(png|svg)$/;

async function readIfFile(file: string): Promise<Buffer | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return null;
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

export async function GET(
  _request: Request,
  { params }: { params: { file: string } }
): Promise<Response> {
  const file = params.file;
  if (!SAFE_NAME.test(file)) {
    return new Response("Not found", { status: 404 });
  }
  const type = CONTENT_TYPE[path.extname(file)];
  if (!type) return new Response("Not found", { status: 404 });

  const candidates = [path.join(nodeBrandingDir(), file), path.join(process.cwd(), "public", "icons", file)];
  const shipped = SHIPPED_FALLBACK[file];
  if (shipped) candidates.push(path.join(process.cwd(), "public", "icons", shipped));

  for (const candidate of candidates) {
    const body = await readIfFile(candidate);
    if (!body) continue;
    return new Response(new Uint8Array(body), {
      headers: {
        "content-type": type,
        // Re-branding a node must show up on the next load, not eventually -
        // a stale dock icon is exactly the confusion this slice removes.
        "cache-control": "public, max-age=0, must-revalidate"
      }
    });
  }
  return new Response("Not found", { status: 404 });
}
