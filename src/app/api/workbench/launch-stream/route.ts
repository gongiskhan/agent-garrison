import type { NextRequest } from "next/server";
import { workbenchServerBus } from "@/lib/workbench-server-bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Phase 9E — SSE for the Workbench UI. Subscribes to the server-side bus and
// streams soul-tab-launch / soul-tab-respawn events to the browser.

export async function GET(_request: NextRequest) {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`event: open\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`));

      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: keepalive\n\n`)); }
        catch { /* connection closed */ }
      }, 15_000);

      unsubscribe = workbenchServerBus().subscribe((event) => {
        try {
          const payload = `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch { /* connection closed */ }
      });

      (controller as ReadableStreamDefaultController & { _heartbeat?: NodeJS.Timeout })._heartbeat = heartbeat;
    },
    cancel() {
      unsubscribe?.();
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    }
  });
}
