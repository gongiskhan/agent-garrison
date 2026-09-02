import { Readable, Writable } from "node:stream";
import type { NextRequest } from "next/server";

/**
 * Adapts the App Router's Request/Response pair to the `(req, res)` shape a
 * plain node http handler expects, so a handler written once for a node
 * server (the @garrison/talk router, the conversation router it embeds) also
 * serves under Next without a second implementation that would drift.
 *
 * The request is a real `Readable` (the handlers `for await` the body and
 * listen for `close`/`aborted`); the response is a real `Writable` (upstream
 * proxies `pipe` into it, file handlers stream into it). Writes after `end`
 * are dropped rather than thrown: a detached handler racing a client
 * disconnect must never crash the app server.
 */
export class NodeRequestShim extends Readable {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly httpVersion = "1.1";
  readonly socket = { remoteAddress: "127.0.0.1", encrypted: false };
  #body: Buffer | null;

  constructor(request: NextRequest, body: Buffer | null) {
    super();
    this.method = request.method;
    // Relative, not absolute: the routers match the path against their base.
    this.url = `${request.nextUrl.pathname}${request.nextUrl.search}`;
    this.headers = Object.fromEntries(Array.from(request.headers.entries(), ([k, v]) => [k.toLowerCase(), v]));
    this.#body = body;
    request.signal.addEventListener(
      "abort",
      () => {
        this.emit("aborted");
        if (!this.destroyed) this.destroy();
      },
      { once: true },
    );
  }

  _read(): void {
    if (this.#body) {
      const chunk = this.#body;
      this.#body = null;
      this.push(chunk);
    }
    this.push(null);
  }
}

type HeaderValue = string | number | readonly string[];

export class NodeResponseShim extends Writable {
  statusCode = 200;
  statusMessage = "";
  #headers = new Map<string, string | string[]>();
  #headersSent = false;
  #chunks: Uint8Array[] = [];
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  #headersReady: Promise<void>;
  #resolveHeaders!: () => void;
  #finished: Promise<void>;
  #resolveFinished!: () => void;

  constructor() {
    super({ decodeStrings: true });
    this.#headersReady = new Promise((r) => { this.#resolveHeaders = r; });
    this.#finished = new Promise((r) => { this.#resolveFinished = r; });
    this.once("finish", () => this.#resolveFinished());
    this.once("close", () => { this.#resolveHeaders(); this.#resolveFinished(); });
    // A client that went away is not an error the handler can act on.
    this.on("error", () => {});
  }

  get headersSent(): boolean {
    return this.#headersSent;
  }

  setHeader(name: string, value: HeaderValue): this {
    if (this.#headersSent) return this;
    this.#headers.set(name.toLowerCase(), Array.isArray(value) ? [...value] : String(value));
    return this;
  }

  getHeader(name: string): string | string[] | undefined {
    return this.#headers.get(name.toLowerCase());
  }

  hasHeader(name: string): boolean {
    return this.#headers.has(name.toLowerCase());
  }

  removeHeader(name: string): void {
    if (!this.#headersSent) this.#headers.delete(name.toLowerCase());
  }

  getHeaders(): Record<string, string | string[]> {
    return Object.fromEntries(this.#headers);
  }

  writeHead(statusCode: number, headers?: Record<string, HeaderValue>): this {
    this.statusCode = statusCode;
    if (headers) for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
    this.flushHeaders();
    return this;
  }

  flushHeaders(): void {
    if (this.#headersSent) return;
    this.#headersSent = true;
    this.#resolveHeaders();
  }

  /** Streaming responses (SSE, proxied bodies) are those whose headers flush
   *  before the body ends; a normal endpoint ends inside one tick. */
  get streaming(): boolean {
    return this.#headersSent && !this.writableEnded;
  }

  // Tolerant of write-after-end: node's Writable would emit ERR_STREAM_WRITE_AFTER_END.
  override write(chunk: any, encoding?: any, cb?: any): boolean {
    if (this.writableEnded || this.destroyed) {
      const done = typeof encoding === "function" ? encoding : cb;
      if (typeof done === "function") queueMicrotask(done);
      return false;
    }
    return super.write(chunk, encoding, cb);
  }

  override end(chunk?: any, encoding?: any, cb?: any): this {
    if (this.writableEnded || this.destroyed) {
      const done = typeof chunk === "function" ? chunk : typeof encoding === "function" ? encoding : cb;
      if (typeof done === "function") queueMicrotask(done);
      return this;
    }
    return super.end(chunk, encoding, cb);
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.flushHeaders();
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (this.#controller) {
      try { this.#controller.enqueue(bytes); } catch { /* reader cancelled */ }
    } else {
      this.#chunks.push(bytes);
    }
    callback();
  }

  _final(callback: (error?: Error | null) => void): void {
    this.flushHeaders();
    if (this.#controller) {
      try { this.#controller.close(); } catch { /* already closed */ }
      this.#controller = null;
    }
    callback();
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.#controller) {
      try { this.#controller.close(); } catch { /* already closed */ }
      this.#controller = null;
    }
    callback(error);
  }

  #bufferedBody(): Uint8Array<ArrayBuffer> {
    const total = this.#chunks.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(new ArrayBuffer(total));
    let at = 0;
    for (const part of this.#chunks) { out.set(part, at); at += part.length; }
    this.#chunks = [];
    return out;
  }

  #webHeaders(): Headers {
    const h = new Headers();
    for (const [k, v] of this.#headers) {
      if (Array.isArray(v)) for (const one of v) h.append(k, one);
      else h.set(k, v);
    }
    return h;
  }

  /**
   * The web Response for this exchange. Resolves as soon as the handler has
   * committed its headers (first write / flushHeaders / end), so a streaming
   * body starts reaching the client while the handler is still producing it.
   * Frames written before the stream is pulled are replayed first, so nothing
   * an eager handler wrote is lost to construction order.
   */
  async toResponse(): Promise<Response> {
    await Promise.race([this.#headersReady, this.#finished]);
    const status = this.statusCode;
    const headers = this.#webHeaders();
    const bodiless = status === 204 || status === 304 || status < 200;
    if (this.writableEnded || this.destroyed) {
      const body = this.#bufferedBody();
      return new Response(bodiless || !body.length ? null : body, { status, headers });
    }
    if (bodiless) return new Response(null, { status, headers });
    // Still producing: hand the client a live stream.
    headers.delete("content-length");
    const buffered = this.#chunks;
    this.#chunks = [];
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const part of buffered) controller.enqueue(part);
        this.#controller = controller;
        if (this.writableEnded) {
          try { controller.close(); } catch { /* closed */ }
          this.#controller = null;
        }
      },
      cancel: () => {
        // The client went away: `close` is what the SSE handlers listen for.
        this.#controller = null;
        if (!this.destroyed) this.destroy();
      },
    });
    return new Response(stream, { status, headers });
  }
}

/** Read the request body into memory for the shim (none for GET/HEAD). */
export async function requestBodyFor(request: NextRequest): Promise<Buffer | null> {
  if (request.method === "GET" || request.method === "HEAD") return null;
  return Buffer.from(await request.arrayBuffer());
}
