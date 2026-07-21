"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
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
  Drill,
  ExternalLink,
  LayoutGrid,
  Globe,
  SquareTerminal,
  Sparkles,
  Activity,
  ScreenShare,
  Mic,
  MessagesSquare,
  Archive,
  Radio,
  Brain,
  Cpu,
  Network,
  Plug,
  type LucideIcon
} from "lucide-react";
import { useAppShell } from "./AppShell";
import { GarrisonMark } from "./GarrisonMark";
import { faculties, isOwnPortFitting } from "@/lib/faculties";
import { useFittingViewStatus, type FittingViewStatus } from "@/components/fitting-views/useFittingViewStatus";
import { resolveViewUrl } from "@/components/fitting-views/browser-view-url";
import type {
  CapabilityKind,
  Composition,
  FacultyId,
  LibraryEntry
} from "@/lib/types";

export function Sidebar() {
  const pathname = usePathname() ?? "/";
  const {
    composition,
    library,
    runnerState,
    sidebarCollapsed,
    toggleSidebar,
    narrowViewport,
    switching,
    switchError
  } = useAppShell();
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

  const isCompose =
    pathname === "/muster" ||
    pathname.startsWith("/muster/") ||
    pathname === "/compose" ||
    pathname.startsWith("/compose/");

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
      : "-";

  // At narrow widths the expanded sidebar is an overlay drawer above the
  // content column; tapping the scrim, pressing Escape, or following any
  // link closes it. At desktop widths it is the normal sticky grid column.
  const overlay = !sidebarCollapsed && narrowViewport;

  // While the drawer is open: lock the page scroll behind it, move focus
  // into it, and close on Escape.
  const drawerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!overlay) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    drawerRef.current?.querySelector<HTMLElement>("button, a")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") toggleSidebar();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [overlay, toggleSidebar]);

  if (sidebarCollapsed) {
    return (
      <CollapsedRail onExpand={toggleSidebar} switching={switching} switchError={switchError} />
    );
  }

  const expanded = (
    <aside
      ref={drawerRef}
      className={clsx("side", overlay && "side-overlay")}
      role={overlay ? "dialog" : undefined}
      aria-modal={overlay ? true : undefined}
      aria-label={overlay ? "Garrison menu" : "Primary navigation"}
      onClick={
        overlay
          ? (event) => {
              if ((event.target as HTMLElement).closest("a")) toggleSidebar();
            }
          : undefined
      }
      onKeyDown={
        overlay
          ? (event) => {
              // Keep Tab cycling inside the drawer while it is open - the
              // content behind the scrim is visually inert.
              if (event.key !== "Tab") return;
              const root = drawerRef.current;
              if (!root) return;
              const focusables = root.querySelectorAll<HTMLElement>(
                'a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
              );
              if (focusables.length === 0) return;
              const first = focusables[0];
              const last = focusables[focusables.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }
          : undefined
      }
    >
      <div className="side-brand-row">
        <Link className="brand" href="/" aria-label="Agent Garrison home">
          <span className="brand-mark" aria-hidden>
            <GarrisonMark />
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
          className="side-collapse"
          aria-label="Collapse sidebar"
        >
          <ChevronLeft size={14} aria-hidden />
        </button>
      </div>

      <nav className="tabs" aria-label="Garrison">
        <div className="nav-section-label">Command</div>
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
          href="/connectors"
          pathname={pathname}
          icon={<Plug aria-hidden />}
          label="Connectors"
          active={pathname === "/connectors" || pathname.startsWith("/connectors")}
        />
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
        <CompositionSwitcher />
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
          <b>{verifyTotal ? `${verifyOk}/${verifyTotal}` : "-"}</b>
        </div>
        <div className="row">
          <span>views</span>
          <b>{knownViews ? `${liveViews}/${knownViews} live` : "-"}</b>
        </div>
        <div className="row">
          <span>dev · pid</span>
          <b>
            {runnerState?.devMode ? "dev · " : ""}
            {runnerState?.pid ?? "-"}
          </b>
        </div>
      </div>
    </aside>
  );

  if (!overlay) return expanded;
  // The 48px grid column sits empty behind the drawer - rendering the rail
  // there would leave invisible controls in the tab order under the scrim.
  return (
    <>
      <button
        type="button"
        className="side-scrim"
        aria-label="Close menu"
        onClick={toggleSidebar}
      />
      {expanded}
    </>
  );
}

