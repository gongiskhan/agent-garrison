import { NextResponse } from "next/server";
import { readLibrary } from "@/lib/library";
import { startOwnPortFitting, isValidFittingId, vaultEnvForEntry } from "@/lib/own-port-lifecycle";
import { operativeEnvForFitting } from "@/lib/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_: Request, { params }: { params: { id: string } }) {
  try {
    if (!isValidFittingId(params.id)) {
      return NextResponse.json({ error: "invalid fittingId" }, { status: 400 });
    }
    const library = await readLibrary();
    const entry = library.find((e) => e.id === params.id);
    if (!entry) {
      return NextResponse.json({ error: `fitting ${params.id} not in library` }, { status: 404 });
    }
    // On-demand start is the NORMAL path for non-eager views (up only boots
    // eager ones): when a composition is running, hand the view the same env
    // the runner would at up — gateway URL, composition id, selection config,
    // vault. Otherwise fall back to vault-only (may be locked; then {} — the
    // Fitting starts without its secrets rather than failing).
    const extraEnv = (await operativeEnvForFitting(params.id)) ?? (await vaultEnvForEntry(entry));
    const result = await startOwnPortFitting(entry, extraEnv);
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? "start failed" }, { status: result.status ?? 500 });
    }
    // pid is undefined (and serialized away) on the alreadyRunning path.
    return NextResponse.json({
      ok: true,
      pid: result.pid,
      alreadyRunning: result.alreadyRunning === true,
      healed: result.healed === true
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
