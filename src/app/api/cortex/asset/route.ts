import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/lib/http";
import { readCortexBase, readCortexKey } from "@/lib/cortex-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A run step's `screenshotUrl` is an address on the Cortex host, which is
// routinely machine-local (a dev stack on this box) - and the user's browser is
// almost never on this machine. An <img src> pointed straight at it is a blank
// pane remotely, and over the HTTPS tailnet endpoint a plain-http one is blocked
// as mixed content outright. It also usually needs the key, which must not reach
// the page. So the image travels back through Garrison: the client asks for a
// same-origin path and this route fetches the bytes.
//
// Confined to the configured Cortex origin. Without that check the query
// parameter is an open fetch primitive that would happily read any address this
// server can reach, credentialed.
const MAX_BYTES = 12 * 1024 * 1024;

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("url");
  if (!raw) return jsonError(new Error("url is required"), 400);

  const base = await readCortexBase();
  if (base.invalid) return jsonError(new Error(base.invalid), 400);
  if (!base.baseUrl) return jsonError(new Error("No Cortex base URL is configured"), 400);

  let target: URL;
  try {
    target = new URL(raw, `${base.baseUrl}/`);
  } catch {
    return jsonError(new Error(`"${raw}" is not a usable URL`), 400);
  }
  const baseOrigin = new URL(base.baseUrl).origin;
  if (target.origin !== baseOrigin) {
    return jsonError(
      new Error(`refusing to fetch ${target.origin}: only ${baseOrigin} is proxied`),
      400
    );
  }

  let key: string | null;
  try {
    key = await readCortexKey();
  } catch {
    key = null;
  }

  try {
    const upstream = await fetch(target, {
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        Accept: "image/*"
      },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000)
    });
    const contentType = upstream.headers.get("content-type") ?? "";
    if (!upstream.ok) {
      return jsonError(
        new Error(`${target.pathname} answered HTTP ${upstream.status} ${upstream.statusText}`),
        502
      );
    }
    if (!contentType.startsWith("image/")) {
      // Anything else would let this route relay arbitrary credentialed content
      // to the page under an <img>.
      return jsonError(new Error(`expected an image, got "${contentType || "no content-type"}"`), 415);
    }
    const bytes = await upstream.arrayBuffer();
    if (bytes.byteLength > MAX_BYTES) {
      return jsonError(new Error(`image is ${bytes.byteLength} bytes, over the proxy cap`), 413);
    }
    return new NextResponse(bytes, {
      status: 200,
      headers: { "Content-Type": contentType, "Cache-Control": "no-store" }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(new Error(`Could not fetch ${target.href}: ${message}`), 502);
  }
}
