"use client";

import { useParams } from "next/navigation";
import { useAppShell } from "@/components/chrome/AppShell";
import { matchView } from "@/lib/fitting-views";
import { faculties } from "@/lib/faculties";
import { isOwnPortFitting } from "@/lib/faculties";
import { FittingView } from "./FittingView";
import { OwnPortStatusPanel } from "./OwnPortStatusPanel";

// /fitting/<id>[/<rest>] — the Fitting's VIEW is the page (2026-07-29
// fittings/views refit: every Fitting has a view, and the former
// overview/config page is gone — composition wiring lives on /compose, files
// in the Muster editor). Own-port Fittings get their status/controls strip
// here; their real UI embeds at /embed/<id> when live.
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
  const ownPort = isOwnPortFitting(entry);

  // Full-bleed views (chrome: "full-bleed" in x-garrison.ui.views) own the
  // whole estate: no header, no width cap — for views that need to maximize
  // usable area.
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
    <main className="w-full max-w-[1160px] px-5 py-7 sm:px-8 lg:px-10">
      <header className="mb-6 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-l-2 border-[var(--brass)] pl-4">
        <h1 className="font-display m-0 text-[clamp(1.4rem,3vw,1.9rem)] font-semibold leading-tight tracking-[-0.02em] text-[var(--ink)]">
          {entry.name}
        </h1>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--brass)]">
          {entry.metadata.component_shape}
          {faculty ? ` · ${faculty.name}` : ""}
        </span>
        <span className="font-mono text-[11px] text-[var(--mute)]">{entry.id}</span>
      </header>

      {match ? (
        <FittingView
          entry={entry}
          selection={selection}
          view={match.view}
          params={match.params}
        />
      ) : hasDeepLink ? (
        <section
          className="border border-dashed border-[var(--rule-2)] border-l-[3px] border-l-[var(--alarm)] bg-[var(--surface)] px-4 py-3 text-[13px] leading-6 text-[var(--mute)]"
          role="alert"
        >
          <b className="text-[var(--ink)]">Surface unavailable.</b>{" "}
          No view in {entry.name} matches <code>{subPath}</code>.
        </section>
      ) : ownPort ? (
        <OwnPortStatusPanel entry={entry} />
      ) : (
        <SurfaceMessage
          eyebrow="No view at this route"
          title={`${entry.name} declares no root view`}
          body="Its views render elsewhere (a Compose-pane tab), or the manifest needs a ui.views entry — every Fitting has a view."
        />
      )}
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
