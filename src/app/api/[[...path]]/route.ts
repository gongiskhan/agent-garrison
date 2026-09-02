import type { NextRequest } from "next/server";
import { activeGatewayBaseUrl } from "@/lib/runner";
import { NodeRequestShim, NodeResponseShim, requestBodyFor } from "@/lib/node-handler-shim";
// @ts-ignore - pure .mjs (the Conversations engine, shared with the legacy fitting host)
import { createTalkRouter, initTalkRuntime, recoverStartupInputs } from "@garrison/talk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The shell's mount of the Conversations engine (@garrison/talk). Every route
 * the engine serves - threads, chat streaming, voice clips, attachments, push,
 * the conversation ledger - answers here at the SAME relative paths the legacy
 * own-port fitting used, so the UI builds one set of relative URLs for both.
 *
 * One catch-all on purpose: the engine keeps per-process state (the thread
 * store's live maps, input workers, the remote-shell snapshot) that a set of
 * per-path route modules would each instantiate once more. Specific
 * `src/app/api/<name>/` routes still win over this segment by Next's
 * precedence; this only answers what nothing else claims.
 */
type Router = (req: NodeRequestShim, res: NodeResponseShim) => Promise<boolean>;

interface TalkMount {
  router: Router;
  ready: Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __garrisonTalkMount: TalkMount | undefined;
}

function appPort(): number {
  const raw = process.env.GARRISON_APP_PORT?.trim() || process.env.PORT?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function mount(): TalkMount {
  // Survives Next dev's module re-evaluation: one engine per process, always.
  if (globalThis.__garrisonTalkMount) return globalThis.__garrisonTalkMount;
  const liveOpts = {
    // The composition's live gateway, resolved per request: it changes when
    // the composition restarts and a mount pinned at boot would go stale.
    get gatewayUrl(): string {
      return activeGatewayBaseUrl() ?? "";
    },
    host: "127.0.0.1",
    port: appPort(),
    scheme: "http",
    conversationRole: "garrison-app",
  };
  const router = createTalkRouter(liveOpts, { distDir: null, log: console }) as Router;
  const ready = Promise.resolve()
    .then(() => initTalkRuntime())
    .then((startupInputs: unknown) => {
      const controller = new AbortController();
      recoverStartupInputs(startupInputs, liveOpts, { signal: controller.signal, log: console });
    })
    .catch((err: unknown) => {
      console.error("[talk] runtime init failed:", err);
    });
  globalThis.__garrisonTalkMount = { router, ready };
  return globalThis.__garrisonTalkMount;
}

async function handle(request: NextRequest): Promise<Response> {
  const { router, ready } = mount();
  await ready;
  const req = new NodeRequestShim(request, await requestBodyFor(request));
  const res = new NodeResponseShim();
  const handled = await router(req, res);
  if (!handled) {
    return new Response(JSON.stringify({ error: "not found", path: request.nextUrl.pathname }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  return res.toResponse();
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;
