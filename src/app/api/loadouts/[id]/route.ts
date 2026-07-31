import { NextResponse } from "next/server";
import { unlink } from "node:fs/promises";
import { loadoutPath, readLoadout, renderLoadoutEnv } from "@/lib/loadout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

//   GET    /api/loadouts/<id>          -> { loadout }
//   DELETE /api/loadouts/<id>          -> { ok }
//   GET    /api/loadouts/<id>?dryRun=1 -> { loadout, envNames, missing }
//
// The dry run is the pre-flight for a dispatch: it renders the .env exactly as
// the claim route would and reports WHICH NAMES resolved and which are missing —
// never a value. Getting this wrong on a remote machine costs a claim, a lease
// and a confusing "materialization failed" on the board; getting it wrong here
// costs an HTTP request.
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const loadout = await readLoadout(params.id);
    if (!loadout) return NextResponse.json({ error: "not found" }, { status: 404 });

    const dryRun = new URL(request.url).searchParams.get("dryRun");
    if (!dryRun) return NextResponse.json({ loadout });

    // renderLoadoutEnv reads the vault and returns { content, resolved, missing }.
    // `content` is the rendered .env body — it MUST NOT cross this boundary.
    // Return only the per-name resolution: which vault key supplied each value,
    // and which names found nothing.
    //
    // A locked vault is a 409, not a 500: it is a precondition the caller can
    // fix, and it must not read as "the loadout is broken".
    let rendered;
    try {
      rendered = await renderLoadoutEnv(loadout);
    } catch (error) {
      const message = (error as Error).message || "";
      if (/locked/i.test(message)) {
        return NextResponse.json(
          { error: "vault is locked", detail: "unlock the vault to dry-run env resolution", loadout },
          { status: 409 }
        );
      }
      throw error;
    }
    const { resolved, missing } = rendered;
    return NextResponse.json({
      loadout,
      resolved: resolved.map((r) => ({ name: r.name, source: r.source, found: r.found })),
      missing
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  try {
    const loadout = await readLoadout(params.id);
    if (!loadout) return NextResponse.json({ error: "not found" }, { status: 404 });
    // readLoadout already proved the id resolves to a real descriptor, so the
    // path is the one it read — no id string reaches the filesystem unchecked.
    await unlink(loadoutPath(loadout.id));
    return NextResponse.json({ ok: true, id: loadout.id });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
