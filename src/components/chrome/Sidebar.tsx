"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import {
  ChevronLeft,
  ChevronRight,
  Home,
  Layers,
  Lock,
  Component,
  ExternalLink,
  LayoutGrid,
  Globe,
  SquareTerminal,
  Sparkles,
  Route,
  Activity,
  ScreenShare,
  Mic,
  MessagesSquare,
  Archive,
  Radio,
  Brain,
  Database,
  Cpu,
  Network,
  type LucideIcon
} from "lucide-react";
import { useAppShell } from "./AppShell";
import { faculties, isOwnPortFitting } from "@/lib/faculties";
import { useFittingViewStatus, type FittingViewStatus } from "@/components/fitting-views/useFittingViewStatus";
import type {
  CapabilityKind,
  Composition,
  FacultyId,
  LibraryEntry
} from "@/lib/types";

export function Sidebar() {
  const pathname = usePathname() ?? "/";
  const { composition, library, runnerState, sidebarCollapsed, toggleSidebar } = useAppShell();
  const { entries: viewStatuses } = useFittingViewStatus();

  const stationedCount = countStationed(composition);
  const totalFaculties = faculties.length;
  const verifyResults = runnerState?.verifyResults ?? [];
  const verifyTotal = verifyResults.length;
  const verifyOk = verifyResults.filter((r) => r.ok).length;
  const status = runnerState?.status ?? "idle";
  const isRunning = status === "running";
  const liveViews = viewStatuses.filter((s) => s.healthy === true).length;
  const knownViews = viewStatuses.length;

  const isCompose = pathname === "/compose" || pathname.startsWith("/compose/");

  // Live-ticking uptime while the operative is up. Recomputed each second so
  // the footer reads like a running clock rather than a stale snapshot.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!isRunning || !runnerState?.startedAt) {
      setNow(null);
      return;
    }
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isRunning, runnerState?.startedAt]);
  const uptime =
    isRunning && runnerState?.startedAt && now
      ? formatUptime(now - new Date(runnerState.startedAt).getTime())
      : "—";

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
          label="Composition"
          ct={`${stationedCount}/${totalFaculties}`}
          active={isCompose}
        />
        <NavLink href="/vault" pathname={pathname} icon={<Lock aria-hidden />} label="Vault" />
        <NavLink
          href="/quarters"
          pathname={pathname}
          icon={<LayoutGrid aria-hidden />}
          label="Quarters"
          active={pathname === "/quarters" || pathname.startsWith("/quarters/")}
        />
        <NavLink
          href="/coordination"
          pathname={pathname}
          icon={<Network aria-hidden />}
          label="Coordination"
          active={pathname === "/coordination" || pathname.startsWith("/coordination")}
        />

        <FittingViewsLinks
          composition={composition}
          library={library}
          pathname={pathname}
          viewStatuses={viewStatuses}
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
          <span>uptime</span>
          <b>{uptime}</b>
        </div>
        <div className="row">
          <span>verify</span>
          <b>{verifyTotal ? `${verifyOk}/${verifyTotal}` : "—"}</b>
        </div>
        <div className="row">
          <span>views</span>
          <b>{knownViews ? `${liveViews}/${knownViews} live` : "—"}</b>
        </div>
        <div className="row">
          <span>dev · pid</span>
          <b>
            {runnerState?.devMode ? "dev · " : ""}
            {runnerState?.pid ?? "—"}
          </b>
        </div>
      </div>
    </aside>
  );
}

// Matches NARROW_BREAKPOINT in AppShell — below this width the sidebar
// auto-collapses, and own-port views open in a new tab instead of the
// in-app iframe (which would be unusable next to the collapsed sidebar).
const MOBILE_BREAKPOINT = 720;

function useIsMobileViewport(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    function check() {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    }
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  return isMobile;
}

// Per-Fitting icons for the sidebar Views list. Resolution is layered so a
// brand-new own-port Fitting still gets a sensible glyph without editing this
// file: exact id first (most meaningful), then the capability kind it
// provides, then its Faculty role, then a generic embedded/own-port fallback.
const VIEW_ICON_BY_ID: Record<string, LucideIcon> = {
  "artifact-store": Archive,
  "browser-default": Globe,
  "dev-env": SquareTerminal,
  improver: Sparkles,
  "model-router": Route,
  "monitor-default": Activity,
  "screen-share-default": ScreenShare,
  "deepgram-voice": Mic,
  "web-channel-default": MessagesSquare,
  "slack-channel": MessagesSquare,
  "outpost-tailscale-host": Radio
};

const VIEW_ICON_BY_KIND: Partial<Record<CapabilityKind, LucideIcon>> = {
  "artifact-store": Archive,
  "dev-env": SquareTerminal,
  "screen-share": ScreenShare,
  monitor: Activity,
  voice: Mic,
  channel: MessagesSquare,
  outpost: Radio,
  "memory-store": Brain,
  "data-source": Database,
  runtime: Cpu,
  "automation-runner": Sparkles,
  view: LayoutGrid
};

