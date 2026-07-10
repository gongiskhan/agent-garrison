// Orchestrator Composer (GARRISON-UNIFY-V1 S3, brief D10/D11/D12).
//
// One page, four surfaces, Garrison's slots-and-pieces metaphor - NOT
// forms-and-dropdowns:
//   1. TARGETS TRAY   - every config target is a draggable card with an effort dial.
//   2. MATRIX BOARD   - 18 task-types × 3 tiers; drop a target to assign; resolved
//                       tokens read solid (explicit) or faded (inherited).
//   3. WORK-KIND RAILS - one rail per work kind, phases as toggleable/reorderable chips.
//   4. TRY-IT STRIP   - paste a request, DRY-RUN classify + resolve the whole rail.
//
// PERSISTENCE (D12): a DRAFT config + baselineSha from GET /routing; every committed
// edit debounces an 800ms whole-document PUT /routing?baseline=<sha> (200 → store new
// sha; 409 → conflict banner + Reload; 422 → show errors + REVERT the last edit).
// Autosave - no Save button. Mobile-first: matrix scrolls in its own container, rails
// wrap, the inspector is a bottom sheet on narrow viewports, TouchSensor drives drag.
// NO emoji anywhere - text marks + inline SVG only.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors
} from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
// Pure core, bundled into the browser (no node imports). railFor is typed for v2;
// resolveRoute's public type is the v1 shape, so we cast it to a v2-friendly local.
import { railFor as railForCore, resolveRoute as resolveRouteCore } from "../lib/routing-core.mjs";
import type { PolicyConfigV2, PhasePlan, Rail, RailPhase, RouteResolution } from "../lib/routing-core.mjs";

// A target seen at runtime is looser than the strict union (a secondary can carry a
// model/effort; a workflow has no runtime) - read through this shape.
type AnyTarget = {
  id: string;
  type?: string;
  runtime?: string;
  provider?: string;
  model?: string;
  effort?: string;
  workflow?: string;
  pinned?: boolean;
};
type PhaseEntry = string | { id: string; on?: boolean };

// The composer only ever operates on a fully-seeded v2 config, so narrow the
// machinery fields the seed guarantees to non-optional — this keeps every edit
// path free of strict-null noise without scattering `!` through the components.
type Cfg = Omit<PolicyConfigV2, "targets" | "taskTypes" | "tiers" | "workKinds" | "phasePlans" | "phaseSkills"> & {
  targets: AnyTarget[];
  taskTypes: string[];
  tiers: string[];
  workKinds: Record<string, { phasePlan: string; description?: string }>;
  phasePlans: Record<string, PhasePlan>;
  phaseSkills: { bindings: Record<string, string>; overrides: Record<string, Record<string, string>> };
};
type Producer = (draft: Cfg) => Cfg;

const resolveRoute = resolveRouteCore as unknown as (
  config: Cfg,
  profile: string | null,
  classification: { taskType: string; tier: string; matchedException?: string | null }
) => RouteResolution;
const railFor = railForCore as unknown as (config: Cfg, workKind?: string | null, toggles?: Record<string, boolean> | null) => Rail;

const EFFORTS = ["low", "medium", "high", "xhigh"];
const EVIDENCE_KINDS = ["video", "logs", "text", "none"];
const RUNTIME_OPTIONS = ["claude-code", "ollama", "agent-sdk", "codex", "gemini"];

// ── glyphs (styled text marks - no emoji) ─────────────────────────────────────
function glyphFor(t: AnyTarget | null | undefined): { mark: string; cls: string; title: string } {
  if (!t) return { mark: "??", cls: "g-other", title: "unset" };
  if (t.provider === "ollama-local") return { mark: "OL", cls: "g-ollama", title: "Ollama (local)" };
  if (t.type === "workflow") return { mark: "WF", cls: "g-workflow", title: "Workflow" };
  switch (t.runtime) {
    case "claude-code":
      return { mark: "CC", cls: "g-claude", title: "Claude Code" };
    case "agent-sdk":
      return { mark: "SDK", cls: "g-sdk", title: "Agent SDK" };
    case "codex":
      return { mark: "CX", cls: "g-codex", title: "Codex" };
    case "gemini":
      return { mark: "GM", cls: "g-gemini", title: "Gemini" };
    default:
      return { mark: (t.runtime || "?").slice(0, 2).toUpperCase(), cls: "g-other", title: t.runtime || "target" };
  }
}

function targetById(config: Cfg, id: string | null | undefined): AnyTarget | null {
  if (!id) return null;
  return ((config.targets || []) as AnyTarget[]).find((t) => t.id === id) || null;
}

