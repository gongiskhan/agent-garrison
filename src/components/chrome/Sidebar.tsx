"use client";

import { Fragment, useEffect, useRef, useState } from "react";
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
  Milestone,
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
  Boxes,
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
import { NodeBadge, useBuildSha, useNodeChrome } from "./NodeBadge";
import { faculties, isOwnPortFitting } from "@/lib/faculties";
import { useFittingViewStatus, type FittingViewStatus } from "@/components/fitting-views/useFittingViewStatus";
import { resolveViewUrl } from "@/components/fitting-views/browser-view-url";
import type { CapabilityKind, Composition, FacultyId, LibraryEntry } from "@/lib/types";

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
  // Which machine in the mesh this window is. Null until the mount effect has
  // read <html data-node-*>, so the subtitle degrades to "v1" for one frame
  // rather than flashing a wrong node name.
  const node = useNodeChrome();
  const buildSha = useBuildSha();

  const stationedCount = countStationed(composition);
  const totalFaculties = faculties.length;
  const verifyResults = runnerState?.verifyResults ?? [];
  const verifyTotal = verifyResults.length;
  const verifyOk = verifyResults.filter((r) => r.ok).length;
  const status = runnerState?.status ?? "idle";
  const isRunning = status === "running";
  const liveViews = viewStatuses.filter((s) => s.healthy === true).length;
  const knownViews = viewStatuses.length;

  // Live-ticking uptime while the composition is up. Recomputed each second so
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
            <span className="sub">{node ? `v1 · ${node.name}` : "v1"}</span>
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

      <NodeBadge />

      <nav className="tabs" aria-label="Garrison">
        <SidebarMenu
          composition={composition}
          library={library}
          pathname={pathname}
          viewStatuses={viewStatuses}
          commandBadges={{ "nav:composition": `${stationedCount}/${totalFaculties}` }}
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
        <div className="row">
          <span>build</span>
          <b>{buildSha ?? "-"}</b>
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
  roadmaps: Milestone
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

// ── the menu ──────────────────────────────────────────────────────────────
//
// Three groups, one shape. Pinned sits on top and is always open; Command (the
// fixed Garrison routes) and Fittings (every equipped fitting) are collapsible
// and alphabetical. The category sub-groups the Fittings list used to carry are
// gone: with one flat alphabetical list the row you want is where its name says
// it is, and the menu is scanned, not navigated.
//
// Pins are dragged in (drop on the group to append, on a pinned row to insert
// before it) and dragged out anywhere to unpin. They live in the state service
// (`sidebar.pins`), so the menu looks the same on EVERY node in the mesh — pin
// something on the Air and it is pinned on dev-madrid. A pinned row renders in
// BOTH the Pinned group and its own group (with a pin marker there).

/**
 * Should navigating to a menu item auto-expand its group?
 *
 * Yes by default: navigation context should never be hidden. NOT when the active
 * row is ALREADY REACHABLE without expanding anything - a pinned row is on
 * screen in the Pinned group, and the dashboard is the brand link at the top of
 * the sidebar - because expanding then reveals nothing and just reorganises the
 * menu under a user who only wanted to open a page. That case is the common one:
 * the dashboard is where the shell lands, and a group that springs open there
 * every time is not a collapsed group at all. And never before the pin list has
 * loaded, because an empty list means "not known yet", and firing on it would
 * expand the very group a pin was meant to skip.
 */
export function shouldAutoExpandGroup(args: {
  activeGroupId: string | null;
  pinsLoaded: boolean;
  activeIsReachable: boolean;
}): boolean {
  return !!args.activeGroupId && args.pinsLoaded && !args.activeIsReachable;
}

// Group expansion is per-device UI state; the PINS are the durable, now
// mesh-wide preference. v2: the group ids changed from six categories to
// `command` / `fittings`, so a stale v1 set would expand nothing.
const EXPANDED_GROUPS_KEY = "garrison.sidebar.menuGroups.v2";

