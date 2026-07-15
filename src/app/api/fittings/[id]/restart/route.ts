import { NextResponse } from "next/server";
import { readLibrary } from "@/lib/library";
import { resolveConfigById } from "@/lib/eager-boot";
import { ownPortConfigEnv, restartOwnPortFitting, isValidFittingId, vaultEnvForEntry } from "@/lib/own-port-lifecycle";

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
    // Vault may be locked on this manual path; vaultEnvForEntry returns {} and
    // the Fitting restarts without its secrets rather than failing. Config
    // first so vault/GARRISON_* keys win on collision (mirrors eager-boot) —
    // without the config projection a restart silently reboots the fitting on
    // server defaults (e.g. local-voice losing WHISPER_MODEL).
    const configById = await resolveConfigById();
    const extraEnv = {
      ...ownPortConfigEnv(configById.get(entry.id) ?? {}),
      ...(await vaultEnvForEntry(entry))
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
