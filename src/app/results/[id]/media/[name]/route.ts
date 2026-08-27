import { NextResponse, type NextRequest } from "next/server";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { contentTypeFor, isSafeMediaName, mediaDir } from "@/lib/results-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Confined artifact serving. Records reference media by RELATIVE name only;
// bytes leave exclusively through here, and a realpath check keeps a symlinked
// run dir from escaping the media folder. Same discipline as drill's
// evidence-file route.
export async function GET(request: NextRequest, { params }: { params: { id: string; name: string } }) {
  const name = decodeURIComponent(params.name);
  if (!isSafeMediaName(name)) return NextResponse.json({ error: "invalid media name" }, { status: 400 });

  let dir: string;
  try {
    dir = mediaDir(params.id);
  } catch {
    return NextResponse.json({ error: "invalid run id" }, { status: 400 });
  }

  let file: string;
  let size: number;
  try {
    const realDir = await fs.realpath(dir);
    const real = await fs.realpath(path.join(dir, name));
    if (real !== path.join(realDir, name)) return NextResponse.json({ error: "not found" }, { status: 404 });
    const stat = await fs.stat(real);
    if (!stat.isFile()) return NextResponse.json({ error: "not found" }, { status: 404 });
    file = real;
    size = stat.size;
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const ext = path.extname(name).toLowerCase();
  const declared = contentTypeFor(name);
  // SVG and any unknown type are served inert - never as a navigable document
  // that could run script on this origin.
  const inert = declared === "application/octet-stream" || ext === ".svg";
  const headers = new Headers({
    "content-type": inert ? "application/octet-stream" : declared,
    "cache-control": "private, max-age=300",
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes"
  });
  if (inert) headers.set("content-disposition", `attachment; filename="${name.replace(/["\r\n]/g, "")}"`);

  // Range support: video scrubbing and `#t=` deep links need 206 responses.
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Number(range[2]) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end >= size || start > end) {
      return new NextResponse(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    }
    headers.set("content-range", `bytes ${start}-${end}/${size}`);
    headers.set("content-length", String(end - start + 1));
    return new NextResponse(nodeToWeb(createReadStream(file, { start, end })), { status: 206, headers });
  }

  headers.set("content-length", String(size));
  return new NextResponse(nodeToWeb(createReadStream(file)), { status: 200, headers });
}

function nodeToWeb(stream: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on("data", (chunk: Buffer | string) => controller.enqueue(new Uint8Array(Buffer.from(chunk))));
      stream.on("end", () => controller.close());
      stream.on("error", (err) => controller.error(err));
    },
    cancel() {
      stream.destroy();
    }
  });
}