// The fixed Garrison routes, as DATA rather than inline JSX: the Pinned group
// renders the same row shapes the Command group does, so a nav item has to be
// describable. The `nav:` id prefix keeps one flat pin list able to hold both a
// route and a fitting id without either shadowing the other (the store's
// PIN_ID_PATTERN accepts exactly these two shapes).
export interface CommandItem {
  id: string;
  href: string;
  label: string;
  Icon: LucideIcon;
  isActive: (pathname: string) => boolean;
}

// The dashboard, named once: the brand link renders it too, which is why the
// auto-expand below treats it as already reachable.
export const HOME_ITEM_ID = "nav:garrison";

export const COMMAND_ITEMS: CommandItem[] = [
  {
    id: "nav:accounts",
    href: "/accounts",
    label: "Accounts",
    Icon: KeyRound,
    isActive: (p) => p === "/accounts" || p.startsWith("/accounts/")
  },
  {
    id: "nav:composition",
    href: "/compose",
    label: "Composition",
    Icon: Layers,
    isActive: (p) =>
      p === "/muster" || p.startsWith("/muster/") || p === "/compose" || p.startsWith("/compose/")
  },
  {
    id: "nav:connectors",
    href: "/connectors",
    label: "Connectors",
    Icon: Plug,
    isActive: (p) => p === "/connectors" || p.startsWith("/connectors")
  },
  {
    id: "nav:conversations",
    href: "/talk",
    label: "Conversations",
    Icon: MessagesSquare,
    isActive: (p) => p === "/talk" || p.startsWith("/talk/")
  },
  {
    id: "nav:coordination",
    href: "/coordination",
    label: "Coordination",
    Icon: Network,
    isActive: (p) => p === "/coordination" || p.startsWith("/coordination")
  },
  { id: HOME_ITEM_ID, href: "/", label: "Garrison", Icon: Home, isActive: (p) => p === "/" },
  {
    id: "nav:mesh",
    href: "/mesh",
    label: "Mesh",
    Icon: Boxes,
    isActive: (p) => p === "/mesh" || p.startsWith("/mesh/")
  },
  {
    id: "nav:quarters",
    href: "/quarters",
    label: "Quarters",
    Icon: LayoutGrid,
    isActive: (p) => p === "/quarters" || p.startsWith("/quarters/")
  },
  { id: "nav:vault", href: "/vault", label: "Vault", Icon: Lock, isActive: (p) => p === "/vault" }
];

type MenuRow =
  | { kind: "command"; id: string; label: string; item: CommandItem }
  | { kind: "embedded"; id: string; label: string; entry: LibraryEntry }
  | {
      kind: "own-port";
      id: string;
      label: string;
      entry: LibraryEntry;
      status: FittingViewStatus | null;
    };

