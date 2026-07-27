import { NextResponse } from "next/server";
import { readLibrary } from "@/lib/library";
import { restartOwnPortFitting, isValidFittingId, vaultEnvForEntry } from "@/lib/own-port-lifecycle";
import { operativeEnvForFitting } from "@/lib/runner";
import { activeCompositionEnvForFitting } from "@/lib/eager-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Stop-then-start an own-port Fitting under one lock so it reloads its code
// without cycling the operative. The reload path for eager (always-on)
// Fittings, which `down` deliberately leaves running.
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
    // Same env parity as the start route: a running composition's env
    // (gateway URL, composition id, selection config, vault) when available,
    // else the ACTIVE composition's projection over vault env. This is the
    // control used to reload an eager Fitting after a code change, so it runs
    // routinely while the operative is down - the exact case where a
    // vault-only fallback dropped the port and moved the Fitting onto another
    // instance's, silently breaking every link to its view.
    const extraEnv =
      (await operativeEnvForFitting(params.id)) ?? {
        ...(await vaultEnvForEntry(entry)),
        ...(await activeCompositionEnvForFitting(params.id))
      };
    const result = await restartOwnPortFitting(entry, extraEnv);
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? "restart failed" }, { status: result.status ?? 500 });
    }
    return NextResponse.json({ ok: true, pid: result.pid, healed: result.healed === true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
