"use client";

// The Muster page container (GARRISON-UNIFY-V1 D12, slice S5a): the one
// shell-owned surface where the whole system is configured. Owns data fetch, the
// @dnd-kit context (drag a target onto a cell) + a tap-to-arm/tap-to-place
// fallback for touch, and optimistic autosave (no Save button - a discrete edit
// persists immediately and reconciles with the server's authoritative model).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors
} from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { AddDuty, DutyList, MusterHeader, TargetsTray } from "./MusterView";
import { StandingFittings } from "./StandingFittings";
import type { DutyEffort, MusterActions, MusterModel } from "./types";
import styles from "./Muster.module.css";

type Status = "loading" | "ready" | "error";

// ── optimistic patch helpers (pure) ─────────────────────────────────────────
function patchCell(
  model: MusterModel,
  dutyId: string,
  level: number,
  patch: { target?: string; effort?: DutyEffort }
): MusterModel {
  const duty = model.duties[dutyId];
  if (!duty || !duty.levels[level - 1]?.cell) return model;
  const levels = duty.levels.map((lv, i) =>
    i === level - 1 ? { ...lv, cell: { ...lv.cell, ...patch } } : lv
  );
  return { ...model, duties: { ...model.duties, [dutyId]: { ...duty, levels } } };
}

function patchSelected(model: MusterModel, dutyId: string, action: "add" | "remove"): MusterModel {
  const has = model.selectedDuties.includes(dutyId);
  const selectedDuties =
    action === "add"
      ? has
        ? model.selectedDuties
        : [...model.selectedDuties, dutyId]
      : model.selectedDuties.filter((d) => d !== dutyId);
  return { ...model, selectedDuties };
}

export function MusterPage() {
  const [model, setModel] = useState<MusterModel | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<string | null>(null);

  // The composition currently viewed (from ?composition=, else the active
  // pointer). Held in a ref so mutation POSTs always target the same one.
  const compositionRef = useRef<string | undefined>(undefined);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } })
  );

  const load = useCallback(async (composition?: string) => {
    setStatus((s) => (s === "ready" ? s : "loading"));
    try {
      const url = composition
        ? `/api/muster?composition=${encodeURIComponent(composition)}`
        : "/api/muster";
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setModel(data as MusterModel);
      setStatus("ready");
      setErrorMsg(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get("composition")?.trim() || undefined;
    compositionRef.current = param;
    void load(param);
  }, [load]);

  // POST a mutation, reconcile with the server model, revert (reload) on failure.
  const persist = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      setSaving(true);
      try {
        const res = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ composition: compositionRef.current, ...body })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setModel(data as MusterModel);
        setErrorMsg(null);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
        await load(compositionRef.current); // discard the optimistic edit
      } finally {
        setSaving(false);
      }
    },
    [load]
  );

  const assignCell = useCallback(
    (dutyId: string, level: number, targetId: string) => {
      setModel((m) => (m ? patchCell(m, dutyId, level, { target: targetId }) : m));
      void persist("/api/muster/cell", { dutyId, level, target: targetId });
    },
    [persist]
  );

  const setEffort = useCallback(
    (dutyId: string, level: number, effort: DutyEffort) => {
      setModel((m) => (m ? patchCell(m, dutyId, level, { effort }) : m));
      void persist("/api/muster/cell", { dutyId, level, effort });
    },
    [persist]
  );

  const addDuty = useCallback(
    (dutyId: string) => {
      setModel((m) => (m ? patchSelected(m, dutyId, "add") : m));
      void persist("/api/muster/duty", { dutyId, action: "add" });
    },
    [persist]
  );

  const removeDuty = useCallback(
    (dutyId: string) => {
      setModel((m) => (m ? patchSelected(m, dutyId, "remove") : m));
      void persist("/api/muster/duty", { dutyId, action: "remove" });
    },
    [persist]
  );

  const switchComposition = useCallback(async (id: string) => {
    try {
      await fetch("/api/composition/active", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: id })
      });
    } finally {
      // Reload onto the now-active composition so the whole shell reflects it.
      window.location.assign("/muster");
    }
  }, []);

  const onArm = useCallback((id: string) => setArmed((cur) => (cur === id ? null : id)), []);

  const onDragStart = useCallback((e: DragStartEvent) => {
    const id = String(e.active.id);
    if (id.startsWith("target:")) setDragTarget(id.slice("target:".length));
  }, []);

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      setDragTarget(null);
      const activeId = String(e.active.id);
      const overId = e.over ? String(e.over.id) : null;
      if (!overId || !activeId.startsWith("target:")) return;
      const targetId = activeId.slice("target:".length);
      const parts = overId.split(":");
      if (parts[0] === "cell") {
        const dutyId = parts[1];
        const level = Number(parts[2]);
        if (dutyId && Number.isFinite(level)) assignCell(dutyId, level, targetId);
      }
    },
    [assignCell]
  );

  // ── render ────────────────────────────────────────────────────────────────
  if (status === "loading" && !model) {
    return (
      <main>
        <div className={styles.wrap} data-testid="muster-loading">
          <div className={styles.skelLine} style={{ width: "40%", height: 34 }} />
          <div className={styles.skelLine} style={{ width: "24%" }} />
          <div style={{ marginTop: 28 }}>
            <div className={styles.skelRow} />
            <div className={styles.skelRow} />
            <div className={styles.skelRow} />
          </div>
        </div>
      </main>
    );
  }

  if (status === "error" && !model) {
    return (
      <main>
        <div className={styles.wrap}>
          <div className={styles.stateBox} data-testid="muster-error">
            <div className={styles.stateTitle}>Could not load Muster</div>
            <p className={styles.stateBody}>{errorMsg}</p>
            <button
              type="button"
              className={styles.addBtn}
              style={{ marginTop: 16 }}
              onClick={() => load(compositionRef.current)}
            >
              Retry
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (!model) return null;

  const actions: MusterActions = {
    armed,
    saving,
    onArm,
    assignCell,
    setEffort,
    addDuty,
    removeDuty,
    switchComposition
  };

  return (
    <main>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        // Re-measure droppables on every drag: a cell below the fold (the page
        // scrolls mid-drag) must still register as a drop target.
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      >
        <div className={styles.wrap} data-testid="muster-page">
          <MusterHeader model={model} actions={actions} />

          {errorMsg ? (
            <div className={styles.blocking} role="alert" style={{ marginTop: 4 }}>
              <span className={styles.blockGlyph}>!</span>
              <div>
                <h5>Last change did not save</h5>
                <p>{errorMsg}</p>
              </div>
            </div>
          ) : null}

          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <span className={styles.sectionLabel}>
                Duties <span className={styles.sectionCount}>· {model.selectedDuties.length} selected</span>
              </span>
              <span style={{ display: "inline-flex", gap: 12, alignItems: "center" }}>
                {saving ? <span className={styles.saving}>saving…</span> : null}
                <AddDuty model={model} actions={actions} />
              </span>
            </div>
            <TargetsTray model={model} actions={actions} />
            <DutyList model={model} actions={actions} />
          </section>

          <StandingFittings compositionId={model.compositionId} />
        </div>

        <DragOverlay>
          {dragTarget ? <div className={styles.dragGhost}>{dragTarget}</div> : null}
        </DragOverlay>
      </DndContext>
    </main>
  );
}
