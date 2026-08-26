import { EventEmitter } from "node:events";
import type { NextRequest } from "next/server";
import { activeGatewayBaseUrl } from "@/lib/runner";
// @ts-ignore — pure .mjs (the shared conversation serving layer)
import { gatewayMessageForwarder, handleConversationRequest } from "@garrison/claude-pty";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Garrison app's mount of the ONE conversation router
 * (packages/claude-pty/src/conversation-http.mjs), at the same relative base the
 * web-channel and kanban servers use: `/api/conversation`.
 *
 * The router is a plain node http handler on purpose - two of its three mounts
 * are node servers - so this route adapts the App Router's Request/Response pair
 * to `(req, res)` rather than growing a second implementation that would drift.
 * The shims below are the whole adaptation: everything about what the endpoints
 * DO lives in the shared module.
 */
const BASE = "/api/conversation";

/** Enough of IncomingMessage for the router: method, path+query, a body the
 *  router can `for await` over, and a close signal. */
class RequestShim extends EventEmitter {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  #body: Buffer;

  constructor(request: NextRequest, body: string) {
    super();
    this.method = request.method;
    // Relative, not absolute: the router matches the path against its base.
    this.url = `${request.nextUrl.pathname}${request.nextUrl.search}`;
    this.headers = Object.fromEntries(request.headers.entries());
    this.#body = Buffer.from(body, "utf8");
    request.signal.addEventListener("abort", () => this.emit("close"), { once: true });
  }

  async *[Symbol.asyncIterator]() {
    if (this.#body.length) yield this.#body;
  }
}

/** Enough of ServerResponse for the router. Buffered by default; an SSE handler
 *  is detected by its content-type and switched to a live ReadableStream, whose
 *  `cancel` is what stops the router's poll when the browser goes away. */
class ResponseShim extends EventEmitter {
  statusCode = 200;
  readonly headers = new Headers();
  #chunks: Uint8Array[] = [];
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  #ended = false;
  #encoder = new TextEncoder();

  setHeader(name: string, value: string | number) {
    this.headers.set(name, String(value));
  }

  flushHeaders() {
    /* the Response is built once the handler returns; nothing to flush */
  }

  get streaming(): boolean {
    return (this.headers.get("content-type") ?? "").includes("text/event-stream");
  }

  write(chunk: string | Uint8Array): boolean {
    if (this.#ended) return false;
    const bytes = typeof chunk === "string" ? this.#encoder.encode(chunk) : chunk;
    if (this.#controller) this.#controller.enqueue(bytes);
    else this.#chunks.push(bytes);
    return true;
  }

  end(chunk?: string | Uint8Array) {
    if (this.#ended) return;
    if (chunk !== undefined) this.write(chunk);
    this.#ended = true;
    try {
      this.#controller?.close();
    } catch {
      /* already closed by a cancelled reader */
    }
    this.emit("finish");
  }

  /** The buffered body, for a normal request/response endpoint. */
  body(): ArrayBuffer {
    const total = this.#chunks.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of this.#chunks) {
      out.set(part, at);
      at += part.length;
    }
    return out.buffer as ArrayBuffer;
  }

  /** The live body, for SSE. Frames written before this runs are replayed in
   *  `start`, so the router's `init` frame is never lost to construction order. */
  stream(onCancel: () => void): ReadableStream<Uint8Array> {
    const buffered = this.#chunks;
    this.#chunks = [];
    const ended = this.#ended;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const part of buffered) controller.enqueue(part);
        if (ended) {
          controller.close();
          return;
        }
        this.#controller = controller;
      },
      cancel: () => {
        this.#ended = true;
        onCancel();
      },
    });
  }
}

async function handle(request: NextRequest): Promise<Response> {
  const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
  const req = new RequestShim(request, body);
  const res = new ResponseShim();
  const handled = await handleConversationRequest(req, res, {
    base: BASE,
    role: "garrison-app",
    // The app resolves the live gateway of the running composition exactly as
    // every other internal route does; a mount with no reachable gateway
    // refuses messages rather than parking them in the ledger unanswered.
    forwardMessage: gatewayMessageForwarder(activeGatewayBaseUrl()),
  });
  if (!handled) {
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  if (res.streaming) {
    const stream = res.stream(() => {
      req.emit("close");
      res.emit("close");
    });
    return new Response(stream, { status: res.statusCode, headers: res.headers });
  }
  return new Response(res.body(), { status: res.statusCode, headers: res.headers });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
