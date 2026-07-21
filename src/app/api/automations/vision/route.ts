import { NextResponse } from "next/server";
import { readLibrary } from "@/lib/library";
import {
  findRoutingConfigPath,
  readRoutingConfig,
  resolveRoute
} from "@/lib/model-router";
import { verifyInternalToken } from "@/lib/internal-token";
import { activeGatewayBaseUrl } from "@/lib/runner";
import {
  materializeVisionScreenshot,
  parseVisionModelReply,
  removeVisionScreenshot,
  visionGatewayClassification
} from "./input";
import { buildVisionPrompt } from "./prompt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-step vision/fixer model call for a browser step, routed through the Model
// Router. A tool-capable routed session receives a temporary local screenshot
// path and inspects it with Read before returning an action, verdict, or patch.
export async function POST(req: Request) {
  if (!(await verifyInternalToken(req.headers.get("x-garrison-internal")))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: {
    observation?: any;
    step?: any;
    mode?: string;
    contextTag?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const { observation, step, mode = "action", contextTag } = body;
  if (!observation || !step) {
    return NextResponse.json(
      { error: "observation + step required" },
      { status: 400 }
    );
  }

  const classification = visionGatewayClassification(contextTag);
  let screenshotPath: string | null = null;
  try {
    screenshotPath = await materializeVisionScreenshot(
      observation?.screenshotB64
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `invalid screenshot: ${detail}` },
      { status: 400 }
    );
  }

  try {
    let routedVia: string | null = null;
    try {
      const entries = await readLibrary();
      const configPath = findRoutingConfigPath(entries);
      if (configPath) {
        const config = await readRoutingConfig(configPath);
        routedVia = resolveRoute(config, classification).target.id;
      }
    } catch (err) {
      return NextResponse.json(
        {
          error: `model router unavailable: ${
            err instanceof Error ? err.message : String(err)
          }`
        },
        { status: 500 }
      );
    }

    const prompt = buildVisionPrompt(
      mode,
      observation,
      step,
      screenshotPath
    );
    // Live-record first: the hardcoded 24777 fallback belongs to the codex
    // instance and silently handed vision turns to ITS operative when this
    // app ran without GARRISON_GATEWAY_URL in the env.
    const gatewayUrl =
      activeGatewayBaseUrl() ??
      `http://127.0.0.1:${
        process.env.GARRISON_GATEWAY_PORT || "24777"
      }`;

    // Retry only a connection-level failure. HTTP and reply-shape failures are
    // returned honestly instead of being mislabeled as an unreachable gateway.
    const chatFetch = async (): Promise<Response> => {
      const requestGateway = () =>
        fetch(`${gatewayUrl}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: prompt,
            classification,
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
      return NextResponse.json(
        {
          error: `gateway unreachable: ${
            err instanceof Error ? err.message : String(err)
          }`,
          routedVia
        },
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
            { error: "gateway reply unparseable", routedVia },
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
        {
          error: `gateway ${response.status}${detail ? `: ${detail}` : ""}`,
          routedVia
        },
        { status: 502 }
      );
    }
    if (!gatewayReply || typeof gatewayReply !== "object") {
      return NextResponse.json(
        { error: "gateway reply unparseable", routedVia },
        { status: 502 }
      );
    }

    // The gateway owns the live composition route, so its actual target wins
    // over the fitting-local router's informational label.
    if (typeof gatewayReply.route === "string" && gatewayReply.route) {
      routedVia = gatewayReply.route;
    }
    // Session linkage: the gateway names the Claude session (and its on-disk
    // jsonl transcript) that resolved this turn — callers persist it so a
    // vision verdict stays traceable to the session that produced it.
    const sessionId =
      typeof gatewayReply.session_id === "string" && gatewayReply.session_id
        ? gatewayReply.session_id
        : null;
    const transcriptPath =
      typeof gatewayReply.transcript_path === "string" &&
      gatewayReply.transcript_path
        ? gatewayReply.transcript_path
        : null;
    const text =
      gatewayReply.reply ?? gatewayReply.text ?? gatewayReply.message ?? "";
    try {
      const result = parseVisionModelReply(text);
      const assertion =
        result.assertion && typeof result.assertion === "object"
          ? (result.assertion as Record<string, unknown>)
          : null;
      const aliases: Record<string, string> = {
        image: "img",
        picture: "img",
        textfield: "textbox",
        input: "textbox"
      };
      if (
        assertion &&
        typeof assertion.role === "string" &&
        aliases[assertion.role]
      ) {
        assertion.role = aliases[assertion.role];
      }
      return NextResponse.json({ result, routedVia, sessionId, transcriptPath });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { error: `vision result parse failed: ${detail}`, routedVia },
        { status: 502 }
      );
    }
  } finally {
    await removeVisionScreenshot(screenshotPath);
  }
}
