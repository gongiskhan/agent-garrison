"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { useAppShell } from "@/components/chrome/AppShell";
import {
  DEFAULT_INSTANCE_ID,
  deriveViewDescriptors,
  formatInstanceRef,
  parseInstanceRef,
  type ViewDescriptor,
  type ViewInstanceRef
} from "@/lib/view-instances";
import { isOwnPortFitting } from "@/lib/faculties";
import type { LibraryEntry } from "@/lib/types";
import { lookupFittingView, type FittingViewProps } from "../registry";
import { usePersistedViewState } from "../usePersistedViewState";
import { useFittingViewStatus } from "../useFittingViewStatus";

// The Workspaces Fitting's single view: a tiling pane container that
// REFERENCES other views by (fitting, view, instance) — it never owns or
// forks instances. Panes mount the exact same registry components / own-port
// URLs the views use standalone. The entire persisted state is the layout
// (geometry in % of the workspace area), held through usePersistedViewState:
// every move/resize/add/close is a setState and the debounced auto-PUT does
// the rest. No save button exists, by design.

export interface WorkspacePane {
  ref: string; // formatInstanceRef form: fitting:view[#instance]
  x: number; // percent of workspace width
  y: number; // percent of workspace height
  w: number; // percent of workspace width
  h: number; // percent of workspace height
}

export interface WorkspaceLayout {
  panes: WorkspacePane[];
}

const HEADER_H = 24; // px — pane chrome budget is <= 28, target 24
const MIN_PANE_PCT = 10;

interface DragState {
  index: number;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  rootW: number;
  rootH: number;
  orig: WorkspacePane;
}

export default function WorkspaceView({ params }: FittingViewProps) {
  const instanceId = params.instance ?? DEFAULT_INSTANCE_ID;
  const [layout, setLayout, { loaded }] = usePersistedViewState<WorkspaceLayout>(
    "workspaces",
    { panes: [] },
    instanceId
  );
  const { composition, library } = useAppShell();
  const { entries: viewStatuses } = useFittingViewStatus();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);

  const stationed = useMemo(() => {
    if (!composition) return [] as LibraryEntry[];
    const ids = new Set(
      Object.values(composition.selections)
        .flat()
        .map((sel) => sel?.id)
        .filter(Boolean) as string[]
    );
    return library.filter((entry) => ids.has(entry.id));
  }, [composition, library]);

  const statusByFitting = useMemo(
    () => new Map(viewStatuses.map((s) => [s.fittingId, s])),
    [viewStatuses]
  );

  const beginDrag = useCallback(
    (event: React.PointerEvent, index: number, mode: DragState["mode"]) => {
      const root = rootRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      const pane = layout.panes[index];
      if (!pane) return;
      event.preventDefault();
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
      dragRef.current = {
        index,
        mode,
        startX: event.clientX,
        startY: event.clientY,
        rootW: rect.width,
        rootH: rect.height,
        orig: { ...pane }
      };
      setDragging(true);
    },
    [layout.panes]
  );

  const onDragMove = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = ((event.clientX - drag.startX) / drag.rootW) * 100;
      const dy = ((event.clientY - drag.startY) / drag.rootH) * 100;
      setLayout((prev) => {
        const panes = prev.panes.slice();
        const pane = panes[drag.index];
        if (!pane) return prev;
        if (drag.mode === "move") {
          panes[drag.index] = {
            ...pane,
            x: clampPct(drag.orig.x + dx, 0, 100 - pane.w),
            y: clampPct(drag.orig.y + dy, 0, 100 - pane.h)
          };
        } else {
          const w = clampPct(drag.orig.w + dx, MIN_PANE_PCT, 100 - pane.x);
          const h = clampPct(drag.orig.h + dy, MIN_PANE_PCT, 100 - pane.y);
          panes[drag.index] = { ...pane, w, h };
        }
        return { panes };
      });
    },
    [setLayout]
  );

  const endDrag = useCallback((event: React.PointerEvent) => {
    if (!dragRef.current) return;
    try {
      (event.currentTarget as Element).releasePointerCapture(event.pointerId);
    } catch {
      // capture may already be gone; nothing to release
    }
    dragRef.current = null;
    setDragging(false);
  }, []);

  const closePane = useCallback(
    (index: number) => {
      setLayout((prev) => ({ panes: prev.panes.filter((_, i) => i !== index) }));
    },
    [setLayout]
  );

  const addPane = useCallback(
    (ref: string) => {
      setLayout((prev) => {
        const n = prev.panes.length;
        // First two panes tile side by side (the common case); later panes
        // cascade with an offset so none lands exactly on another. Existing
        // panes are never moved — their geometry belongs to the user.
        const slot =
          n === 0
            ? { x: 0, y: 0, w: 49.5, h: 96 }
            : n === 1
              ? { x: 50.5, y: 0, w: 49.5, h: 96 }
              : { x: (n * 6) % 36, y: (n * 6) % 36, w: 46, h: 58 };
        return { panes: [...prev.panes, { ref, ...slot }] };
      });
    },
    [setLayout]
  );

  return (
    <div>
      <style>{`
        .ws-pane-header .ws-pane-controls { opacity: 0; transition: opacity 120ms; }
        .ws-pane-header:hover .ws-pane-controls,
        .ws-pane-header:focus-within .ws-pane-controls { opacity: 1; }
      `}</style>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
          minHeight: 24
        }}
      >
        <span className="font-mono" style={{ fontSize: 11, color: "var(--mute)" }}>
          {layout.panes.length} pane{layout.panes.length === 1 ? "" : "s"}
        </span>
        <AddPaneMenu stationed={stationed} onAdd={addPane} />
      </div>
      <div
        ref={rootRef}
        data-testid="workspace-root"
        style={{
          position: "relative",
          // Full-bleed surface (chrome: full-bleed suppresses the overview
          // header): the workspace claims the viewport minus its own thin
          // toolbar and the page padding.
          height: "max(420px, calc(100vh - 88px))",
          border: "1px solid var(--rule)",
          background: "var(--paper-2)",
          overflow: "hidden"
        }}
      >
        {!loaded ? (
          <div style={{ padding: 14, fontSize: 13, color: "var(--mute)" }}>
            Loading workspace…
          </div>
        ) : layout.panes.length === 0 ? (
          <div style={{ padding: 14, fontSize: 13, color: "var(--mute)" }}>
            Empty workspace. Use “Add pane” to tile a view from a stationed
            Fitting.
          </div>
        ) : (
          layout.panes.map((pane, index) => (
            <Pane
              key={`${pane.ref}:${index}`}
              pane={pane}
              index={index}
              dragging={dragging}
              stationed={stationed}
              statusByFitting={statusByFitting}
              composition={composition}
              beginDrag={beginDrag}
              onDragMove={onDragMove}
              endDrag={endDrag}
              onClose={closePane}
            />
          ))
        )}
      </div>
    </div>
  );
}

