"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useAppShell } from "@/components/chrome/AppShell";
import { matchView } from "@/lib/fitting-views";
import { faculties } from "@/lib/faculties";
import { FittingView } from "./FittingView";
import { FittingOverview } from "./FittingOverview";

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

  const faculty = faculties.find((f) => f.id === entry.faculty);
  const match = entry.metadata.ui
    ? matchView(entry.metadata.ui.views, subPath, "sidebar-surface")
    : null;
  const hasDeepLink = subPath !== "/";

  return (
    <main style={{ padding: "32px 36px", maxWidth: 880 }}>
      <div className="crumbs" style={{ marginBottom: 16 }}>
        <Link href="/compose">Compose</Link>
        {faculty ? (
          <>
            {" · "}
            <Link href={`/compose/${faculty.id}`}>{faculty.name}</Link>
          </>
        ) : null}
        {" · "}
        <b>{entry.name}</b>
      </div>
      <header style={{ marginBottom: 24 }}>
        <div
          className="font-mono"
          style={{
            fontSize: 10.5,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: "var(--brass)",
            marginBottom: 6
          }}
        >
          Fitting · {entry.metadata.component_shape}
          {faculty ? ` · ${faculty.name} faculty` : ""}
        </div>
        <h1
          className="font-display"
          style={{
            fontWeight: 600,
            fontSize: 30,
            letterSpacing: "-0.012em",
            lineHeight: 1.1,
            margin: "0 0 8px"
          }}
        >
          {entry.name}
        </h1>
        <p
          style={{
            fontSize: 14,
            lineHeight: 1.55,
            color: "var(--ink-mute)",
            margin: 0,
            maxWidth: 640
          }}
        >
          {entry.summary}
        </p>
      </header>

      <FittingOverview entry={entry} composition={composition} library={library} />

      {match ? (
        <section style={{ marginTop: 28 }}>
          <div
            className="lab"
            style={{ marginBottom: 4 }}
          >
            {entry.name} · {match.view.id}
          </div>
          <div
            className="font-mono"
            style={{ fontSize: 11, color: "var(--mute)", marginBottom: 14 }}
          >
            /fitting/{fittingId}{subPath === "/" ? "" : subPath}
          </div>
          <FittingView
            entry={entry}
            selection={selection}
            view={match.view}
            params={match.params}
          />
        </section>
      ) : hasDeepLink ? (
        <section
          style={{
            marginTop: 28,
            padding: "10px 14px",
            background: "var(--paper-2)",
            border: "1px dashed var(--rule-2)",
            color: "var(--mute)",
            fontSize: 12.5
          }}
        >
          No view in {entry.name} matches <code>{subPath}</code>.
        </section>
      ) : null}
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
