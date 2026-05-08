"use client";

import { useParams } from "next/navigation";
import { useAppShell } from "@/components/chrome/AppShell";
import { matchView } from "@/lib/fitting-views";
import { FittingView } from "./FittingView";

export function FittingSurfacePanel() {
  const params = useParams();
  const { composition, library } = useAppShell();
  const fittingId = singleParam(params?.fittingId);
  const restSegments = arrayParam(params?.rest);
  const subPath = "/" + restSegments.join("/");

  if (!fittingId) {
    return <SurfaceMessage title="No Fitting selected" />;
  }
  if (!composition) {
    return <SurfaceMessage title="Loading composition…" />;
  }

  // The Fitting must be present in the library AND selected in the
  // composition. A catch-all page that rendered surfaces for unselected
  // Fittings would let stale links to retired Fittings keep working — and the
  // sidebar links into here will only ever come from selected Fittings.
  const entry = library.find((candidate) => candidate.id === fittingId);
  if (!entry) {
    return (
      <SurfaceMessage
        title={`Fitting "${fittingId}" not found`}
        body="It is not present in the Armory."
      />
    );
  }
  const selection = Object.values(composition.selections)
    .flat()
    .find((sel) => sel?.id === fittingId);
  if (!selection) {
    return (
      <SurfaceMessage
        title={`Fitting "${entry.name}" is not stationed`}
        body="Add it to the Composition to access this surface."
      />
    );
  }
  if (!entry.metadata.ui) {
    return (
      <SurfaceMessage
        title={`${entry.name} ships no UI views`}
        body="This Fitting has no x-garrison.ui.views to render here."
      />
    );
  }
  const match = matchView(entry.metadata.ui.views, subPath, "sidebar-surface");
  if (!match) {
    return (
      <SurfaceMessage
        title={`No view in ${entry.name} matches ${subPath}`}
        body="Check the URL or pick a view from the sidebar."
      />
    );
  }
  return (
    <main style={{ padding: "32px 36px" }}>
      <header style={{ marginBottom: 20 }}>
        <div className="lab" style={{ marginBottom: 4 }}>
          {entry.name} · {match.view.id}
        </div>
        <div
          className="font-mono"
          style={{ fontSize: 11, color: "var(--mute)" }}
        >
          /fitting/{fittingId}{subPath === "/" ? "" : subPath}
        </div>
      </header>
      <FittingView
        entry={entry}
        selection={selection}
        view={match.view}
        params={match.params}
      />
    </main>
  );
}

function SurfaceMessage({ title, body }: { title: string; body?: string }) {
  return (
    <main style={{ padding: "48px 36px" }}>
      <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
        {title}
      </h1>
      {body ? (
        <p style={{ color: "var(--mute)", fontSize: 13 }}>{body}</p>
      ) : null}
    </main>
  );
}

function singleParam(value: string | string[] | undefined): string | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function arrayParam(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
