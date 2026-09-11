import { NextResponse, type NextRequest } from "next/server";
import { getInstallStatus, install, disable, backupNow } from "@/lib/install-state";
import { reconcileHomes } from "@/lib/homes-migration";
import { checkHomeLeaks, quarantineHomeLeaks } from "@/lib/home-leaks";
import { readNodeIdentity } from "@/lib/node-identity";
import { resolveActiveComposition } from "@/lib/active-composition";
import { readComposition } from "@/lib/compositions";
import { crossSiteBlocked } from "@/lib/mesh/peer-auth";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The machine-level install gate for Garrison's management of ~/.claude.
//   GET                    -> current install status (+ grandfather materialisation)
//   POST { action:"install" } -> snapshot the pristine config, then enable management
//   POST { action:"disable" } -> stop managing (no restore; Phase 4 owns Uninstall)
//   POST { action:"backup" }  -> snapshot current config on demand

export async function GET() {
  try {
    return NextResponse.json(await getInstallStatus());
  } catch (error) {
    return jsonError(error, 400);
  }
}

export async function POST(request: NextRequest) {
  const blocked = crossSiteBlocked(request);
  if (blocked) return blocked;
  try {
    const body = await request.json().catch(() => ({}));
    const action = String(body?.action ?? "");
    switch (action) {
      case "reconcile-homes": {
        const active = await resolveActiveComposition();
        const migration = await reconcileHomes(await readComposition(active.id));
        return NextResponse.json({ ...(await getInstallStatus()), migration, homes: await checkHomeLeaks(), node: readNodeIdentity().id });
      }
      case "quarantine-leaks": {
        const result = await quarantineHomeLeaks();
        return NextResponse.json({ ...(await getInstallStatus()), ...result, homes: result.report, node: readNodeIdentity().id });
      }
      case "install":
        return NextResponse.json(await install());
      case "disable":
        return NextResponse.json(await disable());
      case "backup": {
        const { dir } = await backupNow();
        return NextResponse.json({ ...(await getInstallStatus()), backupDir: dir });
      }
      default:
        return jsonError(new Error(`unknown action "${action}"`), 400);
    }
  } catch (error) {
    return jsonError(error, 400);
  }
}
