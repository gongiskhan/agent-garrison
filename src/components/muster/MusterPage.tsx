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
import clsx from "clsx";
import { dutyEfforts } from "@/lib/types";
import { AddDuty, DutyList, MusterHeader, ReadinessDetail, TargetsTray } from "./MusterView";
import { StandingFittings } from "./StandingFittings";
import { OrchestratorPanel } from "./OrchestratorPanel";
import { DecisionsPanel } from "./DecisionsPanel";
import type { DutyEffort, MusterActions, MusterModel, MusterTargetUpdate } from "./types";
import styles from "./Muster.module.css";

type Status = "loading" | "ready" | "error";

// The four working areas of the composition. Only the active one mounts, so the
// page is a focused single panel instead of one 13k-px scroll of everything at
// once - and the heavy panels (orchestrator prompt, fittings, decisions feed)
// only fetch when their tab is opened.
type SectionId = "duties" | "fittings" | "orchestrator" | "decisions";
const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "duties", label: "Duties" },
  { id: "fittings", label: "Fittings" },
  { id: "orchestrator", label: "Orchestrator" },
  { id: "decisions", label: "Decisions" }
];

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

// Mirror of the server's addDutyLevel default (clone the last level; a leaf cell
// bumps its effort one notch) so the optimistic append matches what persists.
function patchAddLevel(model: MusterModel, dutyId: string): MusterModel {
  const duty = model.duties[dutyId];
  if (!duty || duty.levels.length === 0) return model;
  const last = duty.levels[duty.levels.length - 1];
  const n = duty.levels.length + 1;
  const description = `level ${n}: deeper than level ${n - 1} - describe when the Dispatcher should pick this level`;
  const bumped = dutyEfforts[Math.min(dutyEfforts.indexOf(last.cell?.effort ?? "medium") + 1, dutyEfforts.length - 1)];
  const next = last.cell
    ? { description, cell: { ...last.cell, effort: bumped } }
    : { description, sequence: (last.sequence ?? []).map((s) => ({ ...s })) };
  return { ...model, duties: { ...model.duties, [dutyId]: { ...duty, levels: [...duty.levels, next] } } };
}

function patchRemoveLevel(model: MusterModel, dutyId: string, level: number): MusterModel {
  const duty = model.duties[dutyId];
  if (!duty || duty.levels.length <= 1 || !duty.levels[level - 1]) return model;
  const levels = duty.levels.filter((_, i) => i !== level - 1);
  return { ...model, duties: { ...model.duties, [dutyId]: { ...duty, levels } } };
}

