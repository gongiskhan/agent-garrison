"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import {
  ChevronLeft,
  ChevronRight,
  Home,
  Layers,
  Lock,
  KeyRound,
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
  Pin,
  PinOff,
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
          href="/accounts"
          pathname={pathname}
          icon={<KeyRound aria-hidden />}
          label="Accounts"
          active={pathname === "/accounts" || pathname.startsWith("/accounts/")}
        />
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
          <span>fittings</span>
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

// Per-Fitting icons for the sidebar Fittings list. Resolution is layered so a
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

// The Fittings menu: every equipped fitting, grouped by faculty area with the
// groups collapsed by default (expansion is per-device UI state), plus an
// always-visible Pinned group on top. Pins are dragged in (drop on the group
// to append, on a pinned row to insert before it) and dragged out anywhere to
// unpin; they persist server-side in ~/.garrison/sidebar-pins.json so every
// browser sees the same list. A pinned fitting renders in BOTH the Pinned
// group and its own faculty group (with a pin marker there).
const EXPANDED_GROUPS_KEY = "garrison.sidebar.fittingGroups.v1";

type MenuRow =
  | { kind: "embedded"; entry: LibraryEntry }
  | { kind: "own-port"; entry: LibraryEntry; status: FittingViewStatus | null };

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
  const [pinned, setPinned] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState<{ id: string; origin: "pinned" | "group" } | null>(
    null
  );
  const [pinHover, setPinHover] = useState(false);
  // Set by the Pinned group's drop handlers before dragend fires; a pinned-row
  // drag that ends anywhere else is the unpin gesture — EXCEPT an
  // Escape-cancelled drag, which must abort, not unpin (dragend cannot tell
  // the two apart from dropEffect alone, so the cancel is flagged here).
  const droppedOnPinned = useRef(false);
  const dragCancelled = useRef(false);
  const draggingRef = useRef<{ id: string; origin: "pinned" | "group" } | null>(null);
  draggingRef.current = dragging;

  useEffect(() => {
    if (!dragging) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dragCancelled.current = true;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dragging]);

  // Group expansion is per-device UI state (localStorage); the PINS are the
  // durable cross-device preference and live server-side.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(EXPANDED_GROUPS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        setExpanded(new Set(parsed.filter((x): x is string => typeof x === "string")));
      }
    } catch {
      // default: all collapsed
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/sidebar-pins")
        .then((res) => res.json())
        .then((data: { pins?: { pinned?: unknown } }) => {
          if (cancelled || draggingRef.current) return;
          const list = data.pins?.pinned;
          if (Array.isArray(list)) {
            setPinned(list.filter((x): x is string => typeof x === "string"));
          }
        })
        .catch(() => {
          // pins render as-is until the next successful load
        });
    };
    load();
    // Slow re-sync so a pin made in another tab/browser shows up here without
    // a reload (pins are a cross-device preference). Skipped mid-drag so a
    // refresh can never clobber an in-flight gesture.
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      load();
    }, 20000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // Auto-expand the group holding the fitting whose route is active, as a
  // TRANSIENT default (not written to localStorage): navigation context is
  // never hidden, and the user can still collapse the group — the toggle acts
  // on real membership, so it is never inert.
  const activeMatch = /^\/(?:fitting|embed)\/([^/]+)/.exec(pathname);
  const activeFittingId = activeMatch ? activeMatch[1] : null;
  const activeEntry = activeFittingId
    ? library.find((entry) => entry.id === activeFittingId)
    : undefined;
  const activeGroupId = activeEntry
    ? faculties.some((f) => f.id === activeEntry.faculty)
      ? activeEntry.faculty
      : "other"
    : null;
  useEffect(() => {
    if (!activeGroupId) return;
    setExpanded((prev) => {
      if (prev.has(activeGroupId)) return prev;
      const next = new Set(prev);
      next.add(activeGroupId);
      return next;
    });
  }, [activeGroupId]);

  if (!composition) return null;

  const selectedIds = new Set<string>();
  for (const selections of Object.values(composition.selections)) {
    for (const selection of selections ?? []) {
      selectedIds.add(selection.id);
    }
  }
  const statusByFittingId = new Map<string, FittingViewStatus>(
    viewStatuses.map((s) => [s.fittingId, s])
  );
  // ONLY equipped fittings — one row per fitting; own-port wins the row shape
  // when both apply, since it carries the health signal. The composition
  // object itself is poll-refreshed by AppShell, so fit/unfit lands here
  // within seconds without a reload.
  const rowById = new Map<string, MenuRow>();
  for (const entry of library) {
    if (!selectedIds.has(entry.id) || rowById.has(entry.id)) continue;
    rowById.set(
      entry.id,
      isOwnPortFitting(entry)
        ? { kind: "own-port", entry, status: statusByFittingId.get(entry.id) ?? null }
        : { kind: "embedded", entry }
    );
  }
  if (rowById.size === 0) return null;

  const groups: Array<{ id: string; name: string; rows: MenuRow[] }> = [];
  const grouped = new Set<string>();
  for (const faculty of faculties) {
    const rows = [...rowById.values()]
      .filter((row) => row.entry.faculty === faculty.id)
      .sort((a, b) => a.entry.name.localeCompare(b.entry.name));
    if (rows.length === 0) continue;
    for (const row of rows) grouped.add(row.entry.id);
    groups.push({ id: faculty.id, name: faculty.name, rows });
  }
  const leftover = [...rowById.values()]
    .filter((row) => !grouped.has(row.entry.id))
    .sort((a, b) => a.entry.name.localeCompare(b.entry.name));
  if (leftover.length > 0) {
    groups.push({ id: "other", name: "Other", rows: leftover });
  }

  // Pins render in stored order; a pinned id not equipped right now simply
  // does not render (the pin survives — refit the fitting and it reappears).
  const pinnedRows = pinned
    .map((id) => rowById.get(id))
    .filter((row): row is MenuRow => Boolean(row));

  const savePins = (next: string[]) => {
    setPinned(next);
    void fetch("/api/sidebar-pins", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: next })
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`PUT /api/sidebar-pins ${res.status}`);
        // Reconcile from the server's canonical list so this tab converges
        // with writes made elsewhere instead of drifting from a mount-time
        // baseline.
        const data = (await res.json()) as { pins?: { pinned?: unknown } };
        const list = data.pins?.pinned;
        if (Array.isArray(list) && !draggingRef.current) {
          setPinned(list.filter((x): x is string => typeof x === "string"));
        }
      })
      .catch(() => {
        // Roll back to server truth so the UI never keeps a pin the server
        // refused (or lost); best-effort.
        void fetch("/api/sidebar-pins")
          .then((res) => res.json())
          .then((data: { pins?: { pinned?: unknown } }) => {
            const list = data.pins?.pinned;
            if (Array.isArray(list) && !draggingRef.current) {
              setPinned(list.filter((x): x is string => typeof x === "string"));
            }
          })
          .catch(() => {});
      });
  };
  const pinBefore = (id: string, beforeId: string | null) => {
    const without = pinned.filter((p) => p !== id);
    const idx = beforeId === null ? without.length : without.indexOf(beforeId);
    const at = idx < 0 ? without.length : idx;
    savePins([...without.slice(0, at), id, ...without.slice(at)]);
  };
  const unpin = (id: string) => savePins(pinned.filter((p) => p !== id));

  const toggleGroup = (groupId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      try {
        window.localStorage.setItem(EXPANDED_GROUPS_KEY, JSON.stringify([...next]));
      } catch {
        // per-device nicety only
      }
      return next;
    });
  };

  const renderRow = (row: MenuRow, origin: "pinned" | "group") => {
    const id = row.entry.id;
    const isPinned = pinned.includes(id);
    const isDragSource = dragging?.id === id && dragging.origin === origin;
    const dragProps = {
      draggable: !isMobile,
      onDragStart: (event: React.DragEvent) => {
        event.dataTransfer.setData("text/plain", id);
        event.dataTransfer.effectAllowed = "copyMove";
        droppedOnPinned.current = false;
        dragCancelled.current = false;
        setDragging({ id, origin });
      },
      onDragEnd: () => {
        // Dropping a pinned row anywhere outside the Pinned group unpins it —
        // but an Escape-cancelled drag aborts without touching the pin.
        if (origin === "pinned" && !droppedOnPinned.current && !dragCancelled.current) {
          unpin(id);
        }
        setDragging(null);
        setPinHover(false);
      },
      ...(origin === "pinned"
        ? {
            // Pinned rows are drop targets too: insert before this row. A
            // drop back ON ITSELF is the change-your-mind gesture — a no-op
            // that must swallow the event, or it bubbles to the pin-zone
            // container and silently appends the row to the END of the list.
            onDragOver: (event: React.DragEvent) => {
              if (!dragging) return;
              event.preventDefault();
              event.stopPropagation();
            },
            onDrop: (event: React.DragEvent) => {
              if (!dragging) return;
              event.preventDefault();
              event.stopPropagation();
              droppedOnPinned.current = true;
              if (dragging.id !== id) pinBefore(dragging.id, id);
              setPinHover(false);
            }
          }
        : {})
    };
    const Icon = viewIcon(row.entry, row.kind === "own-port");
    const pinMark =
      origin === "group" && isPinned ? (
        <span className="pin-mark" title="Pinned">
          <Pin aria-hidden />
        </span>
      ) : null;
    // Drag is desktop-only, but pins are a cross-device preference — on
    // narrow viewports each row gets a tap toggle instead.
    const mobilePinToggle = isMobile ? (
      <button
        type="button"
        className="pin-toggle"
        aria-label={isPinned ? `Unpin ${row.entry.name}` : `Pin ${row.entry.name}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (isPinned) {
            unpin(id);
          } else {
            pinBefore(id, null);
          }
        }}
      >
        {isPinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
      </button>
    ) : null;

    if (row.kind === "embedded") {
      const href = `/fitting/${id}`;
      const isActive = pathname === href || pathname.startsWith(`${href}/`);
      return (
        <Link
          href={href}
          className={clsx("item", isActive && "active", isDragSource && "drag-source")}
          aria-current={isActive ? "page" : undefined}
          {...dragProps}
        >
          <span>
            <span className="ic">
              <Icon aria-hidden />
            </span>
            {row.entry.name}
            {pinMark}
          </span>
          {mobilePinToggle}
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
            href={openUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={clsx("item", isDragSource && "drag-source")}
            title={`Open ${row.entry.name} in new tab (${openUrl})`}
            {...dragProps}
          >
            <span>
              {icon}
              {row.entry.name}
              {pinMark}
            </span>
            <span className="ct tone-live">live</span>
            {mobilePinToggle}
          </a>
        );
      }
      const embedHref = `/embed/${id}`;
      const isActive = pathname === embedHref;
      return (
        <Link
          href={embedHref}
          className={clsx("item", isActive && "active", isDragSource && "drag-source")}
          aria-current={isActive ? "page" : undefined}
          title={`Open ${row.entry.name} embedded (${openUrl})`}
          {...dragProps}
        >
          <span>
            {icon}
            {row.entry.name}
            {pinMark}
          </span>
          <span className="ct tone-live">live</span>
          {mobilePinToggle}
        </Link>
      );
    }
    const fallbackHref = `/fitting/${id}`;
    const isActive = pathname === fallbackHref || pathname.startsWith(`${fallbackHref}/`);
    return (
      <Link
        href={fallbackHref}
        className={clsx("item", isActive && "active", isDragSource && "drag-source")}
        aria-current={isActive ? "page" : undefined}
        title={status?.healthy === false ? "View is unreachable" : "View is not running"}
        {...dragProps}
      >
        <span>
          {icon}
          {row.entry.name}
          {pinMark}
        </span>
        <span className={clsx("ct", status?.healthy === false ? "tone-down" : "tone-off")}>
          {status?.healthy === false ? "down" : "off"}
        </span>
        {mobilePinToggle}
      </Link>
    );
  };

  return (
    <>
      <div className="nav-section-label nav-section-views">Fittings</div>

      <div
        className={clsx("pin-zone", dragging && "drag-active", dragging && pinHover && "drag-hover")}
        onDragOver={(event) => {
          if (!dragging) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setPinHover(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node)) return;
          setPinHover(false);
        }}
        onDrop={(event) => {
          if (!dragging) return;
          event.preventDefault();
          droppedOnPinned.current = true;
          // Re-dropping an already-pinned fitting from its faculty group is a
          // no-op (it is already there); anything else appends.
          if (dragging.origin === "pinned" || !pinned.includes(dragging.id)) {
            pinBefore(dragging.id, null);
          }
          setPinHover(false);
        }}
      >
        <div className="nav-group-head pin-head">
          <span className="chev pin-ic">
            <Pin aria-hidden />
          </span>
          Pinned
          {pinnedRows.length > 0 ? <span className="gct">{pinnedRows.length}</span> : null}
        </div>
        {pinnedRows.length === 0 ? (
          <div className="pin-hint">
            {dragging ? "Drop to pin" : "Drag a fitting here to pin it"}
          </div>
        ) : (
          pinnedRows.map((row) => (
            <Fragment key={`pin:${row.entry.id}`}>{renderRow(row, "pinned")}</Fragment>
          ))
        )}
      </div>

      {groups.map((group) => {
        const open = expanded.has(group.id);
        const ownPortRows = group.rows.filter(
          (row): row is Extract<MenuRow, { kind: "own-port" }> => row.kind === "own-port"
        );
        const anyDown = ownPortRows.some((row) => row.status?.healthy === false);
        const anyLive = ownPortRows.some((row) => row.status?.healthy === true);
        return (
          <div key={group.id}>
            <button
              type="button"
              className="nav-group-head"
              onClick={() => toggleGroup(group.id)}
              aria-expanded={open}
            >
              <span className={clsx("chev", open && "open")}>
                <ChevronRight aria-hidden />
              </span>
              {group.name}
              <span className="gct">
                {anyDown ? (
                  <span className="nav-group-dot down" aria-label="a fitting is unreachable" />
                ) : anyLive ? (
                  <span className="nav-group-dot live" aria-label="fittings live" />
                ) : null}
                {group.rows.length}
              </span>
            </button>
            {open
              ? group.rows.map((row) => (
                  <Fragment key={`grp:${row.entry.id}`}>{renderRow(row, "group")}</Fragment>
                ))
              : null}
          </div>
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
            {/* Several compositions ship the same display name (three are
                "Dogfood Operative"), so the name alone cannot identify what
                this switches the running operative to. Matches MusterView. */}
            {`${entry.name} (${entry.id})`}
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
