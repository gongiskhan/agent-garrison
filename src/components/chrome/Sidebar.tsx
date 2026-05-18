"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import {
  ChevronLeft,
  ChevronRight,
  Home,
  Layers,
  Library,
  Play,
  MessageSquare,
  Lock,
  Component,
  Wrench,
  ExternalLink
} from "lucide-react";
import { useAppShell } from "./AppShell";
import { faculties, isOwnPortFaculty } from "@/lib/faculties";
import { useToolDiscovery, type ToolWithHealth } from "@/components/tools/useToolDiscovery";
import type {
  Composition,
  FacultyId,
  LibraryEntry
} from "@/lib/types";

export function Sidebar() {
  const pathname = usePathname() ?? "/";
  const { composition, library, runnerState, sidebarCollapsed, toggleSidebar } = useAppShell();

  const stationedCount = countStationed(composition);
  const totalFaculties = faculties.length;
  const armoryCount = library.length;
  const verifyResults = runnerState?.verifyResults ?? [];
  const verifyTotal = verifyResults.length;
  const verifyOk = verifyResults.filter((r) => r.ok).length;
  const status = runnerState?.status ?? "idle";
  const isRunning = status === "running";

  const isCompose = pathname === "/compose" || pathname.startsWith("/compose/");

  if (sidebarCollapsed) {
    return (
      <aside
        className="side"
        style={{ padding: "10px 4px", alignItems: "center", overflow: "hidden" }}
      >
        <button
          type="button"
          onClick={toggleSidebar}
          title="Expand sidebar"
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: "var(--mute)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 6,
            width: "100%",
          }}
        >
          <ChevronRight size={16} aria-hidden />
        </button>
        <Link href="/" title="Agent Garrison" style={{ display: "block", marginTop: 8, lineHeight: 0 }}>
          <svg viewBox="0 0 80 80" fill="none" width={32} height={32} aria-hidden>
            <path
              d="M14 24 L19 18 L24 24 L24 64 L14 64 Z M28 20 L33 14 L38 20 L38 64 L28 64 Z M42 24 L47 18 L52 24 L52 64 L42 64 Z M56 20 L61 14 L66 20 L66 64 L56 64 Z"
              fill="#18211c"
            />
            <rect x="10" y="40" width="60" height="3" fill="#b4862a" />
          </svg>
        </Link>
      </aside>
    );
  }

  return (
    <aside className="side">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingBottom: 2 }}>
        <Link className="brand" href="/" style={{ flex: 1, paddingBottom: 0, borderBottom: "none", marginBottom: 0 }}>
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
        <button
          type="button"
          onClick={toggleSidebar}
          title="Collapse sidebar"
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: "var(--mute)",
            display: "flex",
            alignItems: "center",
            padding: 4,
            flexShrink: 0,
          }}
        >
          <ChevronLeft size={14} aria-hidden />
        </button>
      </div>
      <div style={{ borderBottom: "1px solid var(--rule)", marginBottom: 0 }} />

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
        <NavLink href="/tools" pathname={pathname} icon={<Wrench aria-hidden />} label="Tools" />
        <NavLink href="/vault" pathname={pathname} icon={<Lock aria-hidden />} label="Vault" />

        <FittingViewsLinks
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

function FittingViewsLinks({
  composition,
  library,
  pathname
}: {
  composition: Composition | null;
  library: LibraryEntry[];
  pathname: string;
}) {
  const { entries: toolEntries } = useToolDiscovery();

  if (!composition) return null;

  const selectedIds = new Set<string>();
  for (const selections of Object.values(composition.selections)) {
    for (const selection of selections ?? []) {
      selectedIds.add(selection.id);
    }
  }
  const stationed = library.filter((entry) => selectedIds.has(entry.id));

  // Embedded views: Fittings whose metadata declares a sidebar-surface view.
  // Routed to /fitting/<id> inside Garrison.
  const embedded = stationed.filter((entry) =>
    (entry.metadata.ui?.views ?? []).some(
      (view) => view.placement === "sidebar-surface"
    )
  );

  // Own-port views: tool Fittings whose Faculty is in OWN_PORT_FACULTIES.
  // They register at runtime via ~/.garrison/ui-fittings/<id>.json; the
  // useToolDiscovery hook surfaces health + URL.
  const ownPort = stationed.filter((entry) => isOwnPortFaculty(entry.faculty));

  const toolByFittingId = new Map<string, ToolWithHealth>(
    toolEntries.map((t) => [t.fittingId, t])
  );

  type Row =
    | { kind: "embedded"; entry: LibraryEntry }
    | { kind: "own-port"; entry: LibraryEntry; tool: ToolWithHealth | null };

  const rows: Row[] = [
    ...embedded.map((entry) => ({ kind: "embedded" as const, entry })),
    ...ownPort.map((entry) => ({
      kind: "own-port" as const,
      entry,
      tool: toolByFittingId.get(entry.id) ?? null
    }))
  ].sort((a, b) => a.entry.name.localeCompare(b.entry.name));

  if (rows.length === 0) return null;

  return (
    <div className="nested" style={{ marginTop: 12 }}>
      <div className="group-h">Views</div>
      {rows.map((row) => {
        if (row.kind === "embedded") {
          const href = `/fitting/${row.entry.id}`;
          const isActive =
            pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={`embedded:${row.entry.id}`}
              href={href}
              className={clsx("leaf", "verified", isActive && "active")}
            >
              <span className="glyph">
                <Component size={14} aria-hidden />
              </span>
              <span>{row.entry.name}</span>
            </Link>
          );
        }
        const tool = row.tool;
        const healthy = tool?.healthy === true;
        const statusClass = healthy ? "verified" : tool?.healthy === false ? "alarm" : "empty";
        if (healthy && tool) {
          return (
            <a
              key={`own-port:${row.entry.id}`}
              href={tool.url}
              target="_blank"
              rel="noopener noreferrer"
              className={clsx("leaf", statusClass)}
              title={`Open ${row.entry.name} in new tab (${tool.url})`}
            >
              <span className="glyph">
                <ExternalLink size={14} aria-hidden />
              </span>
              <span>{row.entry.name}</span>
            </a>
          );
        }
        // Not running — render disabled-ish row pointing to /fitting/<id>
        // overview where the user can read about it and find the start command.
        const fallbackHref = `/fitting/${row.entry.id}`;
        const isActive =
          pathname === fallbackHref || pathname.startsWith(`${fallbackHref}/`);
        return (
          <Link
            key={`own-port:${row.entry.id}`}
            href={fallbackHref}
            className={clsx("leaf", statusClass, isActive && "active")}
            title={tool?.healthy === false ? "Tool is unreachable" : "Tool is not running"}
          >
            <span className="glyph">
              <ExternalLink size={14} aria-hidden />
            </span>
            <span>{row.entry.name}</span>
            <span className="badge">{tool?.healthy === false ? "down" : "off"}</span>
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
