import { NextResponse, type NextRequest } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { attachMedia, mediaKindFor, NotFound, readRun, RUN_LEVEL, type MediaRef } from "@/lib/results-store";
import { extractKeyframes, MediaTooLarge, sanitizeMediaName, writeMedia } from "@/lib/results-media";
import { resultLinks } from "@/lib/results-links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Three ways in, because the callers are different shapes:
//   multipart/form-data   curl -F file=@shot.png            (bash tools)
//   JSON {path}           the file is already on this box   (the common case)
//   JSON {base64}         the caller holds the bytes        (the MCP wrapper)
// A raw body with ?name= also works for a plain `curl --data-binary`.

// Never republish a secret through a tailnet-reachable report URL, even though
// the caller could read it itself. Same list the /file route enforces.
const SENSITIVE = /(?:^|\/)(?:\.env(?:\.|$)|id_rsa|id_ed25519|[^/]*\.pem|vault\.json)|\/\.git\//i;

interface Incoming {
  name: string;
  bytes: Buffer;
  stepId: string | null;
  caption: string | undefined;
  kind: string | undefined;
}

async function readIncoming(request: NextRequest): Promise<Incoming> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("multipart upload needs a `file` field");
    return {
      name: sanitizeMediaName((form.get("name") as string) || file.name || "upload.bin"),
      bytes: Buffer.from(await file.arrayBuffer()),
      stepId: (form.get("stepId") as string) || null,
      caption: (form.get("caption") as string) || undefined,
      kind: (form.get("kind") as string) || undefined
    };
  }

  if (contentType.includes("application/json")) {
    const body = (await request.json()) as Record<string, unknown>;
    const stepId = (body.stepId as string) || null;
    const caption = (body.caption as string) || undefined;
    const kind = (body.kind as string) || undefined;
    const src = body.path as string | undefined;
    if (src) {
      if (!path.isAbsolute(src)) throw new Error("`path` must be absolute");
      if (SENSITIVE.test(src)) throw new Error("refusing to publish a credential file");
      const bytes = await fs.readFile(src);
      return { name: sanitizeMediaName((body.name as string) || path.basename(src)), bytes, stepId, caption, kind };
    }
    const b64 = (body.base64 ?? body.content ?? body.data) as string | undefined;
    if (typeof b64 === "string" && b64.length) {
      const cleaned = b64.includes(",") && b64.startsWith("data:") ? b64.slice(b64.indexOf(",") + 1) : b64;
      return {
        name: sanitizeMediaName((body.name as string) || "upload.bin"),
        bytes: Buffer.from(cleaned, "base64"),
        stepId,
        caption,
        kind
      };
    }
    throw new Error("send `path` (a file on this machine) or `base64`");
  }

  const name = sanitizeMediaName(request.nextUrl.searchParams.get("name") ?? "upload.bin");
  return {
    name,
    bytes: Buffer.from(await request.arrayBuffer()),
    stepId: request.nextUrl.searchParams.get("stepId"),
    caption: request.nextUrl.searchParams.get("caption") ?? undefined,
    kind: request.nextUrl.searchParams.get("kind") ?? undefined
  };
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const run = await readRun(params.id);
    if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });

    const incoming = await readIncoming(request);
    if (!incoming.bytes.byteLength) return NextResponse.json({ error: "empty upload" }, { status: 400 });

    const ref = await writeMedia(params.id, {
      name: incoming.name,
      bytes: incoming.bytes,
      kind: incoming.kind,
      caption: incoming.caption
    });

    // A video gets keyframes so the step shows something before anyone presses
    // play. Extraction failing is never fatal: the video still attaches and
    // the note records why there are no frames.
    const extras: MediaRef[] = [];
    if (mediaKindFor(ref.name, incoming.kind) === "video") {
      const { frames, note } = await extractKeyframes(params.id, ref.name);
      ref.keyframes = frames.map((f) => f.name);
      ref.keyframeNote = note;
      extras.push(...frames);
    }

    for (const frame of extras) await attachMedia(params.id, frame, incoming.stepId);
    const { record } = await attachMedia(params.id, ref, incoming.stepId);

    const links = await resultLinks(request, record.id);
    return NextResponse.json(
      {
        ok: true,
        media: ref.name,
        kind: ref.kind,
        bytes: ref.bytes,
        keyframes: ref.keyframes ?? [],
        keyframeNote: ref.keyframeNote ?? null,
        stepId: incoming.stepId ?? record.steps[record.steps.length - 1]?.id ?? null,
        runLevel: incoming.stepId === RUN_LEVEL,
        ...links
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof MediaTooLarge) return NextResponse.json({ error: error.message }, { status: 413 });
    if (error instanceof NotFound) return NextResponse.json({ error: error.message }, { status: 404 });
    const message = error instanceof Error ? error.message : String(error);
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return NextResponse.json({ error: message }, { status: missing ? 404 : 400 });
  }
}
