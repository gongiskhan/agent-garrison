import { NextResponse, type NextRequest } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { authenticateMachine } from "@/lib/dispatch-machines";
import { readAllCards } from "@/lib/dispatch";
import { jsonError } from "@/lib/http";
import { dispatchEvidenceDir, SAFE_DISPATCH_EVIDENCE_NAME } from "@/lib/dispatch-evidence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Evidence copy-back (brief D7, full-copy variant). The worker uploads its
// logs / transcript / captures here and they land on the HOST, so the board
// stays self-contained: evidence survives the outpost going offline or being
// wiped, which a link back to the machine would not.
//
// Phase 0 finding: there is no artifact store to upload into.
// `src/lib/artifact-store.ts` — named in CLAUDE.md — does not exist; evidence is
// just files under the card's directory that the board reads. So this writes
// there, under a `dispatch/` subdirectory that marks its provenance.

// Reject anything that is not a plain filename. A worker is a remote,
// token-authenticated caller: treat its filenames as hostile input, or one
// "../../.." writes outside the card entirely.
const MAX_BYTES = 25 * 1024 * 1024;

export async function POST(request: NextRequest) {
  try {
    const machine = await authenticateMachine(request.headers.get("authorization"));
    if (!machine) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const body = (await request.json().catch(() => ({}))) as {
      cardId?: unknown;
      workerId?: unknown;
      runId?: unknown;
      name?: unknown;
      contentBase64?: unknown;
    };
    const cardId = typeof body.cardId === "string" ? body.cardId.trim() : "";
    const workerId = typeof body.workerId === "string" ? body.workerId.trim() : "";
    const runId = typeof body.runId === "string" ? body.runId.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const contentBase64 = typeof body.contentBase64 === "string" ? body.contentBase64 : "";

    if (!cardId) return jsonError(new Error("cardId is required"), 400);
    if (!SAFE_DISPATCH_EVIDENCE_NAME.test(name)) return jsonError(new Error(`unsafe evidence name: ${name}`), 400);

    const card = (await readAllCards()).find((c) => c.id === cardId);
    if (!card) return NextResponse.json({ error: "no such card" }, { status: 404 });

    const owned =
      card.dispatch && card.dispatch.machine === machine && card.dispatch.workerId === workerId && card.dispatch.runId === runId;
    if (!owned) {
      return NextResponse.json({ error: "claim not held by this worker" }, { status: 409 });
    }

    const buffer = Buffer.from(contentBase64, "base64");
    if (buffer.byteLength > MAX_BYTES) {
      return jsonError(new Error(`evidence too large: ${buffer.byteLength} bytes`), 413);
    }

    // Resolve, then verify containment. Belt-and-braces with SAFE_NAME: the
    // regex is the rule, this is the proof.
    const dir = dispatchEvidenceDir(cardId, runId);
    const target = path.resolve(dir, name);
    if (path.dirname(target) !== path.resolve(dir)) {
      return jsonError(new Error("evidence path escapes the card directory"), 400);
    }

    await mkdir(dir, { recursive: true });
    await writeFile(target, buffer, { mode: 0o600 });
    // The Kanban engine's tangible-evidence contract reads <runDir>/evidence/.
    // Keep the upload API filename-only, then project non-log artifacts into
    // that directory on the host. The original remains beside the manifest for
    // a self-contained dispatch bundle.
    if (name !== "transcript.md" && name !== "materialize.md" && !name.startsWith("gate-status.")) {
      const evidenceDir = path.join(dir, "evidence");
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(path.join(evidenceDir, name), buffer, { mode: 0o600 });
    }

    return NextResponse.json({
      ok: true,
      bytes: buffer.byteLength,
      name,
      sha256: crypto.createHash("sha256").update(buffer).digest("hex")
    });
  } catch (error) {
    return jsonError(error, 400);
  }
}
