import { NextResponse } from "next/server";
import { verifyInternalToken } from "@/lib/internal-token";
import { activeGatewayBaseUrl } from "@/lib/runner";
import {
  buildCurationPrompt,
  parseCurationReply,
  validateCurationFrames
} from "@/lib/drill-curation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Batch vision curation for Drill Spotter frames (Evidence V2, S2), routed
// through the Model Router like every model call: the classification asserts
// the ex-drill-curation exception and the gateway executes on whatever target
// the live composition routes it to. Frames stay on disk — the routed session
// Reads the listed files; bytes never enter this request or the gateway hop.
export async function POST(req: Request) {
  if (!(await verifyInternalToken(req.headers.get("x-garrison-internal")))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { frames?: unknown; meta?: { app?: string; runId?: string } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  let frames;
  try {
    frames = await validateCurationFrames(body.frames);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: detail }, { status: 400 });
  }

  const classification = {
    taskType: "image" as const,
    tier: "T1-standard" as const,
    contextKind: "drill-curation",
    matchedException: "ex-drill-curation"
  };
  const prompt = buildCurationPrompt(frames, body.meta ?? {});
  // Live-record first (see the vision route): the 24777 fallback is the
  // codex instance's gateway — never silently hand turns to it.
  const gatewayUrl =
    activeGatewayBaseUrl() ??
    `http://127.0.0.1:${process.env.GARRISON_GATEWAY_PORT || "24777"}`;

  // Retry only a connection-level failure (mirrors the vision route).
  const chatFetch = async (): Promise<Response> => {
    const requestGateway = () =>
      fetch(`${gatewayUrl}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: prompt,
          classification,
          // Local-vision lane: when ex-drill-curation resolves to an
          // ollama-local target the gateway delivers these frames natively
          // (base64); Claude targets Read the same paths from the prompt.
          images: frames.map((f) => f.path),
          // Internal engine work must not become a quick Kanban card.
          channel: "garrison"
        })
      });
    try {
      return await requestGateway();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return requestGateway();
    }
  };

  let response: Response;
  try {
    response = await chatFetch();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `gateway unreachable: ${detail}` },
      { status: 503 }
    );
  }

  const raw = await response.text();
  let gatewayReply: any = null;
  try {
    gatewayReply = raw ? JSON.parse(raw) : {};
  } catch {
    // PTY reply extraction can leak raw control bytes into the outer JSON.
    try {
      gatewayReply = JSON.parse(
        raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      );
    } catch {
      if (response.ok) {
        return NextResponse.json(
          { error: "gateway reply unparseable" },
          { status: 502 }
        );
      }
    }
  }

  if (!response.ok) {
    const detail =
      typeof gatewayReply?.error === "string"
        ? gatewayReply.error
        : raw.replace(/\s+/g, " ").trim().slice(0, 300);
    return NextResponse.json(
      { error: `gateway ${response.status}${detail ? `: ${detail}` : ""}` },
      { status: 502 }
    );
  }
  if (!gatewayReply || typeof gatewayReply !== "object") {
    return NextResponse.json(
      { error: "gateway reply unparseable" },
      { status: 502 }
    );
  }

  const routedVia =
    typeof gatewayReply.route === "string" && gatewayReply.route
      ? gatewayReply.route
      : null;
  const text = gatewayReply.reply ?? gatewayReply.text ?? gatewayReply.message ?? "";
  try {
    const results = parseCurationReply(text);
    return NextResponse.json({ results, routedVia });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `curation result parse failed: ${detail}`, routedVia },
      { status: 502 }
    );
  }
}