function Pane({
  pane,
  index,
  dragging,
  stationed,
  statusByFitting,
  composition,
  beginDrag,
  onDragMove,
  endDrag,
  onClose
}: {
  pane: WorkspacePane;
  index: number;
  dragging: boolean;
  stationed: LibraryEntry[];
  statusByFitting: Map<string, ReturnType<typeof useFittingViewStatus>["entries"][number]>;
  composition: ReturnType<typeof useAppShell>["composition"];
  beginDrag: (event: React.PointerEvent, index: number, mode: "move" | "resize") => void;
  onDragMove: (event: React.PointerEvent) => void;
  endDrag: (event: React.PointerEvent) => void;
  onClose: (index: number) => void;
}) {
  const parsed = parseInstanceRef(pane.ref);
  const label = parsed ? formatInstanceRef(parsed) : pane.ref;

  return (
    <section
      data-testid="workspace-pane"
      data-ref={pane.ref}
      style={{
        position: "absolute",
        left: `${pane.x}%`,
        top: `${pane.y}%`,
        width: `${pane.w}%`,
        height: `${pane.h}%`,
        border: "1px solid var(--rule-2)",
        background: "white",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden"
      }}
    >
      <header
        data-testid="pane-header"
        className="ws-pane-header"
        onPointerDown={(e) => beginDrag(e, index, "move")}
        onPointerMove={onDragMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{
          flex: `0 0 ${HEADER_H}px`,
          height: HEADER_H,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 6px",
          borderBottom: "1px solid var(--rule)",
          background: "var(--paper-2)",
          cursor: "grab",
          userSelect: "none",
          touchAction: "none"
        }}
      >
        <span
          className="font-mono"
          style={{
            fontSize: 10.5,
            color: "var(--ink-mute)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis"
          }}
        >
          {label}
        </span>
        <span className="ws-pane-controls" style={{ marginLeft: "auto", display: "flex" }}>
          <button
            type="button"
            aria-label={`Close pane ${label}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onClose(index)}
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: "var(--mute)",
              display: "flex",
              alignItems: "center",
              padding: 2
            }}
          >
            <X size={12} aria-hidden />
          </button>
        </span>
      </header>
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: 10,
          pointerEvents: dragging ? "none" : "auto"
        }}
      >
        <PaneContent
          parsed={parsed}
          raw={pane.ref}
          stationed={stationed}
          statusByFitting={statusByFitting}
          composition={composition}
        />
      </div>
      <span
        data-testid="pane-resize-handle"
        onPointerDown={(e) => beginDrag(e, index, "resize")}
        onPointerMove={onDragMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          width: 14,
          height: 14,
          cursor: "nwse-resize",
          borderRight: "3px solid var(--rule-2)",
          borderBottom: "3px solid var(--rule-2)",
          touchAction: "none"
        }}
      />
    </section>
  );
}

function PaneContent({
  parsed,
  raw,
  stationed,
  statusByFitting,
  composition
}: {
  parsed: ViewInstanceRef | null;
  raw: string;
  stationed: LibraryEntry[];
  statusByFitting: Map<string, ReturnType<typeof useFittingViewStatus>["entries"][number]>;
  composition: ReturnType<typeof useAppShell>["composition"];
}) {
  if (!parsed) {
    return <PaneNotice title="Unreadable view reference" body={raw} />;
  }
  if (parsed.fittingId === "workspaces") {
    // Composing the composer would recurse forever; refuse honestly.
    return <PaneNotice title="A workspace cannot embed itself" />;
  }

  const Component = lookupFittingView(parsed.fittingId, parsed.viewId);
  if (Component) {
    const selection = composition
      ? Object.values(composition.selections)
          .flat()
          .find((sel) => sel?.id === parsed.fittingId)
      : undefined;
    return (
      <Component
        config={selection?.config ?? {}}
        params={{ instance: parsed.instanceId }}
      />
    );
  }

  const entry = stationed.find((candidate) => candidate.id === parsed.fittingId);
  if (entry && isOwnPortFitting(entry)) {
    const status = statusByFitting.get(parsed.fittingId);
    if (status?.healthy && status.url) {
      return (
        <iframe
          src={status.url}
          title={formatInstanceRef(parsed)}
          style={{
            width: "100%",
            height: "100%",
            border: 0,
            display: "block",
            background: "var(--paper)"
          }}
        />
      );
    }
    return (
      <PaneNotice
        title={`${entry.name} is not running`}
        body="Start the operative to launch this view."
      />
    );
  }

  return (
    <PaneNotice
      title="View unavailable"
      body={`No host loader or running surface for ${formatInstanceRef(parsed)}.`}
    />
  );
}

function PaneNotice({ title, body }: { title: string; body?: string }) {
  return (
    <div style={{ fontSize: 12.5, color: "var(--mute)" }}>
      <div style={{ fontWeight: 600, color: "var(--ink-mute)" }}>{title}</div>
      {body ? <div style={{ marginTop: 4 }}>{body}</div> : null}
    </div>
  );
}

function AddPaneMenu({
  stationed,
  onAdd
}: {
  stationed: LibraryEntry[];
  onAdd: (ref: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [instances, setInstances] = useState<Record<string, string[]> | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Views available to reference = every view a stationed Fitting produces
  // (the same derivation the capability resolver uses), except workspaces
  // itself.
  const descriptors = useMemo(() => {
    const all: Array<{ entry: LibraryEntry; descriptor: ViewDescriptor }> = [];
    for (const entry of stationed) {
      if (entry.id === "workspaces") continue;
      for (const descriptor of deriveViewDescriptors(entry.id, entry.metadata)) {
        all.push({ entry, descriptor });
      }
    }
    return all;
  }, [stationed]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const fittingIds = Array.from(new Set(descriptors.map((d) => d.entry.id)));
    void Promise.all(
      fittingIds.map(async (id) => {
        try {
          const res = await fetch(`/api/view-state?fitting=${encodeURIComponent(id)}`, {
            cache: "no-store"
          });
          if (!res.ok) return [id, []] as const;
          const body = (await res.json()) as { instances?: string[] };
          return [id, body.instances ?? []] as const;
        } catch {
          return [id, []] as const;
        }
      })
    ).then((pairs) => {
      if (!cancelled) setInstances(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [open, descriptors]);

  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(event: PointerEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        data-testid="workspace-add-pane"
        onClick={() => setOpen((prev) => !prev)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          padding: "3px 9px",
          border: "1px solid var(--rule)",
          background: "white",
          color: "var(--ink)",
          fontSize: 12,
          cursor: "pointer"
        }}
      >
        <Plus size={12} aria-hidden />
        Add pane
      </button>
      {open ? (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 4px)",
            zIndex: 20,
            minWidth: 260,
            maxHeight: 320,
            overflowY: "auto",
            border: "1px solid var(--rule)",
            background: "white",
            boxShadow: "0 6px 18px rgba(24, 33, 28, 0.12)"
          }}
        >
          {descriptors.length === 0 ? (
            <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--mute)" }}>
              No stationed Fitting produces a view.
            </div>
          ) : (
            descriptors.flatMap(({ entry, descriptor }) => {
              const known = instances?.[entry.id] ?? [];
              const ids = known.length > 0 ? known : [DEFAULT_INSTANCE_ID];
              return ids.map((instanceId) => {
                const ref = formatInstanceRef({
                  fittingId: descriptor.fittingId,
                  viewId: descriptor.viewId,
                  instanceId
                });
                return (
                  <button
                    key={ref}
                    type="button"
                    data-testid={`workspace-add-option-${ref}`}
                    onClick={() => {
                      onAdd(ref);
                      setOpen(false);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 8,
                      width: "100%",
                      textAlign: "left",
                      padding: "6px 10px",
                      border: "none",
                      borderBottom: "1px solid var(--rule)",
                      background: "white",
                      cursor: "pointer",
                      fontSize: 12,
                      color: "var(--ink)"
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{entry.name}</span>
                    <span className="font-mono" style={{ fontSize: 10.5, color: "var(--mute)" }}>
                      {ref}
                      {descriptor.surface === "own-port" ? " · own-port" : ""}
                    </span>
                  </button>
                );
              });
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

function clampPct(value: number, min: number, max: number): number {
  const clamped = Math.min(Math.max(value, min), Math.max(min, max));
  return Math.round(clamped * 10) / 10;
}