// Small inline icons (no emoji).
function IconGrip() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="ic">
      <circle cx="3" cy="2" r="1.1" /><circle cx="9" cy="2" r="1.1" />
      <circle cx="3" cy="6" r="1.1" /><circle cx="9" cy="6" r="1.1" />
      <circle cx="3" cy="10" r="1.1" /><circle cx="9" cy="10" r="1.1" />
    </svg>
  );
}
function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className="ic">
      <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </svg>
  );
}
// Phase-toggle state icons (no emoji): check = on, ring = off-in-plan, plus = add.
function IconCheck() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" className="ic">
      <path d="M2.5 7l3 3 5-6.5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconRing() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" className="ic">
      <circle cx="6.5" cy="6.5" r="4.2" stroke="currentColor" strokeWidth="1.5" fill="none" />
    </svg>
  );
}
function IconPlus() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" className="ic">
      <path d="M6.5 2.5v8M2.5 6.5h8" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" />
    </svg>
  );
}

// ── token: a resolved target rendered compactly (glyph + model + effort) ──────
function Token({ config, targetId, faded, rule }: { config: Cfg; targetId: string | null; faded?: boolean; rule?: string }) {
  const t = targetById(config, targetId);
  if (!targetId) return <span className="token empty" title="no target">·</span>;
  const g = glyphFor(t);
  const model = t ? t.model || t.runtime || t.id : `${targetId} (missing)`;
  return (
    <span className={`token${faded ? " faded" : ""}`} title={`${targetId}${rule ? ` · ${rule}` : ""}`}>
      <span className={`glyph ${g.cls}`}>{g.mark}</span>
      <span className="tk-model">{model}</span>
      {t?.effort ? <span className="tk-effort">{t.effort}</span> : null}
    </span>
  );
}