function patchDescribeLevel(model: MusterModel, dutyId: string, level: number, description: string): MusterModel {
  const duty = model.duties[dutyId];
  if (!duty || !duty.levels[level - 1]) return model;
  const levels = duty.levels.map((lv, i) => (i === level - 1 ? { ...lv, description } : lv));
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
  const [section, setSection] = useState<SectionId>("duties");

  // The composition currently viewed (from ?composition=, else the active
  // pointer). Held in a ref so mutation POSTs always target the same one.
  const compositionRef = useRef<string | undefined>(undefined);
  // Every editor on this page writes the same composition manifest. Keep those
  // read-modify-write requests in user-action order: atomic rename protects a
  // reader from a partial file, but two overlapping autosaves could still both
  // read the old document and let the later rename discard the earlier edit.
  const mutationChainRef = useRef<Promise<void>>(Promise.resolve());
  const pendingMutationCountRef = useRef(0);
  // React Strict Mode can issue overlapping initial loads. A late load must
  // never repaint over an optimistic edit that began after that request.
  const modelEpochRef = useRef(0);
  const loadRequestRef = useRef(0);
  const beginModelMutation = useCallback(() => {
    modelEpochRef.current += 1;
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } })
  );

  const load = useCallback(async (composition?: string) => {
    const requestId = ++loadRequestRef.current;
    const startEpoch = modelEpochRef.current;
    const isCurrent = () =>
      requestId === loadRequestRef.current && startEpoch === modelEpochRef.current;
    setStatus((s) => (s === "ready" ? s : "loading"));
    try {
      const url = composition
        ? `/api/muster?composition=${encodeURIComponent(composition)}`
        : "/api/muster";
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!isCurrent()) return;
      setModel(data as MusterModel);
      setStatus("ready");
      setErrorMsg(null);
    } catch (err) {
      if (!isCurrent()) return;
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
  // The promise chain is shared by discrete edits and debounced text edits so an
  // add -> describe -> remove sequence cannot overtake itself.
  const persist = useCallback(
    (path: string, body: Record<string, unknown>) => {
      pendingMutationCountRef.current += 1;
      setSaving(true);
      const queued = mutationChainRef.current.then(async (): Promise<boolean> => {
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
          return true;
        } catch (err) {
          setErrorMsg(err instanceof Error ? err.message : String(err));
          await load(compositionRef.current); // discard the optimistic edit
          return false;
        }
      });
      mutationChainRef.current = queued.then(() => undefined);
      void queued.finally(() => {
        pendingMutationCountRef.current -= 1;
        if (pendingMutationCountRef.current === 0) setSaving(false);
      });
      return queued;
    },
    [load]
  );

  const assignCell = useCallback(
    (dutyId: string, level: number, targetId: string) => {
      beginModelMutation();
      setModel((m) => (m ? patchCell(m, dutyId, level, { target: targetId }) : m));
      void persist("/api/muster/cell", { dutyId, level, target: targetId });
    },
    [beginModelMutation, persist]
  );

  const setEffort = useCallback(
    (dutyId: string, level: number, effort: DutyEffort) => {
      beginModelMutation();
      setModel((m) => (m ? patchCell(m, dutyId, level, { effort }) : m));
      void persist("/api/muster/cell", { dutyId, level, effort });
    },
    [beginModelMutation, persist]
  );

  const addDuty = useCallback(
    (dutyId: string) => {
      beginModelMutation();
      setModel((m) => (m ? patchSelected(m, dutyId, "add") : m));
      void persist("/api/muster/duty", { dutyId, action: "add" });
    },
    [beginModelMutation, persist]
  );

  const removeDuty = useCallback(
    (dutyId: string) => {
      beginModelMutation();
      setModel((m) => (m ? patchSelected(m, dutyId, "remove") : m));
      void persist("/api/muster/duty", { dutyId, action: "remove" });
    },
    [beginModelMutation, persist]
  );

  const addLevel = useCallback(
    (dutyId: string) => {
      beginModelMutation();
      setModel((m) => (m ? patchAddLevel(m, dutyId) : m));
      void persist("/api/muster/level", { dutyId, action: "add" });
    },
    [beginModelMutation, persist]
  );

  const removeLevel = useCallback(
    (dutyId: string, level: number) => {
      beginModelMutation();
      setModel((m) => (m ? patchRemoveLevel(m, dutyId, level) : m));
      void persist("/api/muster/level", { dutyId, action: "remove", level });
    },
    [beginModelMutation, persist]
  );

  // Level descriptions are free text: patch optimistically per keystroke, persist
  // debounced per (duty, level) so the manifest write settles once typing stops.
  const describeTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const describeLevel = useCallback(
    (dutyId: string, level: number, description: string) => {
      beginModelMutation();
      setModel((m) => (m ? patchDescribeLevel(m, dutyId, level, description) : m));
      const key = `${dutyId}:${level}`;
      const existing = describeTimers.current.get(key);
      if (existing) clearTimeout(existing);
      describeTimers.current.set(
        key,
        setTimeout(() => {
          describeTimers.current.delete(key);
          void persist("/api/muster/level", { dutyId, action: "describe", level, description });
        }, 600)
      );
    },
    [beginModelMutation, persist]
  );

  useEffect(() => {
    const timers = describeTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
    };
  }, []);

  const saveTarget = useCallback(
    (target: MusterTargetUpdate): Promise<boolean> => {
      beginModelMutation();
      return persist("/api/muster/target", { ...target });
    },
    [beginModelMutation, persist]
  );

  const switchComposition = useCallback(async (id: string) => {
    beginModelMutation();
    setSaving(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/composition/switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: id })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok !== true) {
        throw new Error(typeof data?.error === "string" ? data.error : `HTTP ${res.status}`);
      }
      // Reload only after clean down → pointer update → up succeeded, so the
      // shell can never point at one composition while another stays running.
      window.location.assign("/muster");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [beginModelMutation]);

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
        <div className={styles.console} data-testid="muster-loading">
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
        <div className={styles.console}>
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
    addLevel,
    removeLevel,
    describeLevel,
    saveTarget,
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
        <div className={styles.console} data-testid="muster-page">
          <MusterHeader model={model} actions={actions} />
          <ReadinessDetail model={model} />

          {errorMsg ? (
            <div className={styles.blocking} role="alert" style={{ marginTop: 4 }}>
              <span className={styles.blockGlyph}>!</span>
              <div>
                <h5>Last change did not save</h5>
                <p>{errorMsg}</p>
              </div>
            </div>
          ) : null}

          <nav className={styles.sectionNav} role="tablist" aria-label="Muster sections">
            {SECTIONS.map((s) => {
              const count = s.id === "duties" ? model.selectedDuties.length : undefined;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={section === s.id}
                  className={clsx(styles.navItem, section === s.id && styles.navActive)}
                  onClick={() => setSection(s.id)}
                  data-testid={`section-nav-${s.id}`}
                >
                  <span className={styles.navLabel}>{s.label}</span>
                  {count != null ? <span className={styles.navCount}>{count}</span> : null}
                </button>
              );
            })}
          </nav>

          <div className={styles.stage}>
            {section === "duties" ? (
              <div className={styles.dutiesPanel} data-testid="duties-panel">
                <div className={styles.dutiesMain}>
                  <div className={styles.stageHead}>
                    <span className={styles.stageLead}>
                      The work this composition routes. The Dispatcher picks a duty, then a level -
                      each level&apos;s description is its routing criterion.
                    </span>
                    <span className={styles.stageTools}>
                      {saving ? <span className={styles.saving}>saving…</span> : null}
                      <AddDuty model={model} actions={actions} />
                    </span>
                  </div>
                  <DutyList model={model} actions={actions} />
                </div>
                <aside className={styles.traySide}>
                  <div className={styles.trayHeading}>Targets</div>
                  <TargetsTray model={model} actions={actions} />
                </aside>
              </div>
            ) : null}

            {section === "fittings" ? <StandingFittings compositionId={model.compositionId} /> : null}
            {section === "orchestrator" ? <OrchestratorPanel compositionId={model.compositionId} /> : null}
            {section === "decisions" ? <DecisionsPanel compositionId={model.compositionId} /> : null}
          </div>
        </div>

        <DragOverlay>
          {dragTarget ? <div className={styles.dragGhost}>{dragTarget}</div> : null}
        </DragOverlay>
      </DndContext>
    </main>
  );
}
