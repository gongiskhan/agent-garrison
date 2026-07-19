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
  const { composition, library, error, refreshAll } = useAppShell();
  const fittingId = singleParam(params?.fittingId);
  const restSegments = arrayParam(params?.rest);
  const subPath = "/" + restSegments.join("/");

  if (!fittingId) {
    return (
      <SurfaceMessage
        eyebrow="Fitting surface"
        title="No Fitting selected"
        body="Choose a stationed Fitting from the Garrison navigation."
      />
    );
  }
  if (!composition) {
    return error ? (
      <SurfaceMessage
        eyebrow="Composition unavailable"
        title="Could not load this Fitting"
        body={error}
        tone="error"
        action={{ label: "Try again", onClick: () => void refreshAll() }}
      />
    ) : (
      <SurfaceMessage
        eyebrow="Reading composition"
        title="Loading Fitting…"
        body="Resolving its station, capabilities, and views."
        loading
      />
    );
  }

  // The Fitting must be present in the library AND selected in the
  // composition. A catch-all page that rendered surfaces for unselected
  // Fittings would let stale links to retired Fittings keep working — and the
  // sidebar links into here will only ever come from selected Fittings.
  const entry = library.find((candidate) => candidate.id === fittingId);
  if (!entry) {
    return (
      <SurfaceMessage
        eyebrow="Fitting unavailable"
        title={`Fitting "${fittingId}" not found`}
        body="It is not present in the Armory."
        tone="error"
      />
    );
  }
  const selection = Object.values(composition.selections)
    .flat()
    .find((sel) => sel?.id === fittingId);
  if (!selection) {
    return (
      <SurfaceMessage
        eyebrow="Station required"
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

  // Full-bleed views (chrome: "full-bleed" in x-garrison.ui.views) own the
  // whole estate: no overview header, no width cap — for views that need to
  // maximize usable area.
  if (match?.view.chrome === "full-bleed") {
    return (
      <main className="min-w-0 bg-[var(--paper)] p-2.5 sm:p-3.5">
        <FittingView
          entry={entry}
          selection={selection}
          view={match.view}
          params={match.params}
        />
      </main>
    );
  }

  return (
    <main className="w-full max-w-[1080px] px-5 py-8 sm:px-8 lg:px-12 lg:py-12">
      <div className="crumbs mb-6">
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
      <header className="mb-8 grid gap-3 border-l-2 border-[var(--brass)] pl-5 sm:pl-6">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--brass)]">
          Stationed Fitting · {entry.metadata.component_shape}
          {faculty ? ` · ${faculty.name} faculty` : ""}
        </div>
        <h1 className="font-display m-0 max-w-[18ch] text-[clamp(2rem,5vw,3.25rem)] font-semibold leading-[0.98] tracking-[-0.035em] text-[var(--ink)]">
          {entry.name}
        </h1>
        <p className="m-0 max-w-[66ch] text-[15px] leading-7 text-[var(--ink-mute)]">
          {entry.summary}
        </p>
      </header>

      <FittingOverview entry={entry} composition={composition} library={library} />

      {match ? (
        <section className="mt-10 border-t border-[var(--rule-2)] pt-7">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.17em] text-[var(--brass)]">
            Live surface · {match.view.id}
          </div>
          <div className="mb-5 font-mono text-[11px] text-[var(--mute)]">
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
          className="mt-10 border border-dashed border-[var(--rule-2)] border-l-[3px] border-l-[var(--alarm)] bg-[var(--surface)] px-4 py-3 text-[13px] leading-6 text-[var(--mute)]"
          role="alert"
        >
          <b className="text-[var(--ink)]">Surface unavailable.</b>{" "}
          No view in {entry.name} matches <code>{subPath}</code>.
        </section>
      ) : null}
    </main>
  );
}

function SurfaceMessage({
  eyebrow,
  title,
  body,
  tone = "neutral",
  loading = false,
  action
}: {
  eyebrow: string;
  title: string;
  body?: string;
  tone?: "neutral" | "error";
  loading?: boolean;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <main
      className="grid min-h-[58dvh] place-items-center px-5 py-12 sm:px-8"
      aria-busy={loading || undefined}
    >
      <section
        className="w-full max-w-xl border-l-[3px] bg-[var(--surface)] px-5 py-6 sm:px-7 sm:py-8"
        style={{ borderLeftColor: tone === "error" ? "var(--alarm)" : "var(--brass)" }}
        role={tone === "error" ? "alert" : loading ? "status" : undefined}
      >
        <div
          className="font-mono text-[10px] uppercase tracking-[0.18em]"
          style={{ color: tone === "error" ? "var(--alarm)" : "var(--brass)" }}
        >
          {eyebrow}
        </div>
        <h1 className="font-display mb-0 mt-2 text-2xl font-semibold leading-tight tracking-[-0.02em] text-[var(--ink)]">
          {title}
        </h1>
        {body ? <p className="mb-0 mt-3 max-w-[58ch] text-sm leading-6 text-[var(--mute)]">{body}</p> : null}
        {loading ? (
          <div className="mt-5 grid gap-2" aria-hidden>
            <span className="skeleton-line h-2.5 w-4/5 rounded-sm" />
            <span className="skeleton-line h-2.5 w-3/5 rounded-sm" />
          </div>
        ) : null}
        {action ? (
          <button
            type="button"
            className="btn small primary mt-5 active:translate-y-px"
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ) : null}
      </section>
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
