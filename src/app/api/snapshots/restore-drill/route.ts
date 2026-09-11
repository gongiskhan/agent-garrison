import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT_DIR } from "@/lib/paths";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
let running = false;

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(request.url).host) return Response.json({ error: "cross-origin request refused" }, { status: 403 });
    } catch { return Response.json({ error: "cross-origin request refused" }, { status: 403 }); }
  }
  if (running) return Response.json({ error: "restore drill is already running" }, { status: 409 });
  running = true;
  const encoder = new TextEncoder();
  let disconnected = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const child = spawn(process.execPath, [path.join(ROOT_DIR, "scripts/restore-drill.mjs"), "--notify"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      const send = (value: string) => { if (!disconnected) controller.enqueue(encoder.encode(value)); };
      child.stdout.on("data", data => send(String(data)));
      child.stderr.on("data", data => send(String(data)));
      child.on("error", error => send(`${error.message}\n`));
      child.on("close", code => { running = false; send(`Process exited ${code}\n`); if (!disconnected) controller.close(); });
    },
    // Closing the tab does not cancel the independently restoring child.
    cancel() { disconnected = true; }
  });
  return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
