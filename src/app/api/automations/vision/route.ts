import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { readLibrary } from "@/lib/library";
import { findRoutingConfigPath, readRoutingConfig, resolveRoute } from "@/lib/model-router";
import { verifyInternalToken } from "@/lib/internal-token";
import { buildVisionPrompt } from "./prompt";

// The routed model is a tool-capable Claude session, not a raw multimodal API
// call - it cannot receive image bytes in the /chat message. So the screenshot
// the engine already captured is parked on disk and the prompt points the model
// at the PATH; the session Reads the file and actually SEES the page. Without
// this, every "visual" check judges from the a11y text tree alone.
const SHOT_DIR = () =>
  path.join(process.env.GARRISON_HOME ?? path.join(os.homedir(), ".garrison"), "vision-shots");
const SHOT_TTL_MS = 60 * 60 * 1000;

async function parkScreenshot(b64: string): Promise<string | null> {
  try {
    const dir = SHOT_DIR();
    await fs.mkdir(dir, { recursive: true });
    // Best-effort prune of stale shots so the dir never grows unbounded.
    try {
      const now = Date.now();
      for (const name of await fs.readdir(dir)) {
        const p = path.join(dir, name);
        const st = await fs.stat(p).catch(() => null);
        if (st && now - st.mtimeMs > SHOT_TTL_MS) await fs.unlink(p).catch(() => undefined);
      }
    } catch {
      /* pruning must never block the call */
    }
    const file = path.join(dir, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.png`);
    await fs.writeFile(file, Buffer.from(b64, "base64"));
    return file;
  } catch {
    return null;
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-step vision/fixer model call for a browser step, routed through the Model
// Router (decision 5 — no hardcoded model). Given an observation (a11y tree +
// url/title/heading; screenshot optional) and the step, the operative returns a
// resolved Playwright action (mode=action), a pass/fail verdict (mode=verify),
// or a qualitative judgment verdict (mode=judge, Drill's drillJudge()).
// Internal-token gated.
export async function POST(req: Request) {
  if (!(await verifyInternalToken(req.headers.get("x-garrison-internal")))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: { observation?: any; step?: any; mode?: string; contextTag?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const { observation, step, mode = "action", contextTag } = body;
  if (!observation || !step) return NextResponse.json({ error: "observation + step required" }, { status: 400 });

  // Route via the Model Router (image task type for a screenshot-grounded
  // call). A caller-supplied contextTag (e.g. Drill's "drill-adversarial",
  // R12) becomes part of contextKind so a composition's routing config can
  // target it at a different model than the default vision resolution —
  // generic plumbing, no caller-specific naming in this route's own logic.
  let routedVia: string | null = null;
  const classification = {
    taskType: "image" as const,
    tier: "T1-standard" as const,
    contextKind: contextTag ? `automation-vision:${contextTag}` : "automation-vision"
  };
  try {
    const entries = await readLibrary();
    const configPath = findRoutingConfigPath(entries);
    if (configPath) {
      const config = await readRoutingConfig(configPath);
      routedVia = resolveRoute(config, classification).target.id;
    }
  } catch (err) {
    return NextResponse.json({ error: `model router unavailable: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
  }

  const shotPath =
    typeof observation.screenshotB64 === "string" && observation.screenshotB64
      ? await parkScreenshot(observation.screenshotB64)
      : null;
  const prompt = buildVisionPrompt(mode, observation, step, shotPath);

  const gatewayUrl = process.env.GARRISON_GATEWAY_URL || `http://127.0.0.1:${process.env.GARRISON_GATEWAY_PORT || "4777"}`;
  // One retry on a connection-level failure: the gateway serializes turns on
  // the operative PTY and a busy stretch can drop/starve a fresh connection.
  // Each drill step behind this call already paid a navigate+observe cycle -
  // losing it to one transient connect failure is the worse trade.
  const chatFetch = async (): Promise<Response> => {
    const doFetch = () =>
      fetch(`${gatewayUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // channel "garrison" marks this as an engine-originated internal call: the
      // gateway's D19 carding pipeline files every OTHER task-shaped chat as a
      // kanban card first. Without it, each per-step vision resolution spams the
      // board with a quick card ("You are resolving a browser VERIFY step…") and
      // the nested card bookkeeping starves the actual model turn (empty reply).
      // matchedException asserts the routing-config exception for this call by
      // convention: `automation-vision` (or `automation-vision-<contextTag>`).
      // The gateway's resolver only honors exceptions via matchedException (its
      // hint parser drops contextKind), and an id absent from the config simply
      // falls through to the matrix - same behavior as before this field.
      body: JSON.stringify({
        message: prompt,
        channel: "garrison",
        classification: {
          taskType: classification.taskType,
          tier: classification.tier,
          contextKind: classification.contextKind,
          matchedException: contextTag ? `automation-vision-${contextTag}` : "automation-vision"
        }
      })
      });
    try {
      return await doFetch();
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
      return doFetch();
    }
  };
  let res: Response;
  try {
    res = await chatFetch();
  } catch (err) {
    // ONLY connection-level failures are "unreachable" - reply-shape problems
    // below get their own honest errors (a body-parse failure spent hours
    // masquerading as this on 2026-07-17).
    return NextResponse.json({ error: `gateway unreachable: ${err instanceof Error ? err.message : String(err)}`, routedVia }, { status: 503 });
  }
  try {
    if (!res.ok) return NextResponse.json({ error: `gateway ${res.status}`, routedVia }, { status: 502 });
    const raw = await res.text();
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      // The PTY gateway occasionally leaks raw control bytes (ANSI residue
      // from the terminal reply extraction) into its JSON body under real-run
      // load. Strip and retry before declaring the reply unusable.
      try {
        json = JSON.parse(raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""));
      } catch {
        return NextResponse.json({ error: "gateway reply unparseable", routedVia }, { status: 502 });
      }
    }
    const text = json.reply ?? json.text ?? json.message ?? "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return NextResponse.json({ error: "vision reply had no JSON", routedVia }, { status: 502 });
    const result = JSON.parse(m[0]);
    // Models drift to prose role names; Playwright's getByRole only knows real
    // ARIA roles, so a bad alias here poisons the assertion cache AND the
    // graduated spec downstream (live-fire: role "image" emitted a spec whose
    // locator can never match, and the cached assertion healed back to vision
    // on every run). Normalize once, where the assertion enters the system.
    const ROLE_ALIASES: Record<string, string> = { image: "img", picture: "img", textfield: "textbox", input: "textbox" };
    if (result?.assertion?.role && ROLE_ALIASES[result.assertion.role]) {
      result.assertion.role = ROLE_ALIASES[result.assertion.role];
    }
    return NextResponse.json({ result, routedVia });
  } catch (err) {
    // Reply arrived but its embedded JSON verdict would not parse.
    return NextResponse.json({ error: `vision result parse failed: ${err instanceof Error ? err.message : String(err)}`, routedVia }, { status: 502 });
  }
}