const VIEW_ICON_BY_FACULTY: Partial<Record<FacultyId, LucideIcon>> = {
  channels: MessagesSquare,
  surfaces: LayoutGrid,
  sessions: SquareTerminal,
  observability: Activity,
  runtimes: Cpu,
  memory: Brain,
  gateway: Network
};

function viewIcon(entry: LibraryEntry, ownPort: boolean): LucideIcon {
  const byId = VIEW_ICON_BY_ID[entry.id];
  if (byId) return byId;
  for (const provision of entry.metadata.provides ?? []) {
    const byKind = VIEW_ICON_BY_KIND[provision.kind];
    if (byKind) return byKind;
  }
  const byFaculty = VIEW_ICON_BY_FACULTY[entry.faculty];
  if (byFaculty) return byFaculty;
  return ownPort ? ExternalLink : Component;
}

function FittingViewsLinks({
  composition,
  library,
  pathname,
  viewStatuses
}: {
  composition: Composition | null;
  library: LibraryEntry[];
  pathname: string;
  viewStatuses: FittingViewStatus[];
}) {
  const isMobile = useIsMobileViewport();

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

  // Own-port views: Fittings whose Faculty is in OWN_PORT_FACULTIES (Monitor
  // pattern). They register at runtime via ~/.garrison/ui-fittings/<id>.json;
  // useFittingViewStatus surfaces health + URL.
  const ownPort = stationed.filter((entry) => isOwnPortFitting(entry));

  const statusByFittingId = new Map<string, FittingViewStatus>(
    viewStatuses.map((s) => [s.fittingId, s])
  );

  type Row =
    | { kind: "embedded"; entry: LibraryEntry }
    | { kind: "own-port"; entry: LibraryEntry; status: FittingViewStatus | null };

  const rows: Row[] = [
    ...embedded.map((entry) => ({ kind: "embedded" as const, entry })),
    ...ownPort.map((entry) => ({
      kind: "own-port" as const,
      entry,
      status: statusByFittingId.get(entry.id) ?? null
    }))
  ].sort((a, b) => a.entry.name.localeCompare(b.entry.name));

  if (rows.length === 0) return null;

  // A fitted view is a normal nav item — same visual language as Garrison /
  // Composition / Vault / Quarters. Unfitted views simply aren't in `rows`,
  // so they never render. Own-port views carry a status hint (live/down/off)
  // and tint their icon by health; embedded views are always reachable.
  return (
    <>
      {rows.map((row) => {
        const Icon = viewIcon(row.entry, row.kind === "own-port");
        if (row.kind === "embedded") {
          const href = `/fitting/${row.entry.id}`;
          const isActive = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link key={`embedded:${row.entry.id}`} href={href} className={clsx("item", isActive && "active")}>
              <span>
                <span className="ic"><Icon aria-hidden /></span>
                {row.entry.name}
              </span>
            </Link>
          );
        }
        const status = row.status;
        const healthy = status?.healthy === true;
        const iconColor = healthy
          ? "var(--sage)"
          : status?.healthy === false
            ? "var(--alarm)"
            : "var(--mute)";
        const icon = (
          <span className="ic" style={{ color: iconColor }}>
            <Icon aria-hidden />
          </span>
        );
        if (healthy && status) {
          if (isMobile) {
            return (
              <a
                key={`own-port:${row.entry.id}`}
                href={status.url}
                target="_blank"
                rel="noopener noreferrer"
                className="item"
                title={`Open ${row.entry.name} in new tab (${status.url})`}
              >
                <span>
                  {icon}
                  {row.entry.name}
                </span>
                <span className="ct">live</span>
              </a>
            );
          }
          const embedHref = `/embed/${row.entry.id}`;
          const isActive = pathname === embedHref;
          return (
            <Link
              key={`own-port:${row.entry.id}`}
              href={embedHref}
              className={clsx("item", isActive && "active")}
              title={`Open ${row.entry.name} embedded (${status.url})`}
            >
              <span>
                {icon}
                {row.entry.name}
              </span>
              <span className="ct">live</span>
            </Link>
          );
        }
        const fallbackHref = `/fitting/${row.entry.id}`;
        const isActive = pathname === fallbackHref || pathname.startsWith(`${fallbackHref}/`);
        return (
          <Link
            key={`own-port:${row.entry.id}`}
            href={fallbackHref}
            className={clsx("item", isActive && "active")}
            title={status?.healthy === false ? "View is unreachable" : "View is not running"}
          >
            <span>
              {icon}
              {row.entry.name}
            </span>
            <span className="ct">{status?.healthy === false ? "down" : "off"}</span>
          </Link>
        );
      })}
    </>
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

function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
