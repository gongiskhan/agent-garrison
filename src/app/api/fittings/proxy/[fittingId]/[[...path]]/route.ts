import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { garrisonDir } from "@/lib/claude-home";
import { isValidFittingId } from "@/lib/own-port-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A tethered node (csg) has no tailnet listener of its own, so its own-port
// views can only be reached through the ONE origin the tether already
// publishes: this app itself (AGENTS.md "Instances, ports, and deploying").
// This route proxies same-origin requests for
// /api/fittings/proxy/<fittingId>/<path> to that fitting's local loopback
// port, so the browser never needs a URL other than the page's own origin.
// HTTP/SSE only — a WebSocket upgrade cannot be forwarded from a Next.js
// route handler (no raw socket access), so views that depend on one
// (dev-env, drill) will load their page here but lose live-socket features
// until a true upgrade-capable proxy exists.

// Headers that are per-hop and must not be forwarded either direction —
// forwarding "connection"/"transfer-encoding" verbatim breaks HTTP/1.1
// framing on the far side.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer"
]);

async function targetPort(fittingId: string): Promise<number | null> {
  try {
    const raw = await readFile(path.join(garrisonDir(), "ui-fittings", `${fittingId}.json`), "utf8");
    const parsed = JSON.parse(raw) as { port?: number };
    return typeof parsed.port === "number" && Number.isFinite(parsed.port) ? parsed.port : null;
  } catch {
    return null;
  }
}

async function proxy(
  req: Request,
  { params }: { params: { fittingId: string; path?: string[] } }
): Promise<Response> {
  const { fittingId } = params;
  if (!isValidFittingId(fittingId)) {
    return NextResponse.json({ error: "invalid fittingId" }, { status: 400 });
  }
  const port = await targetPort(fittingId);
  if (port === null) {
    return NextResponse.json({ error: `${fittingId} is not running` }, { status: 502 });
  }

  const restPath = (params.path ?? []).map(encodeURIComponent).join("/");
  const search = new URL(req.url).search;
  const targetUrl = `http://127.0.0.1:${port}/${restPath}${search}`;

  const headers = new Headers(req.headers);
  headers.delete("host");
  for (const h of HOP_BY_HOP) headers.delete(h);

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      // @ts-expect-error -- Node's fetch requires this for streamed request bodies
      duplex: hasBody ? "half" : undefined,
      redirect: "manual"
    });
  } catch (err) {
    return NextResponse.json(
      { error: `proxy to ${fittingId} failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }

  const outHeaders = new Headers(upstream.headers);
  for (const h of HOP_BY_HOP) outHeaders.delete(h);
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

export {
  proxy as GET,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
  proxy as HEAD,
  proxy as OPTIONS
};