// ── persistence hook (D12) ────────────────────────────────────────────────────
type SaveState = "idle" | "saving" | "saved" | "conflict" | "invalid";
function usePolicyDraft() {
  const [config, setConfig] = useState<Cfg | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [errors, setErrors] = useState<string[]>([]);
  const baselineRef = useRef("");
  const lastGoodRef = useRef<Cfg | null>(null); // last server-confirmed draft (revert target)
  const draftRef = useRef<Cfg | null>(null); // current draft - source of truth for saves
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const pendingRef = useRef(false);

  const load = useCallback(async () => {
    const r = await fetch("/routing");
    const j = await r.json();
    baselineRef.current = j.baselineSha;
    lastGoodRef.current = j.config;
    draftRef.current = j.config;
    setConfig(j.config);
    setErrors([]);
    setSaveState("idle");
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const doPut = useCallback(async () => {
    const sent = draftRef.current;
    if (!sent) return;
    savingRef.current = true;
    setSaveState("saving");
    let r: Response;
    try {
      r = await fetch(`/routing?baseline=${encodeURIComponent(baselineRef.current)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: sent })
      });
    } catch {
      savingRef.current = false;
      setSaveState("idle"); // transient network error - keep the draft, no revert
      return;
    }
    if (r.status === 409) {
      savingRef.current = false;
      setSaveState("conflict");
      return;
    }
    if (r.status === 422) {
      const j = await r.json().catch(() => ({}));
      savingRef.current = false;
      // REVERT the last edit to the last known-good config, then surface why.
      draftRef.current = lastGoodRef.current;
      setConfig(lastGoodRef.current);
      setErrors(Array.isArray(j.errors) ? j.errors : [j.message || "config rejected"]);
      setSaveState("invalid");
      return;
    }
    const j = await r.json();
    baselineRef.current = j.baselineSha;
    lastGoodRef.current = sent;
    savingRef.current = false;
    setErrors([]);
    setSaveState("saved");
    if (pendingRef.current) {
      pendingRef.current = false;
      doPut();
    }
  }, []);

  const commit = useCallback(
    (producer: Producer) => {
      const base = draftRef.current;
      if (!base) return;
      const next = producer(structuredClone(base));
      draftRef.current = next;
      setConfig(next);
      setSaveState("saving");
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        if (savingRef.current) {
          pendingRef.current = true;
          return;
        }
        doPut();
      }, 800);
    },
    [doPut]
  );

  return { config, saveState, errors, commit, reload: load, dismissErrors: () => setSaveState("idle") };
}

// ── 1. TARGETS TRAY ───────────────────────────────────────────────────────────
function EffortDial({ target, commit }: { target: AnyTarget; commit: (p: Producer) => void }) {
  const applicable = target.type === "runtime-target" || target.effort !== undefined;
  if (!applicable) return <span className="dial-na">{target.type || "secondary"}</span>;
  const set = (e: string) =>
    commit((draft) => {
      const t = (draft.targets as AnyTarget[]).find((x) => x.id === target.id);
      if (t) t.effort = e;
      return draft;
    });
  return (
    <div className="dial" role="group" aria-label="effort">
      {EFFORTS.map((e) => (
        <button
          key={e}
          type="button"
          className={`seg${target.effort === e ? " on" : ""}`}
          onPointerDown={(ev) => ev.stopPropagation()}
          onClick={() => set(e)}
        >
          {e}
        </button>
      ))}
    </div>
  );
}

function TargetCard({ target, commit }: { target: AnyTarget; commit: (p: Producer) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `target:${target.id}` });
  const g = glyphFor(target);
  return (
    <div ref={setNodeRef} className={`tcard${isDragging ? " dragging" : ""}`}>
      <div className="tcard-grab" {...attributes} {...listeners}>
        <span className={`glyph ${g.cls}`} title={g.title}>
          {g.mark}
        </span>
        <span className="tcard-main">
          <span className="tcard-model">{target.model || target.runtime || target.id}</span>
          <span className="tcard-id">{target.id}{target.pinned ? " · pinned" : ""}</span>
        </span>
      </div>
      <EffortDial target={target} commit={commit} />
    </div>
  );
}

function AddTargetCard({ config, commit }: { config: Cfg; commit: (p: Producer) => void }) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [runtime, setRuntime] = useState(RUNTIME_OPTIONS[0]);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("medium");
  const existing = new Set((config.targets || []).map((t) => t.id));
  const invalid = !id.trim() || existing.has(id.trim());
  const add = () => {
    const tid = id.trim();
    if (!tid || existing.has(tid)) return;
    const built: AnyTarget = { id: tid };
    if (runtime === "codex" || runtime === "gemini") {
      built.type = "secondary";
      built.runtime = runtime;
      if (model.trim()) built.model = model.trim();
      if (effort) built.effort = effort;
    } else {
      built.type = "runtime-target";
      built.runtime = runtime === "ollama" ? "claude-code" : runtime;
      built.provider = runtime === "ollama" ? "ollama-local" : "anthropic-plan";
      built.model = model.trim() || "sonnet";
      built.effort = effort;
    }
    commit((draft) => {
      (draft.targets as AnyTarget[]).push(built);
      return draft;
    });
    setId("");
    setModel("");
    setOpen(false);
  };
  if (!open)
    return (
      <button type="button" className="tcard add" onClick={() => setOpen(true)}>
        <span className="add-plus">+</span> Add target
      </button>
    );
  return (
    <div className="tcard add-form">
      <input placeholder="id (e.g. cc-opus-high)" value={id} onChange={(e) => setId(e.target.value)} />
      <select value={runtime} onChange={(e) => setRuntime(e.target.value)}>
        {RUNTIME_OPTIONS.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <input placeholder="model" value={model} onChange={(e) => setModel(e.target.value)} />
      <select value={effort} onChange={(e) => setEffort(e.target.value)}>
        {EFFORTS.map((e) => (
          <option key={e} value={e}>
            {e}
          </option>
        ))}
      </select>
      <div className="add-actions">
        <button type="button" className="primary" disabled={invalid} onClick={add}>
          Add
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function TargetsTray({ config, commit }: { config: Cfg; commit: (p: Producer) => void }) {
  return (
    <section className="surface">
      <h2 className="surface-h">Targets</h2>
      <p className="surface-hint">Drag a card onto a matrix cell, row, or column to assign it. Tap an effort segment to retune it.</p>
      <div className="tray">
        {((config.targets || []) as AnyTarget[]).map((t) => (
          <TargetCard key={t.id} target={t} commit={commit} />
        ))}
        <AddTargetCard config={config} commit={commit} />
      </div>
    </section>
  );
}

// ── 2. MATRIX BOARD ───────────────────────────────────────────────────────────
function MatrixCell({ config, tt, tier, commit }: { config: Cfg; tt: string; tier: string; commit: (p: Producer) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `cell:${tt}:${tier}` });
  const r = resolveRoute(config, config.activeProfile, { taskType: tt, tier });
  const explicit = r.via === "cell";
  const clear = () =>
    commit((draft) => {
      const rows = draft.profiles[config.activeProfile].matrix.rows || {};
      if (rows[tt] && rows[tt].cells) delete rows[tt].cells[tier as keyof typeof rows[typeof tt]["cells"]];
      return draft;
    });
  return (
    <td
      ref={setNodeRef}
      className={`cell${isOver ? " over" : ""}${explicit ? " explicit" : " inherited"}`}
      onClick={explicit ? clear : undefined}
      title={explicit ? "tap to clear (revert to inherited)" : `inherited · ${r.ruleId}`}
    >
      <Token config={config} targetId={r.targetId} faded={!explicit} rule={r.ruleId} />
    </td>
  );
}

function RowHeader({ config, tt, commit }: { config: Cfg; tt: string; commit: (p: Producer) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `row:${tt}` });
  const row = (config.profiles[config.activeProfile].matrix.rows || {})[tt];
  const def = row?.default || null;
  const clear = () =>
    commit((draft) => {
      const r = (draft.profiles[config.activeProfile].matrix.rows || {})[tt];
      if (r) delete r.default;
      return draft;
    });
  return (
    <th ref={setNodeRef} className={`rowhead${isOver ? " over" : ""}`} scope="row">
      <span className="rh-name">{tt}</span>
      {def ? (
        <span className="rh-def" onClick={clear} title={`row default ${def} - tap to clear`}>
          <Token config={config} targetId={def} rule="row-default" />
        </span>
      ) : (
        <span className="rh-inherit">inherits</span>
      )}
    </th>
  );
}

function ColHeader({ config, tier, commit }: { config: Cfg; tier: string; commit: (p: Producer) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${tier}` });
  const def = (config.profiles[config.activeProfile].matrix.columns || {})[tier as keyof Cfg["profiles"][string]["matrix"]["columns"]] || null;
  const clear = () =>
    commit((draft) => {
      const cols = draft.profiles[config.activeProfile].matrix.columns;
      if (cols) delete cols[tier as keyof typeof cols];
      return draft;
    });
  return (
    <th ref={setNodeRef} className={`colhead${isOver ? " over" : ""}`} scope="col">
      <span className="ch-name">{tier}</span>
      {def ? (
        <span className="ch-def" onClick={clear} title={`column default ${def} - tap to clear`}>
          <Token config={config} targetId={def} rule="column-default" />
        </span>
      ) : null}
    </th>
  );
}

function GlobalDefaultCorner({ config }: { config: Cfg }) {
  const { setNodeRef, isOver } = useDroppable({ id: "def" });
  const def = config.profiles[config.activeProfile].matrix.defaults?.target || null;
  return (
    <th ref={setNodeRef} className={`corner${isOver ? " over" : ""}`} scope="col">
      <span className="corner-label">task / tier</span>
      <span className="corner-def">
        <span className="corner-def-l">board default</span>
        <Token config={config} targetId={def} rule="global-default" />
      </span>
    </th>
  );
}

function MatrixBoard({ config, commit }: { config: Cfg; commit: (p: Producer) => void }) {
  const taskTypes = config.taskTypes || [];
  const tiers = config.tiers || [];
  return (
    <section className="surface">
      <h2 className="surface-h">Matrix</h2>
      <p className="surface-hint">
        Solid tokens are set here; faded tokens are inherited (cell &rsaquo; row &rsaquo; column &rsaquo; board default). Drop on a
        header to set a whole row or column; tap a solid token to clear it.
      </p>
      <div className="matrix-scroll">
        <table className="matrix">
          <thead>
            <tr>
              <GlobalDefaultCorner config={config} />
              {tiers.map((tier) => (
                <ColHeader key={tier} config={config} tier={tier} commit={commit} />
              ))}
            </tr>
          </thead>
          <tbody>
            {taskTypes.map((tt) => (
              <tr key={tt}>
                <RowHeader config={config} tt={tt} commit={commit} />
                {tiers.map((tier) => (
                  <MatrixCell key={tier} config={config} tt={tt} tier={tier} commit={commit} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── 3. WORK-KIND RAILS ────────────────────────────────────────────────────────
function planForKind(config: Cfg, kind: string): { planName: string; plan: PhasePlan } {
  const planName = config.workKinds[kind].phasePlan;
  return { planName, plan: config.phasePlans[planName] };
}
function planPhaseIds(plan: PhasePlan): string[] {
  return (plan.phases || []).map((p: PhaseEntry) => (typeof p === "string" ? p : p.id));
}

function ChipBody({
  config,
  kind,
  ph,
  inPlan,
  onToggle,
  onInspect,
  grip
}: {
  config: Cfg;
  kind: string;
  ph: RailPhase;
  inPlan: boolean;
  onToggle: () => void;
  onInspect: () => void;
  grip?: React.ReactNode;
}) {
  const r = resolveRoute(config, config.activeProfile, { taskType: ph.id, tier: "T1-standard" });
  const t = targetById(config, r.targetId);
  const g = glyphFor(t);
  const ToggleIcon = ph.on ? IconCheck : inPlan ? IconRing : IconPlus;
  return (
    <div className={`chip${ph.on ? " on" : " off"}`} title={ph.on ? "" : ph.off_reason === "phase-plan" ? "not in this plan" : "toggled off"}>
      {grip}
      <button
        type="button"
        className="chip-toggle"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onToggle}
        aria-label={ph.on ? "turn phase off" : "turn phase on"}
      >
        <span className="tg-mark">
          <ToggleIcon />
        </span>
      </button>
      <button
        type="button"
        className="chip-info"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onInspect}
      >
        <span className="chip-name">{ph.id}</span>
        <span className="chip-skill">{ph.skill || "(no skill)"}</span>
        <span className="chip-target">
          <span className={`glyph sm ${g.cls}`}>{g.mark}</span>
          {t ? `${t.model || t.runtime}${t.effort ? " · " + t.effort : ""}` : "-"}
        </span>
      </button>
    </div>
  );
}

function SortableChip(props: {
  config: Cfg;
  kind: string;
  ph: RailPhase;
  onToggle: () => void;
  onInspect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `chip:${props.kind}:${props.ph.id}`
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined
  };
  return (
    <div ref={setNodeRef} style={style} className="chip-wrap">
      <ChipBody
        {...props}
        inPlan
        grip={
          <span className="chip-grip" {...attributes} {...listeners} aria-label="drag to reorder">
            <IconGrip />
          </span>
        }
      />
    </div>
  );
}

function WorkKindRail({
  config,
  kind,
  commit,
  onInspect
}: {
  config: Cfg;
  kind: string;
  commit: (p: Producer) => void;
  onInspect: (kind: string, phase: string) => void;
}) {
  let rail: Rail | null = null;
  try {
    rail = railFor(config, kind);
  } catch (err) {
    return <div className="rail err">rail error: {String((err as Error)?.message || err)}</div>;
  }
  const { plan } = planForKind(config, kind);
  const inPlanIds = planPhaseIds(plan);
  const inPlanSet = new Set(inPlanIds);
  const inPlanPhases = rail.phases.filter((p) => inPlanSet.has(p.id));
  const offPhases = rail.phases.filter((p) => !inPlanSet.has(p.id));
  const sortableIds = inPlanIds.map((id) => `chip:${kind}:${id}`);

  const toggle = (phaseId: string) =>
    commit((draft) => {
      const p = draft.phasePlans[draft.workKinds[kind].phasePlan];
      const arr = p.phases as PhaseEntry[];
      const idx = arr.findIndex((e) => (typeof e === "string" ? e : e.id) === phaseId);
      if (idx === -1) {
        arr.push(phaseId); // was not in plan → add it on
      } else {
        const cur = arr[idx];
        const isOn = typeof cur === "string" ? true : cur.on !== false;
        arr[idx] = isOn ? { id: phaseId, on: false } : phaseId;
      }
      return draft;
    });

  return (
    <div className="rail">
      <div className="rail-head">
        <span className="rail-kind">{kind}</span>
        {kind === config.defaultWorkKind ? <span className="rail-badge">default</span> : null}
        <span className="rail-plan">plan: {plan ? config.workKinds[kind].phasePlan : "?"}</span>
        <span className="rail-ev">evidence: {rail.evidence}</span>
      </div>
      {config.workKinds[kind].description ? <div className="rail-desc">{config.workKinds[kind].description}</div> : null}
      <div className="rail-track">
        <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
          {inPlanPhases.map((ph) => (
            <SortableChip
              key={ph.id}
              config={config}
              kind={kind}
              ph={ph}
              onToggle={() => toggle(ph.id)}
              onInspect={() => onInspect(kind, ph.id)}
            />
          ))}
        </SortableContext>
        {offPhases.map((ph) => (
          <div key={ph.id} className="chip-wrap static">
            <ChipBody
              config={config}
              kind={kind}
              ph={ph}
              inPlan={false}
              onToggle={() => toggle(ph.id)}
              onInspect={() => onInspect(kind, ph.id)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = `${base}-copy`;
  let n = 2;
  while (taken.has(name)) name = `${base}-copy-${n++}`;
  return name;
}

function RailsSurface({
  config,
  commit,
  onInspect
}: {
  config: Cfg;
  commit: (p: Producer) => void;
  onInspect: (kind: string, phase: string) => void;
}) {
  const kinds = Object.keys(config.workKinds || {});
  const cloneKind = () => {
    const src = config.defaultWorkKind && config.workKinds[config.defaultWorkKind] ? config.defaultWorkKind : kinds[0];
    if (!src) return;
    commit((draft) => {
      const newKind = uniqueName(src, new Set(Object.keys(draft.workKinds)));
      const srcKind = draft.workKinds[src];
      const newPlan = uniqueName(srcKind.phasePlan, new Set(Object.keys(draft.phasePlans)));
      draft.phasePlans[newPlan] = structuredClone(draft.phasePlans[srcKind.phasePlan]);
      draft.workKinds[newKind] = {
        phasePlan: newPlan,
        description: srcKind.description ? `${srcKind.description} (copy)` : "Cloned work kind"
      };
      const over = draft.phaseSkills?.overrides?.[src];
      if (over) {
        draft.phaseSkills.overrides[newKind] = structuredClone(over);
      }
      return draft;
    });
  };
  return (
    <section className="surface">
      <div className="surface-h-row">
        <h2 className="surface-h">Work-kind rails</h2>
        <button type="button" className="ghost" onClick={cloneKind}>
          + Add work kind
        </button>
      </div>
      <p className="surface-hint">
        Each rail is a phase plan. Tap a chip&rsquo;s toggle to switch a phase on/off (off stays visible - honesty), drag the
        grip to reorder, tap the body to inspect the skill and evidence.
      </p>
      {kinds.map((kind) => (
        <WorkKindRail key={kind} config={config} kind={kind} commit={commit} onInspect={onInspect} />
      ))}
    </section>
  );
}

// ── inspector (bottom sheet / side panel) ─────────────────────────────────────
function Inspector({
  config,
  target,
  commit,
  onClose
}: {
  config: Cfg;
  target: { kind: string; phase: string };
  commit: (p: Producer) => void;
  onClose: () => void;
}) {
  const { kind, phase } = target;
  const planName = config.workKinds[kind]?.phasePlan;
  const plan = planName ? config.phasePlans[planName] : undefined;
  const binding = config.phaseSkills?.bindings?.[phase] || "";
  const override = config.phaseSkills?.overrides?.[kind]?.[phase];
  const skillValue = override ?? binding;
  const skillOptions = Array.from(new Set(Object.values(config.phaseSkills?.bindings || {}).filter(Boolean)));

  const setSkill = (v: string) =>
    commit((draft) => {
      draft.phaseSkills = draft.phaseSkills || { bindings: {}, overrides: {} };
      draft.phaseSkills.overrides = draft.phaseSkills.overrides || {};
      const forKind = (draft.phaseSkills.overrides[kind] = draft.phaseSkills.overrides[kind] || {});
      if (!v.trim() || v.trim() === binding) delete forKind[phase];
      else forKind[phase] = v.trim();
      return draft;
    });
  const setEvidence = (v: string) =>
    commit((draft) => {
      if (planName && draft.phasePlans[planName]) draft.phasePlans[planName].evidence = v as PhasePlan["evidence"];
      return draft;
    });

  return (
    <>
      <div className="sheet-scrim" onClick={onClose} />
      <aside className="inspector" role="dialog" aria-label="phase inspector">
        <div className="insp-head">
          <div>
            <div className="insp-title">{phase}</div>
            <div className="insp-sub">{kind} · plan {planName}</div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="close">
            <IconClose />
          </button>
        </div>
        <label className="insp-field">
          <span className="insp-label">Skill (per-kind override)</span>
          <input
            list="skill-registry"
            value={skillValue}
            placeholder={binding || "skill id"}
            onChange={(e) => setSkill(e.target.value)}
          />
          <datalist id="skill-registry">
            {skillOptions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <span className="insp-note">{override ? "overrides the registry binding" : `binding: ${binding || "none"}`}</span>
        </label>
        <label className="insp-field">
          <span className="insp-label">Plan evidence</span>
          <select value={plan?.evidence || "none"} onChange={(e) => setEvidence(e.target.value)}>
            {EVIDENCE_KINDS.map((ev) => (
              <option key={ev} value={ev}>
                {ev}
              </option>
            ))}
          </select>
          <span className="insp-note">applies to every kind on plan {planName}</span>
        </label>
      </aside>
    </>
  );
}

// ── 4. TRY-IT STRIP ───────────────────────────────────────────────────────────
type TryItResult = {
  classification?: { taskType?: string; tier?: string; execution?: string };
  workKind?: string | null;
  rail?: Rail | null;
  error?: string;
};
function TryItStrip({ config }: { config: Cfg }) {
  const kinds = Object.keys(config.workKinds || {});
  const [prompt, setPrompt] = useState("");
  const [workKind, setWorkKind] = useState(config.defaultWorkKind || kinds[0] || "");
  const [result, setResult] = useState<TryItResult | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    try {
      const r = await fetch("/simulate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tryIt: true, prompt, workKind })
      });
      setResult(await r.json());
    } catch (err) {
      setResult({ error: String((err as Error)?.message || err) });
    } finally {
      setBusy(false);
    }
  };
  const rail = result?.rail || null;
  const exec = result?.classification?.execution;
  return (
    <section className="surface">
      <h2 className="surface-h">Try it</h2>
      <div className="tryit-row">
        <input
          className="tryit-input"
          placeholder="Paste a sample request - e.g. implement a login page"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") run();
          }}
        />
        <select value={workKind} onChange={(e) => setWorkKind(e.target.value)}>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <button type="button" className="primary" onClick={run} disabled={busy}>
          {busy ? "..." : "Dry run"}
        </button>
      </div>
      <p className="tryit-note">
        Deterministic dry-run: a heuristic classifier resolves the rail here. The real live classifier runs at the gateway.
      </p>
      {result?.error ? <div className="tryit-err">{result.error}</div> : null}
      {result && !result.error ? (
        <div className="tryit-out">
          <div className="tryit-chain">
            <span className="pill">kind: {result.workKind || "?"}</span>
            <span className="pill">tier: {result.classification?.tier || "?"}</span>
            <span className="pill">type: {result.classification?.taskType || "?"}</span>
            {exec ? <span className={`pill exec ${exec}`}>{exec}</span> : null}
          </div>
          {rail ? (
            <div className="tryit-rail">
              {rail.phases.map((ph: RailPhase & { target?: AnyTarget }) => {
                const t = ph.target || null;
                const g = glyphFor(t);
                return (
                  <div key={ph.id} className={`tchip${ph.on ? " on" : " off"}`}>
                    <span className="tchip-name">{ph.id}</span>
                    <span className="tchip-skill">{ph.skill || "(no skill)"}</span>
                    {ph.on && t ? (
                      <span className="tchip-target">
                        <span className={`glyph sm ${g.cls}`}>{g.mark}</span>
                        {t.model || t.runtime}
                        {t.effort ? ` · ${t.effort}` : ""}
                        {t.runtime ? ` · ${t.runtime}` : ""}
                      </span>
                    ) : (
                      <span className="tchip-off">off</span>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// ── recent decisions (read-only telemetry) ────────────────────────────────────
type Decision = { targetId?: string; ruleId?: string; profile?: string; taskType?: string; tier?: string };
function RecentDecisions() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ count: number; recent: Decision[] } | null>(null);
  useEffect(() => {
    if (open && !data) {
      fetch("/telemetry")
        .then((r) => r.json())
        .then((j) => setData({ count: j.count || 0, recent: j.recent || [] }))
        .catch(() => setData({ count: 0, recent: [] }));
    }
  }, [open, data]);
  return (
    <section className="surface collapsible">
      <button type="button" className="collapse-h" onClick={() => setOpen(!open)}>
        <span className={`caret${open ? " open" : ""}`}>›</span> Recent decisions{data ? ` (${data.count})` : ""}
      </button>
      {open ? (
        <div className="decisions">
          {data && data.recent.length ? (
            data.recent.slice(0, 20).map((d, i) => (
              <div key={i} className="decision">
                <span className="d-type">{d.taskType || "?"}/{d.tier || "?"}</span>
                <span className="d-arrow">&rsaquo;</span>
                <span className="d-target">{d.targetId || "?"}</span>
                <span className="d-rule">{d.ruleId || ""}</span>
              </div>
            ))
          ) : (
            <div className="muted">no decisions logged yet</div>
          )}
        </div>
      ) : null}
    </section>
  );
}

// ── header / status ───────────────────────────────────────────────────────────
function StatusPill({ state }: { state: SaveState }) {
  if (state === "saving") return <span className="status saving">saving…</span>;
  if (state === "saved") return <span className="status saved">saved</span>;
  if (state === "conflict") return <span className="status warn">conflict</span>;
  if (state === "invalid") return <span className="status bad">rejected</span>;
  return <span className="status idle">idle</span>;
}

// ── app ───────────────────────────────────────────────────────────────────────
function App() {
  const { config, saveState, errors, commit, reload, dismissErrors } = usePolicyDraft();
  const [inspector, setInspector] = useState<{ kind: string; phase: string } | null>(null);
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } })
  );

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    if (id.startsWith("target:")) setDragTarget(id.slice("target:".length));
  };
  const onDragEnd = (e: DragEndEvent) => {
    setDragTarget(null);
    if (!config) return;
    const activeId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId) return;
    if (activeId.startsWith("target:")) {
      const targetId = activeId.slice("target:".length);
      const parts = overId.split(":");
      if (parts[0] === "cell") assignCell(parts[1], parts[2], targetId);
      else if (parts[0] === "row") assignRowDefault(parts.slice(1).join(":"), targetId);
      else if (parts[0] === "col") assignColumnDefault(parts.slice(1).join(":"), targetId);
      else if (parts[0] === "def") assignGlobalDefault(targetId);
    } else if (activeId.startsWith("chip:") && overId.startsWith("chip:")) {
      const a = activeId.split(":");
      const o = overId.split(":");
      if (a[1] === o[1] && a[2] !== o[2]) reorderPhase(a[1], a[2], o[2]);
    }
  };

  const active = () => (config as Cfg).activeProfile;
  const assignCell = (tt: string, tier: string, targetId: string) =>
    commit((draft) => {
      const rows = (draft.profiles[active()].matrix.rows = draft.profiles[active()].matrix.rows || {});
      const row = (rows[tt] = rows[tt] || { cells: {} });
      row.cells = row.cells || {};
      (row.cells as Record<string, string>)[tier] = targetId;
      return draft;
    });
  const assignRowDefault = (tt: string, targetId: string) =>
    commit((draft) => {
      const rows = (draft.profiles[active()].matrix.rows = draft.profiles[active()].matrix.rows || {});
      const row = (rows[tt] = rows[tt] || { cells: {} });
      row.default = targetId;
      return draft;
    });
  const assignColumnDefault = (tier: string, targetId: string) =>
    commit((draft) => {
      const cols = (draft.profiles[active()].matrix.columns = draft.profiles[active()].matrix.columns || {});
      (cols as Record<string, string>)[tier] = targetId;
      return draft;
    });
  const assignGlobalDefault = (targetId: string) =>
    commit((draft) => {
      const defs = (draft.profiles[active()].matrix.defaults = draft.profiles[active()].matrix.defaults || {});
      defs.target = targetId;
      return draft;
    });
  const reorderPhase = (kind: string, from: string, to: string) =>
    commit((draft) => {
      const plan = draft.phasePlans[draft.workKinds[kind].phasePlan];
      const arr = plan.phases as PhaseEntry[];
      const ids = arr.map((e) => (typeof e === "string" ? e : e.id));
      const fi = ids.indexOf(from);
      const ti = ids.indexOf(to);
      if (fi === -1 || ti === -1) return draft;
      plan.phases = arrayMove(arr, fi, ti);
      return draft;
    });

  if (!config) return <div className="loading">loading policy…</div>;

  const profiles = Object.keys(config.profiles || {});
  const setProfile = (p: string) => commit((draft) => ({ ...draft, activeProfile: p }));

  return (
    <div className="app">
      <header className="topbar">
        <h1>Composer</h1>
        <div className="profiles" role="group" aria-label="profile">
          {profiles.map((p) => (
            <button key={p} type="button" className={`seg${config.activeProfile === p ? " on" : ""}`} onClick={() => setProfile(p)}>
              {p}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <StatusPill state={saveState} />
      </header>

      {saveState === "conflict" ? (
        <div className="banner warn">
          <span>The policy changed on disk since you loaded it. Reload to continue editing.</span>
          <button type="button" className="primary" onClick={reload}>
            Reload
          </button>
        </div>
      ) : null}
      {saveState === "invalid" ? (
        <div className="banner bad">
          <span>Last edit rejected and reverted: {errors.join("; ")}</span>
          <button type="button" onClick={dismissErrors}>
            Dismiss
          </button>
        </div>
      ) : null}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <main className="board">
          <TargetsTray config={config} commit={commit} />
          <MatrixBoard config={config} commit={commit} />
          <RailsSurface config={config} commit={commit} onInspect={(kind, phase) => setInspector({ kind, phase })} />
          <TryItStrip config={config} />
          <RecentDecisions />
        </main>
        <DragOverlay>
          {dragTarget ? (
            <div className="drag-ghost">
              <Token config={config} targetId={dragTarget} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {inspector ? (
        <Inspector config={config} target={inspector} commit={commit} onClose={() => setInspector(null)} />
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
