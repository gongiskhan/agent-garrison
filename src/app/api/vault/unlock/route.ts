import { NextResponse, type NextRequest } from "next/server";
import { maskSecrets, unlockVault } from "@/lib/vault";
import { healVaultConsumingFittings } from "@/lib/own-port-lifecycle";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await unlockVault(String(body.passphrase ?? ""));
    if (result.unlocked) {
      // Fire-and-forget: an own-port Fitting started keyless (locked vault or
      // the detached eager-boot child) heals the moment the vault opens.
      void healVaultConsumingFittings()
        .then((summary) => {
          if (summary.failed.length > 0) {
            console.warn(
              `[vault] post-unlock heal failures: ${summary.failed
                .map((f) => `${f.id} (${f.error})`)
                .join(", ")}`
            );
          }
        })
        .catch((err) =>
          console.warn(
            `[vault] post-unlock heal failed: ${err instanceof Error ? err.message : String(err)}`
          )
        );
    }
    // unlockVault returns plaintext for its server-side callers; the HTTP
    // response must not. This was the second route that handed the whole vault
    // to the browser (the first being GET /api/vault/secrets).
    return NextResponse.json({ ...result, secrets: maskSecrets(result.secrets) });
  } catch (error) {
    return jsonError(error, 400);
  }
}
