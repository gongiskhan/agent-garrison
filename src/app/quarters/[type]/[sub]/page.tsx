import { notFound, redirect } from "next/navigation";
import { resolveRuntimeQuarters, declaredFiles } from "@/lib/quarters-runtimes";
import { RuntimeFileEditor, RuntimeLogsTail } from "@/components/quarters/RuntimeGenericPanels";

export const dynamic = "force-dynamic";

// The Quarters RUNTIME dimension (GARRISON-RUNTIMES-V1 P5/D5/D6).
// URL shape: /quarters/<runtime-fitting-id>/<category>. The level-1 segment
// is named [type] only because Next.js forbids sibling dynamic segments with
// different names — here it is the runtime fitting id, validated against the
// composition. The claude-code DEEP surface stays at /quarters/<category>
// (one segment), completely untouched; its descriptor registration redirects
// /quarters/claude-code-runtime/<cat> there.
export default async function RuntimeQuartersPage({ params }: { params: { type: string; sub: string } }) {
  const entries = await resolveRuntimeQuarters();
  const entry = entries.find((e) => e.fittingId === params.type);
  if (!entry) notFound();

  if (entry.descriptor.tier === "deep") {
    // Registered deep implementation (claude-code): same routes, same panels.
    if (entry.deepRouteBase) redirect(`${entry.deepRouteBase}/${params.sub}`);
    notFound();
  }

  const descriptor = entry.descriptor;
  const categories = descriptor.categories ?? ["settings", "context", "mcps", "logs"];
  if (!categories.includes(params.sub)) notFound();

  const files = declaredFiles(descriptor);
  const warning = entry.homeDirExists === false ? entry.warnings.join("; ") : null;

  return (
    <div className="runtime-quarters">
      <header className="runtime-quarters-head">
        <h1>
          {entry.engine} · {params.sub}
        </h1>
        <p className="hint">
          Generic Quarters tier rendered from the {entry.fittingId} descriptor — the engine&apos;s REAL native
          config, not a Garrison mirror.
        </p>
        {warning ? <div className="banner warn">{warning}</div> : null}
      </header>
      {params.sub === "settings"
        ? files
            .filter((f) => f.kind === "settings")
            .map((f) => <RuntimeFileEditor key={f.path} rid={entry.fittingId} declaredPath={f.path} />)
        : null}
      {params.sub === "context"
        ? files
            .filter((f) => f.kind === "context")
            .map((f) => <RuntimeFileEditor key={f.path} rid={entry.fittingId} declaredPath={f.path} />)
        : null}
      {params.sub === "mcps"
        ? files
            .filter((f) => f.kind === "mcp")
            .map((f) => (
              <div key={f.path}>
                <p className="hint">
                  MCP servers live under the <code>{descriptor.mcp_config?.key ?? "mcp"}</code> key of this file.
                </p>
                <RuntimeFileEditor rid={entry.fittingId} declaredPath={f.path} />
              </div>
            ))
        : null}
      {params.sub === "logs" ? <RuntimeLogsTail rid={entry.fittingId} /> : null}
    </div>
  );
}
