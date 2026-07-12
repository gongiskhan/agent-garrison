import { NextResponse } from "next/server";
import { resolveActiveComposition } from "@/lib/active-composition";
import { readComposition, selectedLibraryEntries } from "@/lib/compositions";
import { resolvePrimaryFromPolicy } from "@/lib/runner";
import { resolvePrimaryRuntime, type RuntimeEntry } from "@/lib/runtime-selection";
import { degradationsForEngine, isEnforcementDegraded } from "@/lib/runtime-degradations";

// GET /api/runtime/active — the active composition's resolved primary runtime
// engine + the enforcement-plane degradations in force for it (WS2 slice S2d).
// Non-fatal by design: any resolution error falls back to the claude-code
// default (no degradation) rather than 500ing the UI.
export async function GET() {
  try {
    const active = await resolveActiveComposition();
    const composition = await readComposition(active.id);
    const policyPrimary = await resolvePrimaryFromPolicy(active.dir).catch(() => null);
    const legacyPrimary = (composition.globalConfig.primary_runtime ?? "").trim() || null;
    const effectivePrimary = policyPrimary ?? legacyPrimary ?? undefined;

    const entries = await selectedLibraryEntries(composition.selections);
    const runtimeEntries: RuntimeEntry[] = (composition.selections.runtimes ?? []).map((sel) => ({
      id: sel.id,
      provides: entries.find((e) => e.id === sel.id)?.metadata.provides ?? [],
      config: sel.config ?? {}
    }));

    const resolved = resolvePrimaryRuntime({
      primaryRuntimeId: effectivePrimary,
      runtimeEntries
    });

    return NextResponse.json({
      compositionId: active.id,
      runtimeId: resolved.runtimeId,
      engine: resolved.engine,
      isClaudeCode: !isEnforcementDegraded(resolved.engine),
      degradations: degradationsForEngine(resolved.engine),
      doc: "docs/RUNTIME_DEGRADATIONS.md"
    });
  } catch {
    // A composition that can't resolve a primary safely reads as claude-code.
    return NextResponse.json({
      compositionId: null,
      runtimeId: "claude-code-runtime",
      engine: "claude-code",
      isClaudeCode: true,
      degradations: [],
      doc: "docs/RUNTIME_DEGRADATIONS.md"
    });
  }
}