function CollapsedRail({
  onExpand,
  switching,
  switchError
}: {
  onExpand: () => void;
  switching: boolean;
  switchError: string | null;
}) {
  return (
    <aside
      className="side side-rail"
      aria-label="Collapsed primary navigation"
    >
      <button
        type="button"
        onClick={onExpand}
        title="Expand sidebar"
        className="side-rail-toggle"
        aria-label="Expand sidebar"
      >
        <ChevronRight size={16} aria-hidden />
      </button>
      <Link href="/" title="Agent Garrison" className="side-rail-brand">
        <GarrisonMark aria-hidden="true" />
      </Link>
      {switching || switchError ? (
        // The switch state lives in the expanded footer; while collapsed,
        // surface at least a dot so an in-flight switch or a failure is
        // never fully invisible. Expanding shows the detail.
        <span
          role={switchError ? "alert" : "status"}
          title={
            switchError
              ? `Composition switch failed - expand the menu for details`
              : "Switching composition..."
          }
          aria-label={
            switchError
              ? "Composition switch failed - expand the menu for details"
              : "Switching composition"
          }
          className={clsx("side-rail-state", switchError ? "is-error" : "is-switching")}
        />
      ) : null}
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
  "file-browser": Archive,
  "browser-default": Globe,
  "dev-env": SquareTerminal,
  improver: Sparkles,
  drill: Drill,
  "monitor-default": Activity,
  "screen-share-default": ScreenShare,
  "deepgram-voice": Mic,
  "web-channel-default": MessagesSquare,
  "slack-channel": MessagesSquare,
  "outpost-tailscale-host": Radio
};

const VIEW_ICON_BY_KIND: Partial<Record<CapabilityKind, LucideIcon>> = {
  "dev-env": SquareTerminal,
  "screen-share": ScreenShare,
  monitor: Activity,
  voice: Mic,
  channel: MessagesSquare,
  outpost: Radio,
  "memory-store": Brain,
  connector: Plug,
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
  gateway: Network,
  connectors: Plug
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
      <div className="nav-section-label nav-section-views">Fittings Views</div>
      {rows.map((row) => {
        const Icon = viewIcon(row.entry, row.kind === "own-port");
        if (row.kind === "embedded") {
          const href = `/fitting/${row.entry.id}`;
          const isActive = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={`embedded:${row.entry.id}`}
              href={href}
              className={clsx("item", isActive && "active")}
              aria-current={isActive ? "page" : undefined}
            >
              <span>
                <span className="ic"><Icon aria-hidden /></span>
                {row.entry.name}
              </span>
            </Link>
          );
        }
        const status = row.status;
        const healthy = status?.healthy === true;
        const icon = (
          <span
            className={clsx(
              "ic",
              healthy ? "view-live" : status?.healthy === false ? "view-down" : "view-off"
            )}
          >
            <Icon aria-hidden />
          </span>
        );
        if (healthy && status) {
          // Pick the URL reachable from where the browser is: loopback locally,
          // the HTTPS tailnet endpoint over Tailscale, else a host rebind.
          const openUrl = resolveViewUrl(status);
          if (isMobile) {
            return (
              <a
                key={`own-port:${row.entry.id}`}
                href={openUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="item"
                title={`Open ${row.entry.name} in new tab (${openUrl})`}
              >
                <span>
                  {icon}
                  {row.entry.name}
                </span>
                <span className="ct tone-live">live</span>
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
              aria-current={isActive ? "page" : undefined}
              title={`Open ${row.entry.name} embedded (${openUrl})`}
            >
              <span>
                {icon}
                {row.entry.name}
              </span>
              <span className="ct tone-live">live</span>
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
            aria-current={isActive ? "page" : undefined}
            title={status?.healthy === false ? "View is unreachable" : "View is not running"}
          >
            <span>
              {icon}
              {row.entry.name}
            </span>
            <span className={clsx("ct", status?.healthy === false ? "tone-down" : "tone-off")}>{status?.healthy === false ? "down" : "off"}</span>
          </Link>
        );
      })}
    </>
  );
}

// Active-composition switcher (WS4 / D6), stationed at the bottom of the
// sidebar menu. A native <select> of the compositions/ entries (plus the
// active pointer when it's an external path) bound to the persisted pointer.
// Selecting an entry runs a clean down -> up via /api/composition/switch; a
// resolver error is shown inline and the selection is left unchanged (the
// value is controlled by the current active id).
function CompositionSwitcher() {
  const {
    composition,
    compositions,
    activePointer,
    activeExternal,
    switching,
    switchError,
    switchTo,
    dismissSwitchError
  } = useAppShell();

  if (compositions.length === 0 && !activePointer) {
    return (
      <div className="row">
        <span>operative</span>
        <b>{composition?.name ?? "-"}</b>
      </div>
    );
  }

  const activeId = composition?.id ?? null;
  // The select value: the active pointer verbatim when external (so its option
  // matches), else the resolved active id.
  const selectValue = activeExternal && activePointer ? activePointer : activeId ?? "";

  return (
    <div className="composition-switcher">
      <div className="row">
        <label htmlFor="composition-switcher">operative</label>
        {switching ? <span role="status">switching...</span> : null}
      </div>
      <select
        id="composition-switcher"
        className="text composition-switch"
        value={selectValue}
        disabled={switching}
        onChange={(event) => {
          const target = event.target.value;
          if (target && target !== selectValue) switchTo(target);
        }}
      >
        {activeExternal && activePointer ? (
          <option value={activePointer}>{`${activeId ?? activePointer} (external)`}</option>
        ) : null}
        {compositions.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.name}
          </option>
        ))}
      </select>
      {switchError ? (
        <div role="alert" className="composition-switch-error">
          <span>{switchError}</span>
          <button
            type="button"
            onClick={dismissSwitchError}
            title="Dismiss error"
            aria-label="Dismiss composition switch error"
          >
            ×
          </button>
        </div>
      ) : null}
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
    <Link
      href={href}
      className={clsx("item", isActive && "active")}
      aria-current={isActive ? "page" : undefined}
    >
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
