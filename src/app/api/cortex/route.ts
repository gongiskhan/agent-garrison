import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/lib/http";
import {
  CORTEX_SECRET_KEY,
  callCortex,
  checkCortexRequest,
  readCortexBase,
  readCortexKey,
  readCortexKeyState
} from "@/lib/cortex-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/cortex - what the session view needs to explain itself: where it
// would send a request, and whether the credential exists. Presence only; the
// key's value has no route out of the server.
export async function GET() {
  try {
    const [base, key] = await Promise.all([readCortexBase(), readCortexKeyState()]);
    return NextResponse.json({
      stationed: base.stationed,
      compositionId: base.compositionId,
      baseUrl: base.baseUrl,
      baseUrlSource: base.source,
      baseUrlError: base.invalid ?? null,
      secretKey: CORTEX_SECRET_KEY,
      keySet: key.set,
      vaultLocked: key.locked
    });
  } catch (error) {
    return jsonError(error, 500);
  }
}

// POST /api/cortex - the one authenticated hop, over an allowlist.
// Body: { path, method?, body? }.
//
// A Garrison 2xx means the round trip happened; what Cortex said is in
// `upstream`. That split is deliberate. `execute` reports refusal as HTTP 200
// with `{success:false}` and a consent gate as HTTP 403 - mirroring either onto
// this response would make the client's `res.ok` lie about which layer failed.
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    path?: unknown;
    method?: unknown;
    body?: unknown;
  };

  const check = checkCortexRequest(body.method ?? "GET", body.path);
  if (!check.ok) return jsonError(new Error(check.reason), 400);

  const base = await readCortexBase();
  if (base.invalid) return jsonError(new Error(base.invalid), 400);
  if (!base.baseUrl) {
    return jsonError(
      new Error(
        "No Cortex base URL. Set `base_url` on the cortex-automations Fitting in the active composition (or export CORTEX_BASE_URL for the Garrison process)."
      ),
      400
    );
  }

  let key: string | null;
  try {
    key = await readCortexKey();
  } catch (error) {
    return jsonError(
      new Error(
        `Vault unavailable, so ${CORTEX_SECRET_KEY} could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`
      ),
      409
    );
  }
  if (!key) {
    return jsonError(
      new Error(`${CORTEX_SECRET_KEY} is not set in the Vault. Add it, then retry.`),
      409
    );
  }

  try {
    const upstream = await callCortex({
      baseUrl: base.baseUrl,
      key,
      method: check.method,
      path: check.path,
      body: body.body
    });
    return NextResponse.json({ request: { method: check.method, path: check.path }, upstream });
  } catch (error) {
    // Transport failure: the request never got an answer. Report it verbatim -
    // this is the layer where a wrong base URL or a stopped Cortex shows up.
    const message = error instanceof Error ? error.message : String(error);
    const aborted = error instanceof Error && error.name === "AbortError";
    return jsonError(
      new Error(
        `${aborted ? "Timed out reaching" : "Could not reach"} ${base.baseUrl}${check.path}: ${message}`
      ),
      502
    );
  }
}