function SidebarMenu({
  composition,
  library,
  pathname,
  viewStatuses,
  commandBadges
}: {
  composition: Composition | null;
  library: LibraryEntry[];
  pathname: string;
  viewStatuses: FittingViewStatus[];
  commandBadges: Record<string, string>;
}) {
  const isMobile = useIsMobileViewport();
  const [pinned, setPinned] = useState<string[]>([]);
  // Pins arrive from the server, so an empty list means "not known yet", not
  // "nothing pinned". The auto-expand below has to tell those apart or it fires
  // once on the pre-load state and expands a group it should have skipped.
  const [pinsLoaded, setPinsLoaded] = useState(false);
  // A refused write is worth saying out loud: the list is mesh-shared, so with
  // the state service down the pin does not happen ANYWHERE, and a silent
  // roll-back would read as a broken drag.
  const [pinError, setPinError] = useState<string | null>(null);
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
          setPinsLoaded(true);
        })
        .catch(() => {
          // pins render as-is until the next successful load
        });
    };
    load();
    // Slow re-sync so a pin made on ANOTHER NODE (or another tab) shows up here
    // without a reload — that convergence is the point of the shared list.
    // Skipped mid-drag so a refresh can never clobber an in-flight gesture.
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      load();
    }, 20000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // Auto-expand the group holding the active route, as a TRANSIENT default (not
  // written to localStorage): navigation context is never hidden, and the user
  // can still collapse the group — the toggle acts on real membership, so it is
  // never inert.
  const activeMatch = /^\/(?:fitting|embed)\/([^/]+)/.exec(pathname);
  const activeFittingId = activeMatch ? activeMatch[1] : null;
  const activeCommand = activeFittingId
    ? null
    : (COMMAND_ITEMS.find((item) => item.isActive(pathname)) ?? null);
  const activeId = activeFittingId ?? activeCommand?.id ?? null;
  const activeGroupId = activeFittingId ? "fittings" : activeCommand ? "command" : null;
  // The dashboard row counts as reachable: the brand link above the menu is the
  // same destination, so expanding Command on "/" costs the user their
  // collapsed menu and buys nothing.
  const activeIsReachable =
    !!activeId && (activeId === HOME_ITEM_ID || pinned.includes(activeId));
  useEffect(() => {
    if (!shouldAutoExpandGroup({ activeGroupId, pinsLoaded, activeIsReachable })) return;
    setExpanded((prev) => {
      if (prev.has(activeGroupId!)) return prev;
      const next = new Set(prev);
      next.add(activeGroupId!);
      return next;
    });
  }, [activeGroupId, activeIsReachable, pinsLoaded]);

  const rowById = new Map<string, MenuRow>();

  // Command: alphabetical by label, sorted HERE rather than trusted to the
  // declaration order, so a route added to the list lands in the right place.
  const commandRows: MenuRow[] = [...COMMAND_ITEMS]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((item) => ({ kind: "command", id: item.id, label: item.label, item }));
  for (const row of commandRows) rowById.set(row.id, row);

  // Fittings: ONLY equipped fittings — one row per fitting; own-port wins the
  // row shape when both apply, since it carries the health signal. The
  // composition object itself is poll-refreshed by AppShell, so fit/unfit lands
  // here within seconds without a reload.
  const fittingRows: MenuRow[] = [];
  if (composition) {
    const selectedIds = new Set<string>();
    for (const selections of Object.values(composition.selections)) {
      for (const selection of selections ?? []) {
        selectedIds.add(selection.id);
      }
    }
    const statusByFittingId = new Map<string, FittingViewStatus>(
      viewStatuses.map((s) => [s.fittingId, s])
    );
    const seen = new Set<string>();
    for (const entry of library) {
      if (!selectedIds.has(entry.id) || seen.has(entry.id)) continue;
      seen.add(entry.id);
      fittingRows.push(
        isOwnPortFitting(entry)
          ? {
              kind: "own-port",
              id: entry.id,
              label: entry.name,
              entry,
              status: statusByFittingId.get(entry.id) ?? null
            }
          : { kind: "embedded", id: entry.id, label: entry.name, entry }
      );
    }
    fittingRows.sort((a, b) => a.label.localeCompare(b.label));
    for (const row of fittingRows) rowById.set(row.id, row);
  }

  const groups: Array<{ id: string; name: string; rows: MenuRow[] }> = [
    { id: "command", name: "Command", rows: commandRows }
  ];
  if (fittingRows.length > 0) groups.push({ id: "fittings", name: "Fittings", rows: fittingRows });

  // Pins render in stored order; a pinned id that is not on the menu right now
  // simply does not render (the pin survives — refit the fitting and it
  // reappears).
  const pinnedRows = pinned
    .map((id) => rowById.get(id))
    .filter((row): row is MenuRow => Boolean(row));

  const savePins = (next: string[]) => {
    setPinned(next);
    const rollback = () => {
      void fetch("/api/sidebar-pins")
        .then((res) => res.json())
        .then((data: { pins?: { pinned?: unknown } }) => {
          const list = data.pins?.pinned;
          if (Array.isArray(list) && !draggingRef.current) {
            setPinned(list.filter((x): x is string => typeof x === "string"));
          }
        })
        .catch(() => {});
    };
    void fetch("/api/sidebar-pins", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: next })
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as {
          pins?: { pinned?: unknown };
          error?: string;
        };
        if (!res.ok) throw new Error(data.error || `PUT /api/sidebar-pins ${res.status}`);
        setPinError(null);
        // Reconcile from the server's canonical list so this tab converges with
        // writes made elsewhere instead of drifting from a mount-time baseline.
        const list = data.pins?.pinned;
        if (Array.isArray(list) && !draggingRef.current) {
          setPinned(list.filter((x): x is string => typeof x === "string"));
        }
      })
      .catch((error: unknown) => {
        setPinError(error instanceof Error ? error.message : "could not save pins");
        // Roll back to server truth so the UI never keeps a pin the server
        // refused (or lost); best-effort.
        rollback();
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
    const id = row.id;
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
    const pinMark =
      origin === "group" && isPinned ? (
        <span className="pin-mark" title="Pinned">
          <Pin aria-hidden />
        </span>
      ) : null;
    // Drag is desktop-only, but pins are a shared preference — on narrow
    // viewports each row gets a tap toggle instead.
    const mobilePinToggle = isMobile ? (
      <button
        type="button"
        className="pin-toggle"
        aria-label={isPinned ? `Unpin ${row.label}` : `Pin ${row.label}`}
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

    if (row.kind === "command") {
      const CommandIcon = row.item.Icon;
      const isActive = row.item.isActive(pathname);
      const badge = commandBadges[id];
      return (
        <Link
          href={row.item.href}
          className={clsx("item", isActive && "active", isDragSource && "drag-source")}
          aria-current={isActive ? "page" : undefined}
          {...dragProps}
        >
          <span>
            <span className="ic">
              <CommandIcon aria-hidden />
            </span>
            {row.label}
            {pinMark}
          </span>
          {badge ? <span className="ct">{badge}</span> : null}
          {mobilePinToggle}
        </Link>
      );
    }

    const Icon = viewIcon(row.entry, row.kind === "own-port");
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
            {row.label}
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
            title={`Open ${row.label} in new tab (${openUrl})`}
            {...dragProps}
          >
            <span>
              {icon}
              {row.label}
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
          title={`Open ${row.label} embedded (${openUrl})`}
          {...dragProps}
        >
          <span>
            {icon}
            {row.label}
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
          {row.label}
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
          // Re-dropping an already-pinned row from its group is a no-op (it is
          // already there); anything else appends.
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
            {dragging
              ? "Drop to pin"
              : isMobile
                ? "Tap the pin on any row to pin it"
                : "Drag a menu item here to pin it"}
          </div>
        ) : (
          pinnedRows.map((row) => (
            <Fragment key={`pin:${row.id}`}>{renderRow(row, "pinned")}</Fragment>
          ))
        )}
        {pinError ? (
          <div className="pin-error" role="alert">
            {pinError}
          </div>
        ) : null}
      </div>

      {groups.map((group) => {
        const open = expanded.has(group.id);
        const ownPortRows = group.rows.filter(
          (row): row is Extract<MenuRow, { kind: "own-port" }> => row.kind === "own-port"
        );
        const anyDown = ownPortRows.some((row) => row.status?.healthy === false);
        const anyLive = ownPortRows.some((row) => row.status?.healthy === true);
        return (
          <div className="nav-group" key={group.id}>
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
                  <Fragment key={`grp:${row.id}`}>{renderRow(row, "group")}</Fragment>
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
        <span>composition</span>
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
        <label htmlFor="composition-switcher">composition</label>
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
            {/* Several compositions ship the same display name, so the name
                alone cannot identify what this switches the running session
                to. Matches MusterView. */}
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
