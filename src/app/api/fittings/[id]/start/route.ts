import { NextResponse } from "next/server";
import { readLibrary } from "@/lib/library";
import { startOwnPortFitting, isValidFittingId, vaultEnvForEntry } from "@/lib/own-port-lifecycle";
import { operativeEnvForFitting } from "@/lib/runner";
import { activeCompositionEnvForFitting } from "@/lib/eager-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    if (!isValidFittingId(params.id)) {
      return NextResponse.json({ error: "invalid fittingId" }, { status: 400 });
    }
    const library = await readLibrary();
    const entry = library.find((e) => e.id === params.id);
    if (!entry) {
      return NextResponse.json({ error: `fitting ${params.id} not in library` }, { status: 404 });
    }
    const body = await req.json().catch(() => ({}));
    // On-demand start is the NORMAL path for non-eager views (up only boots
    // eager ones): when a composition is running, hand the view the same env
    // the runner would at up — gateway URL, composition id, selection config,
    // vault. Otherwise fall back to vault-only (may be locked; then {} — the
    // Fitting starts without its secrets rather than failing).
    const compositionEnv = await operativeEnvForFitting(params.id);
    // A consumer-driven heal (drill's run preflight) must NEVER spawn an
    // env-less fitting: without the projected env the automations engine
    // falls back to its default instance ports, comes up healthy, and then
    // poisons every later run with wrong-instance failures nothing repairs.
    // Refusing BEFORE the spawn keeps the honest "not running" failure.
    if (body?.requireCompositionEnv === true && !compositionEnv) {
      return NextResponse.json(
        { error: `no running composition provides env for ${params.id}` },
        { status: 409 }
      );
    }
    // No RUNNING composition does not mean no KNOWN config: the active
    // composition is on disk regardless. Falling back to vault-only here
    // dropped the fitting's whole config projection - including its port - so
    // it booted on its baked-in default and answered for another instance.
    // Project from the active composition instead, with vault underneath.
    const extraEnv =
      compositionEnv ?? {
        ...(await vaultEnvForEntry(entry)),
        ...(await activeCompositionEnvForFitting(params.id))
      };
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
