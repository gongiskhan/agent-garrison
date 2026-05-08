"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import {
  Home,
  Layers,
  Library,
  Play,
  MessageSquare,
  Lock,
  Component
} from "lucide-react";
import { useAppShell } from "./AppShell";
import { faculties } from "@/lib/faculties";
import type {
  FacultyId,
  FacultyDefinition,
  Composition,
  LibraryEntry
} from "@/lib/types";

const facultyGroups: Array<{ label: string; ids: FacultyId[] }> = [
  { label: "Cadence", ids: ["heartbeat", "scheduler"] },
  { label: "Context", ids: ["data-sources", "knowledge-base", "memory"] },
  { label: "Action", ids: ["automations", "skills", "gateway", "channels"] },
  { label: "Control", ids: ["classifier", "observability", "soul", "orchestrator"] }
];

export function Sidebar() {
  const pathname = usePathname() ?? "/";
  const { composition, library, runnerState } = useAppShell();

  const stationedCount = countStationed(composition);
  const totalFaculties = faculties.length;
  const armoryCount = library.length;
  const verifyResults = runnerState?.verifyResults ?? [];
  const verifyTotal = verifyResults.length;
  const verifyOk = verifyResults.filter((r) => r.ok).length;
  const status = runnerState?.status ?? "idle";
  const isRunning = status === "running";

  const isCompose = pathname === "/compose" || pathname.startsWith("/compose/");

  return (
    <aside className="side">
      <Link className="brand" href="/">
        <span className="brand-mark" aria-hidden>
          <svg viewBox="0 0 80 80" fill="none" width={32} height={32}>
            <path
              d="M14 24 L19 18 L24 24 L24 64 L14 64 Z M28 20 L33 14 L38 20 L38 64 L28 64 Z M42 24 L47 18 L52 24 L52 64 L42 64 Z M56 20 L61 14 L66 20 L66 64 L56 64 Z"
              fill="#18211c"
            />
            <rect x="10" y="40" width="60" height="3" fill="#b4862a" />
          </svg>
        </span>
        <span className="brand-text">
          <span className="name">Agent Garrison</span>
          <span className="sub">v1 · localhost</span>
        </span>
      </Link>

      <nav className="tabs">
        <NavLink href="/" pathname={pathname} icon={<Home aria-hidden />} label="Garrison" />
        <NavLink
          href="/compose"
          pathname={pathname}
          icon={<Layers aria-hidden />}
          label="Compose"
          ct={`${stationedCount}/${totalFaculties}`}
          active={isCompose}
        />

        {isCompose ? (
          <div className="nested">
            {facultyGroups.map((group) => (
              <div key={group.label}>
                <div className="group-h">{group.label}</div>
                {group.ids.map((id) => {
                  const faculty = faculties.find((f) => f.id === id);
                  if (!faculty) return null;
                  return (
                    <FacultyLeaf
                      key={id}
                      faculty={faculty}
                      pathname={pathname}
                      composition={composition}
                      verifyResults={verifyResults}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        ) : null}

        <NavLink
          href="/armory"
          pathname={pathname}
          icon={<Library aria-hidden />}
          label="Armory"
          ct={armoryCount > 0 ? String(armoryCount) : undefined}
        />
        <NavLink
          href="/run"
          pathname={pathname}
          icon={<Play aria-hidden />}
          label="Run"
          ct={isRunning ? "live" : undefined}
        />
        <NavLink href="/chat" pathname={pathname} icon={<MessageSquare aria-hidden />} label="Chat" />
        <NavLink href="/vault" pathname={pathname} icon={<Lock aria-hidden />} label="Vault" />

        <FittingSurfaceLinks
          composition={composition}
          library={library}
          pathname={pathname}
        />
      </nav>

      <div className="side-foot">
        <div className="row">
          <span>operative</span>
          <b>{composition?.name ?? "—"}</b>
        </div>
        <div className="row">
          <span>status</span>
          <span className={clsx("pill", statusToneClass(status), isRunning && "live")}>
            {isRunning ? <span className="dot" /> : null}
            {status}
          </span>
        </div>
        <div className="row">
          <span>verify</span>
          <b>{verifyTotal ? `${verifyOk}/${verifyTotal}` : "—"}</b>
        </div>
        <div className="row">
          <span>pid</span>
          <b>{runnerState?.pid ?? "—"}</b>
        </div>
      </div>
    </aside>
  );
}

function FittingSurfaceLinks({
  composition,
  library,
  pathname
}: {
  composition: Composition | null;
  library: LibraryEntry[];
  pathname: string;
}) {
  if (!composition) return null;
  const selectedIds = new Set<string>();
  for (const selections of Object.values(composition.selections)) {
    for (const selection of selections ?? []) {
      selectedIds.add(selection.id);
    }
  }
  // A Fitting earns a sidebar entry when it is stationed in the composition
  // AND ships at least one sidebar-surface view. Faculty-tab views render
  // inline on the Compose pane; they do not get their own nav row.
  const entries = library
    .filter((entry) => selectedIds.has(entry.id))
    .filter((entry) =>
      (entry.metadata.ui?.views ?? []).some(
        (view) => view.placement === "sidebar-surface"
      )
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  if (entries.length === 0) return null;
  return (
    <div className="nested" style={{ marginTop: 12 }}>
      <div className="group-h">Surfaces</div>
      {entries.map((entry) => {
        const href = `/fitting/${entry.id}`;
        const isActive =
          pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={entry.id}
            href={href}
            className={clsx("leaf", "verified", isActive && "active")}
          >
            <span className="glyph">
              <Component size={14} aria-hidden />
            </span>
            <span>{entry.name}</span>
          </Link>
        );
      })}
    </div>
  );
}

function NavLink({
  href,
  pathname,
  icon,
  label,
  ct,
  active
}: {
  href: string;
  pathname: string;
  icon: ReactNode;
  label: string;
  ct?: string;
  active?: boolean;
}) {
  const isActive = active ?? (href === "/" ? pathname === "/" : pathname === href);
  return (
    <Link href={href} className={clsx("item", isActive && "active")}>
      <span>
        <span className="ic">{icon}</span>
        {label}
      </span>
      {ct ? <span className="ct">{ct}</span> : null}
    </Link>
  );
}

function FacultyLeaf({
  faculty,
  pathname,
  composition,
  verifyResults
}: {
  faculty: FacultyDefinition;
  pathname: string;
  composition: ReturnType<typeof useAppShell>["composition"];
  verifyResults: ReturnType<typeof useAppShell>["runnerState"] extends infer R
    ? NonNullable<R> extends { verifyResults: infer V }
      ? V
      : []
    : [];
}) {
  const selections = composition?.selections[faculty.id] ?? [];
  const stationed = selections.length > 0;
  const isOrchestratorMissing = faculty.id === "orchestrator" && !stationed;

  // Determine status glyph
  let glyph = "·";
  let statusClass = "empty";
  if (isOrchestratorMissing) {
    glyph = "!";
    statusClass = "alarm";
  } else if (stationed) {
    // Check if any of this faculty's selected fittings have failing verify
    const fittingIds = new Set(selections.map((s) => s.id));
    const ownVerifies = (verifyResults as Array<{ fittingId: string; ok: boolean }>).filter((r) =>
      fittingIds.has(r.fittingId)
    );
    if (ownVerifies.length === 0) {
      // Stationed but verify hasn't run — neutral pip, not green.
      glyph = "•";
      statusClass = "empty";
    } else if (ownVerifies.some((r) => !r.ok)) {
      glyph = "!";
      statusClass = "alarm";
    } else {
      glyph = "•";
      statusClass = "verified";
    }
  }

  // Compose a short badge — count for multi, key fact for some singles
  const badge = stationed ? badgeFor(faculty.id, selections) : "—";

  const href = `/compose/${faculty.id}`;
  const isActive = pathname === href;

  return (
    <Link
      href={href}
      className={clsx("leaf", statusClass, isActive && "active")}
    >
      <span className="glyph">{glyph}</span>
      <span>{faculty.name}</span>
      <span className="badge">{badge}</span>
    </Link>
  );
}

function badgeFor(
  id: FacultyId,
  selections: Array<{ id: string; config: Record<string, string | number | boolean> }>
): string {
  if (selections.length === 0) return "—";
  if (selections.length > 1) return String(selections.length);
  const sel = selections[0];
  switch (id) {
    case "heartbeat": {
      const m = sel.config?.cadence_minutes;
      return typeof m === "number" || typeof m === "string" ? `${m}m` : "loop";
    }
    case "gateway": {
      const p = sel.config?.port;
      return p ? `:${p}` : "1";
    }
    case "classifier": {
      const t = sel.config?.tier_floor;
      return t ? `T${t}` : "1";
    }
    case "memory":
      return "ƒ";
    default:
      return "1";
  }
}

function countStationed(composition: ReturnType<typeof useAppShell>["composition"]): number {
  if (!composition) return 0;
  let count = 0;
  for (const id of Object.keys(composition.selections)) {
    if ((composition.selections[id as FacultyId]?.length ?? 0) > 0) count += 1;
  }
  return count;
}

function statusToneClass(status: string): string {
  if (status === "running") return "";
  if (status === "failed") return "alarm";
  if (status === "starting" || status === "verifying" || status === "stopping") return "warn";
  return "idle";
}
