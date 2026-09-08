import { NextResponse } from "next/server";
import { readLibrary } from "@/lib/library";
import { startOwnPortFitting, isValidFittingId } from "@/lib/own-port-lifecycle";
import { desiredEnvForFitting, operativeEnvForFitting } from "@/lib/runner";

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
    // Fittings normally start with the operative at up(); this manual start
    // exists for recovery (a crashed fitting, a fitting started while the
    // operative is down). A consumer-driven heal (drill's run preflight) must
    // NEVER spawn an env-less fitting: without the projected env the
    // automations engine falls back to its default instance ports, comes up
    // healthy, and then poisons every later run with wrong-instance failures
    // nothing repairs. Refusing BEFORE the spawn keeps the honest "not running"
    // failure.
    if (body?.requireCompositionEnv === true && !(await operativeEnvForFitting(params.id))) {
      return NextResponse.json(
        { error: `no running composition provides env for ${params.id}` },
        { status: 409 }
      );
    }
    // The same env the runner would hand it at up (gateway URL, composition
    // id, selection config, vault) when a composition is running, else the
    // active composition's projection over vault env - see desiredEnvForFitting.
    const result = await startOwnPortFitting(entry, await desiredEnvForFitting(entry));
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
