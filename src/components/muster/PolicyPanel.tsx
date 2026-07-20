"use client";

// The Muster routing-policy panel — the composer surfaces that survived the
// own-port Orchestrator view's retirement (the targets tray lives on the
// Duties tab, the task-type matrix was superseded by the duty ladders, the
// decisions feed by the Decisions tab):
//   1. WORK-KIND RAILS  - one rail per work kind; phases as toggleable,
//                         reorderable chips with a per-phase inspector
//                         (skill override + plan evidence).
//   2. COORDINATION     - same-branch multi-run coordination controls.
//   3. SECURITY         - per-project security_sensitive flags.
//   4. UX-QA            - severity threshold dial.
//   5. TRY-IT           - deterministic dry-run classify + resolved rail.
// Persistence: DRAFT config + baselineSha from GET /api/orchestrator/policy;
// every committed edit debounces an 800ms whole-document PUT (200 → new sha;
// 409 → conflict banner + Reload; 422 → errors + REVERT the last edit).
// Autosave - no Save button. NO emoji - text marks + inline SVG only.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
// Pure core, safe in the browser (no node imports) — the same module the
// runner and the policy API compile with, so the chips resolve identically.
import {
  railFor as railForCore,
  resolveRoute as resolveRouteCore
} from "../../../fittings/seed/orchestrator/lib/routing-core.mjs";
import type {
  PolicyConfigV2,
  PhasePlan,
  Rail,
  RailPhase,
  RouteResolution
} from "../../../fittings/seed/orchestrator/lib/routing-core.mjs";
import styles from "./Policy.module.css";

// A target seen at runtime is looser than the strict union (a secondary can
// carry a model/effort; a workflow has no runtime) - read through this shape.
type AnyTarget = {
  id: string;
  type?: string;
  runtime?: string;
  provider?: string;
  model?: string;
  effort?: string;
  pinned?: boolean;
};
type PhaseEntry = string | { id: string; on?: boolean };

type Cfg = Omit<
  PolicyConfigV2,
  "targets" | "workKinds" | "phasePlans" | "phaseSkills"
> & {
  targets: AnyTarget[];
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
const railFor = railForCore as unknown as (config: Cfg, workKind?: string | null) => Rail;

const EVIDENCE_KINDS = ["video", "logs", "text", "none"];
// Severity vocabulary for the ux-qa threshold (blocker strictest → note loosest).
const SEVERITIES = ["blocker", "major", "minor", "note"];

function targetById(config: Cfg, id: string | null | undefined): AnyTarget | null {
  if (!id) return null;
  return (config.targets || []).find((t) => t.id === id) || null;
}

// ── glyphs (styled text marks - no emoji) ───────────────────────────────────
function glyphFor(t: AnyTarget | null | undefined): { mark: string; cls: string; title: string } {
  if (!t) return { mark: "??", cls: "gOther", title: "unset" };
  if (t.provider === "ollama-local") return { mark: "OL", cls: "gOllama", title: "Ollama (local)" };
  if (t.type === "workflow") return { mark: "WF", cls: "gWorkflow", title: "Workflow" };
  switch (t.runtime) {
    case "claude-code":
      return { mark: "CC", cls: "gClaude", title: "Claude Code" };
    case "agent-sdk":
      return { mark: "SDK", cls: "gSdk", title: "Agent SDK" };
    case "codex":
      return { mark: "CX", cls: "gCodex", title: "Codex" };
    case "gemini":
      return { mark: "GM", cls: "gGemini", title: "Gemini" };
    default:
      return {
        mark: (t.runtime || "?").slice(0, 2).toUpperCase(),
        cls: "gOther",
        title: t.runtime || "target"
      };
  }
}

// Small inline icons (no emoji).
function IconGrip() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="3" cy="2" r="1.1" /><circle cx="9" cy="2" r="1.1" />
      <circle cx="3" cy="6" r="1.1" /><circle cx="9" cy="6" r="1.1" />
      <circle cx="3" cy="10" r="1.1" /><circle cx="9" cy="10" r="1.1" />
    </svg>
  );
}
function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </svg>
  );
}
function IconCheck() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
      <path d="M2.5 7l3 3 5-6.5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconRing() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
      <circle cx="6.5" cy="6.5" r="4.2" stroke="currentColor" strokeWidth="1.5" fill="none" />
    </svg>
  );
}
function IconPlus() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
      <path d="M6.5 2.5v8M2.5 6.5h8" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" />
    </svg>
  );
}

// ── persistence hook (draft + debounced whole-document PUT) ─────────────────
type SaveState = "idle" | "saving" | "saved" | "conflict" | "invalid";
function usePolicyDraft(compositionId: string) {
  const [config, setConfig] = useState<Cfg | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const baselineRef = useRef("");
  const lastGoodRef = useRef<Cfg | null>(null); // last server-confirmed draft (revert target)
  const draftRef = useRef<Cfg | null>(null); // current draft - source of truth for saves
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const pendingRef = useRef(false);
  const compRef = useRef(compositionId);
  compRef.current = compositionId;

  const load = useCallback(async () => {
    try {
      const r = await fetch(
        `/api/orchestrator/policy?composition=${encodeURIComponent(compRef.current)}`
      );
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      baselineRef.current = j.baselineSha;
      lastGoodRef.current = j.config;
      draftRef.current = j.config;
      setConfig(j.config);
      setErrors([]);
      setLoadError(null);
      setSaveState("idle");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, compositionId]);

  const doPut = useCallback(async () => {
    const sent = draftRef.current;
    if (!sent) return;
    savingRef.current = true;
    setSaveState("saving");
    let r: Response;
    try {
      r = await fetch("/api/orchestrator/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          composition: compRef.current,
          baseline: baselineRef.current,
          config: sent
        })
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
    setWarnings(Array.isArray(j.warnings) ? j.warnings : []);
    setSaveState("saved");
    if (pendingRef.current) {
      pendingRef.current = false;
      void doPut();
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
        void doPut();
      }, 800);
    },
    [doPut]
  );

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return {
    config,
    loadError,
    saveState,
    errors,
    warnings,
    commit,
    reload: load,
    dismissErrors: () => setSaveState("idle"),
    dismissWarnings: () => setWarnings([])
  };
}

// ── work-kind rails ─────────────────────────────────────────────────────────
function planForKind(config: Cfg, kind: string): { planName: string; plan: PhasePlan } {
  const planName = config.workKinds[kind].phasePlan;
  return { planName, plan: config.phasePlans[planName] };
}
function planPhaseIds(plan: PhasePlan): string[] {
  return (plan.phases || []).map((p: PhaseEntry) => (typeof p === "string" ? p : p.id));
}

function ChipBody({
  config,
  ph,
  inPlan,
  onToggle,
  onInspect,
  grip
}: {
  config: Cfg;
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
    <div
      className={`${styles.chip} ${ph.on ? styles.chipOn : styles.chipOff}`}
      title={ph.on ? "" : ph.off_reason === "phase-plan" ? "not in this plan" : "toggled off"}
    >
      {grip}
      <button
        type="button"
        className={styles.chipToggle}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onToggle}
        aria-label={ph.on ? "turn phase off" : "turn phase on"}
      >
        <ToggleIcon />
      </button>
      <button
        type="button"
        className={styles.chipInfo}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onInspect}
      >
        <span className={styles.chipName}>{ph.id}</span>
        <span className={styles.chipSkill}>{ph.skill || "(no skill)"}</span>
        <span className={styles.chipTarget}>
          <span className={`${styles.glyph} ${styles[g.cls]}`} title={g.title}>
            {g.mark}
          </span>
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
    <div ref={setNodeRef} style={style}>
      <ChipBody
        config={props.config}
        ph={props.ph}
        inPlan
        onToggle={props.onToggle}
        onInspect={props.onInspect}
        grip={
          <span className={styles.chipGrip} {...attributes} {...listeners} aria-label="drag to reorder">
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
    return (
      <div className={styles.railError}>
        rail error: {String((err as Error)?.message || err)}
      </div>
    );
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
    <div className={styles.rail} data-testid={`policy-rail-${kind}`}>
      <div className={styles.railHead}>
        <span className={styles.railKind}>{kind}</span>
        {kind === config.defaultWorkKind ? <span className={styles.railBadge}>default</span> : null}
        <span className={styles.railMeta}>plan: {config.workKinds[kind].phasePlan}</span>
        <span className={styles.railMeta}>evidence: {rail.evidence}</span>
      </div>
      {config.workKinds[kind].description ? (
        <div className={styles.railDesc}>{config.workKinds[kind].description}</div>
      ) : null}
      <div className={styles.railTrack}>
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
          <ChipBody
            key={ph.id}
            config={config}
            ph={ph}
            inPlan={false}
            onToggle={() => toggle(ph.id)}
            onInspect={() => onInspect(kind, ph.id)}
          />
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
    const src =
      config.defaultWorkKind && config.workKinds[config.defaultWorkKind]
        ? config.defaultWorkKind
        : kinds[0];
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
    <section className={styles.surface} data-testid="policy-rails">
      <div className={styles.surfaceHeadRow}>
        <h3 className={styles.surfaceHead}>Work-kind rails</h3>
        <button type="button" className={styles.ghostBtn} onClick={cloneKind}>
          + Add work kind
        </button>
      </div>
      <p className={styles.surfaceHint}>
        Each rail is a phase plan. Tap a chip&rsquo;s toggle to switch a phase on/off (off stays
        visible - honesty), drag the grip to reorder, tap the body to inspect the skill and
        evidence.
      </p>
      {kinds.map((kind) => (
        <WorkKindRail key={kind} config={config} kind={kind} commit={commit} onInspect={onInspect} />
      ))}
    </section>
  );
}

// ── inspector (overlay panel) ───────────────────────────────────────────────
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
  const skillOptions = Array.from(
    new Set(Object.values(config.phaseSkills?.bindings || {}).filter(Boolean))
  );

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
      if (planName && draft.phasePlans[planName])
        draft.phasePlans[planName].evidence = v as PhasePlan["evidence"];
      return draft;
    });

  return (
    <>
      <div className={styles.scrim} onClick={onClose} />
      <aside className={styles.inspector} role="dialog" aria-label="phase inspector">
        <div className={styles.inspHead}>
          <div>
            <div className={styles.inspTitle}>{phase}</div>
            <div className={styles.inspSub}>
              {kind} · plan {planName}
            </div>
          </div>
          <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="close">
            <IconClose />
          </button>
        </div>
        <label className={styles.inspField}>
          <span className={styles.inspLabel}>Skill (per-kind override)</span>
          <input
            list="policy-skill-registry"
            value={skillValue}
            placeholder={binding || "skill id"}
            onChange={(e) => setSkill(e.target.value)}
          />
          <datalist id="policy-skill-registry">
            {skillOptions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <span className={styles.inspNote}>
            {override ? "overrides the registry binding" : `binding: ${binding || "none"}`}
          </span>
        </label>
        <label className={styles.inspField}>
          <span className={styles.inspLabel}>Plan evidence</span>
          <select value={plan?.evidence || "none"} onChange={(e) => setEvidence(e.target.value)}>
            {EVIDENCE_KINDS.map((ev) => (
              <option key={ev} value={ev}>
                {ev}
              </option>
            ))}
          </select>
          <span className={styles.inspNote}>applies to every kind on plan {planName}</span>
        </label>
      </aside>
    </>
  );
}

// ── coordination ────────────────────────────────────────────────────────────
// Editing ANY control writes the `coordination` section into the config, which
// recompiles policy.json — the engine treats a present section as
// "coordination on". fences + leaseTtlMinutes pass through verbatim.
type CoordSection = {
  enabled?: boolean;
  serializeWhenUnavailable?: boolean;
  thresholds?: { heavyFiles?: number; heavyRatio?: number };
  exclusiveLeases?: string[];
};
function coordView(config: Cfg) {
  const c = (config as { coordination?: CoordSection }).coordination || {};
  return {
    enabled: c.enabled !== false,
    heavyFiles: c.thresholds?.heavyFiles ?? 3,
    heavyRatio: c.thresholds?.heavyRatio ?? 0.5,
    leases: Array.isArray(c.exclusiveLeases) ? c.exclusiveLeases : [],
    serialize: c.serializeWhenUnavailable !== false
  };
}
function ensureCoord(draft: Cfg): CoordSection {
  const d = draft as { coordination?: CoordSection };
  const c = (d.coordination = d.coordination || {});
  c.thresholds = c.thresholds || {};
  if (!Array.isArray(c.exclusiveLeases)) c.exclusiveLeases = [];
  return c;
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <span className={styles.toggle} role="group" aria-label={label || "toggle"}>
      <button
        type="button"
        className={`${styles.seg} ${on ? styles.segOn : ""}`}
        onClick={() => onChange(true)}
      >
        on
      </button>
      <button
        type="button"
        className={`${styles.seg} ${!on ? styles.segOn : ""}`}
        onClick={() => onChange(false)}
      >
        off
      </button>
    </span>
  );
}

function CoordinationSurface({ config, commit }: { config: Cfg; commit: (p: Producer) => void }) {
  const v = coordView(config);
  const [newLease, setNewLease] = useState("");
  const setEnabled = (on: boolean) => commit((d) => ((ensureCoord(d).enabled = on), d));
  const setSerialize = (on: boolean) =>
    commit((d) => ((ensureCoord(d).serializeWhenUnavailable = on), d));
  const setHeavyFiles = (n: number) =>
    commit((d) => ((ensureCoord(d).thresholds!.heavyFiles = Math.max(1, Math.round(n))), d));
  const setHeavyRatio = (n: number) =>
    commit((d) => ((ensureCoord(d).thresholds!.heavyRatio = Math.min(1, Math.max(0.01, n))), d));
  const addLease = () => {
    const t = newLease.trim();
    if (!t) return;
    commit((d) => {
      const c = ensureCoord(d);
      if (!c.exclusiveLeases!.includes(t)) c.exclusiveLeases!.push(t);
      return d;
    });
    setNewLease("");
  };
  const removeLease = (p: string) =>
    commit((d) => {
      const c = ensureCoord(d);
      c.exclusiveLeases = (c.exclusiveLeases || []).filter((x) => x !== p);
      return d;
    });

  return (
    <section className={styles.surface} data-testid="policy-coordination">
      <h3 className={styles.surfaceHead}>Coordination</h3>
      <p className={styles.surfaceHint}>
        How concurrent autonomous runs on the same project + branch avoid stepping on each other.
        Overlap is scored from each run&rsquo;s predicted touch-set; heavy overlap serializes,
        medium waits for the earlier run&rsquo;s stability point.
      </p>
      <div className={styles.ctlGrid}>
        <div className={styles.ctlRow}>
          <span className={styles.ctlLabel}>Enabled</span>
          <Toggle on={v.enabled} onChange={setEnabled} label="coordination enabled" />
          <span className={styles.ctlNote}>off = runs never coordinate (each proceeds independently)</span>
        </div>
        <div className={styles.ctlRow}>
          <span className={styles.ctlLabel}>Heavy: shared files</span>
          <input
            className={styles.ctlNum}
            type="number"
            min={1}
            step={1}
            value={v.heavyFiles}
            onChange={(e) => e.target.value !== "" && setHeavyFiles(Number(e.target.value))}
          />
          <span className={styles.ctlNote}>
            this many shared exact files (or more) grades the overlap heavy → serialize
          </span>
        </div>
        <div className={styles.ctlRow}>
          <span className={styles.ctlLabel}>Heavy: shared ratio</span>
          <input
            className={styles.ctlNum}
            type="number"
            min={0.01}
            max={1}
            step={0.05}
            value={v.heavyRatio}
            onChange={(e) => e.target.value !== "" && setHeavyRatio(Number(e.target.value))}
          />
          <span className={styles.ctlNote}>
            shared files ÷ smaller touch-set at or above this also grades heavy
          </span>
        </div>
        <div className={styles.ctlRow}>
          <span className={styles.ctlLabel}>Serialize when unavailable</span>
          <Toggle on={v.serialize} onChange={setSerialize} label="serialize when unavailable" />
          <span className={styles.ctlNote}>
            if the coordination substrate is down, allow only one live card per project
          </span>
        </div>
      </div>
      <div className={styles.leaseBlock}>
        <div className={styles.ctlLabel}>Exclusive-lease paths</div>
        <p className={styles.ctlNote}>
          A run touching any of these takes an exclusive lease first, so two runs never rewrite it
          at once (lockfiles are the classic case). Repo-relative paths.
        </p>
        <div className={styles.leaseList}>
          {v.leases.length ? (
            v.leases.map((p) => (
              <span key={p} className={styles.leaseItem}>
                <span className={styles.leasePath}>{p}</span>
                <button
                  type="button"
                  className={styles.leaseRemove}
                  aria-label={`remove ${p}`}
                  onClick={() => removeLease(p)}
                >
                  <IconClose />
                </button>
              </span>
            ))
          ) : (
            <span className={styles.muted}>none</span>
          )}
        </div>
        <div className={styles.leaseAdd}>
          <input
            placeholder="add a path, e.g. package-lock.json"
            value={newLease}
            onChange={(e) => setNewLease(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addLease();
            }}
          />
          <button type="button" onClick={addLease} disabled={!newLease.trim()}>
            Add path
          </button>
        </div>
      </div>
    </section>
  );
}

// ── security-sensitive projects ─────────────────────────────────────────────
function SecuritySurface({ config, commit }: { config: Cfg; commit: (p: Producer) => void }) {
  const projects = (config.projects || {}) as Record<string, { security_sensitive?: boolean }>;
  const names = Object.keys(projects).sort();
  const [newProj, setNewProj] = useState("");
  const setFlag = (name: string, on: boolean) =>
    commit((d) => {
      d.projects = d.projects || {};
      const p = ((d.projects as Record<string, { security_sensitive?: boolean }>)[name] =
        (d.projects as Record<string, { security_sensitive?: boolean }>)[name] || {});
      p.security_sensitive = on;
      return d;
    });
  const addProject = () => {
    const t = newProj.trim();
    if (!t) return;
    commit((d) => {
      d.projects = d.projects || {};
      const all = d.projects as Record<string, { security_sensitive?: boolean }>;
      if (!all[t]) all[t] = { security_sensitive: false };
      return d;
    });
    setNewProj("");
  };

  return (
    <section className={styles.surface} data-testid="policy-security">
      <h3 className={styles.surfaceHead}>Security-sensitive projects</h3>
      <p className={styles.surfaceHint}>
        Mark a project security-sensitive to add the opt-in security-review phase to its runs
        (boundary rubric + cross-model checks). No default work kind includes security-review
        otherwise.
      </p>
      <div className={styles.projList}>
        {names.length ? (
          names.map((name) => (
            <div key={name} className={styles.projRow}>
              <span className={styles.projName}>{name}</span>
              <Toggle
                on={!!projects[name]?.security_sensitive}
                onChange={(on) => setFlag(name, on)}
                label={`${name} security-sensitive`}
              />
            </div>
          ))
        ) : (
          <div className={styles.muted}>no projects configured yet</div>
        )}
      </div>
      <div className={styles.leaseAdd}>
        <input
          placeholder="add a project label, e.g. my-app"
          value={newProj}
          onChange={(e) => setNewProj(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addProject();
          }}
        />
        <button type="button" onClick={addProject} disabled={!newProj.trim()}>
          Add project
        </button>
      </div>
    </section>
  );
}

// ── ux-qa threshold ─────────────────────────────────────────────────────────
function QaSurface({ config, commit }: { config: Cfg; commit: (p: Producer) => void }) {
  const sev = (config.uxQa as { severityThreshold?: string } | undefined)?.severityThreshold || "major";
  const setSev = (v: string) =>
    commit((d) => {
      const dd = d as { uxQa?: { severityThreshold?: string } };
      dd.uxQa = dd.uxQa || {};
      dd.uxQa.severityThreshold = v;
      return d;
    });
  return (
    <section className={styles.surface} data-testid="policy-uxqa">
      <h3 className={styles.surfaceHead}>UX-QA threshold</h3>
      <p className={styles.surfaceHint}>
        The ux-qa phase records findings by severity. At or above this level a finding loops the
        slice back to implement; below, it is recorded as a note.
      </p>
      <div className={styles.sevDial} role="group" aria-label="ux-qa severity threshold">
        {SEVERITIES.map((s) => (
          <button
            key={s}
            type="button"
            className={`${styles.seg} ${sev === s ? styles.segOn : ""}`}
            onClick={() => setSev(s)}
          >
            {s}
          </button>
        ))}
      </div>
    </section>
  );
}

// ── try-it strip ────────────────────────────────────────────────────────────
type GateResolution = {
  securityReview?: {
    included?: boolean;
    byPlan?: boolean;
    byProject?: boolean;
    project?: string | null;
    reason?: string;
  };
  uxQa?: { included?: boolean; severityThreshold?: string; reason?: string };
};
type TryItRail = Omit<Rail, "phases"> & { phases: (RailPhase & { target?: AnyTarget })[] };
type TryItResult = {
  classification?: { taskType?: string; tier?: string; execution?: string };
  workKind?: string | null;
  project?: string | null;
  rail?: TryItRail | { error: string } | null;
  gates?: GateResolution | null;
  error?: string;
};

function TryItStrip({ config, compositionId }: { config: Cfg; compositionId: string }) {
  const kinds = Object.keys(config.workKinds || {});
  const projectNames = Object.keys(config.projects || {}).sort();
  const [prompt, setPrompt] = useState("");
  const [workKind, setWorkKind] = useState(config.defaultWorkKind || kinds[0] || "");
  const [project, setProject] = useState("");
  const [result, setResult] = useState<TryItResult | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/orchestrator/simulate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ composition: compositionId, prompt, workKind, project: project || null })
      });
      setResult(await r.json());
    } catch (err) {
      setResult({ error: String((err as Error)?.message || err) });
    } finally {
      setBusy(false);
    }
  };
  const rail =
    result?.rail && !("error" in (result.rail as object)) ? (result.rail as TryItRail) : null;
  const exec = result?.classification?.execution;
  const gates = result?.gates || null;
  return (
    <section className={styles.surface} data-testid="policy-tryit">
      <h3 className={styles.surfaceHead}>Try it</h3>
      <div className={styles.tryitRow}>
        <input
          className={styles.tryitInput}
          placeholder="Paste a sample request - e.g. implement a login page"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
          }}
        />
        <select value={workKind} onChange={(e) => setWorkKind(e.target.value)} aria-label="work kind">
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="project">
          <option value="">(no project)</option>
          {projectNames.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button type="button" className={styles.primaryBtn} onClick={() => void run()} disabled={busy}>
          {busy ? "..." : "Dry run"}
        </button>
      </div>
      <p className={styles.surfaceHint}>
        Deterministic dry-run: a heuristic classifier resolves the rail here. The real live
        classifier runs at the gateway.
      </p>
      {result?.error ? <div className={styles.tryitError}>{result.error}</div> : null}
      {result && !result.error ? (
        <div className={styles.tryitOut}>
          <div className={styles.tryitChain}>
            <span className={styles.pill}>kind: {result.workKind || "?"}</span>
            <span className={styles.pill}>tier: {result.classification?.tier || "?"}</span>
            <span className={styles.pill}>type: {result.classification?.taskType || "?"}</span>
            {result.project ? <span className={styles.pill}>project: {result.project}</span> : null}
            {exec ? <span className={styles.pill}>{exec}</span> : null}
          </div>
          {gates ? (
            <div className={styles.tryitGates}>
              <div className={styles.gateRow}>
                <span className={styles.gateName}>security-review</span>
                <span
                  className={`${styles.gateFlag} ${gates.securityReview?.included ? styles.gateOn : styles.gateOff}`}
                >
                  {gates.securityReview?.included ? "included" : "not included"}
                </span>
                <span className={styles.gateWhy}>{gates.securityReview?.reason}</span>
              </div>
              <div className={styles.gateRow}>
                <span className={styles.gateName}>ux-qa</span>
                <span
                  className={`${styles.gateFlag} ${gates.uxQa?.included ? styles.gateOn : styles.gateOff}`}
                >
                  {gates.uxQa?.included ? "included" : "not included"}
                </span>
                <span className={styles.gateWhy}>{gates.uxQa?.reason}</span>
              </div>
            </div>
          ) : null}
          {rail ? (
            <div className={styles.tryitRail}>
              {rail.phases.map((ph) => {
                const t = ph.target || null;
                const g = glyphFor(t);
                return (
                  <div key={ph.id} className={`${styles.tchip} ${ph.on ? styles.chipOn : styles.chipOff}`}>
                    <span className={styles.chipName}>{ph.id}</span>
                    <span className={styles.chipSkill}>{ph.skill || "(no skill)"}</span>
                    {ph.on && t ? (
                      <span className={styles.chipTarget}>
                        <span className={`${styles.glyph} ${styles[g.cls]}`} title={g.title}>
                          {g.mark}
                        </span>
                        {t.model || t.runtime}
                        {t.effort ? ` · ${t.effort}` : ""}
                        {t.runtime ? ` · ${t.runtime}` : ""}
                      </span>
                    ) : (
                      <span className={styles.muted}>off</span>
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

// ── status pill ─────────────────────────────────────────────────────────────
function StatusPill({ state }: { state: SaveState }) {
  if (state === "saving") return <span className={`${styles.status} ${styles.statusSaving}`}>saving…</span>;
  if (state === "saved") return <span className={`${styles.status} ${styles.statusSaved}`}>saved</span>;
  if (state === "conflict") return <span className={`${styles.status} ${styles.statusWarn}`}>conflict</span>;
  if (state === "invalid") return <span className={`${styles.status} ${styles.statusBad}`}>rejected</span>;
  return null;
}

// ── panel ───────────────────────────────────────────────────────────────────
export function PolicyPanel({ compositionId }: { compositionId: string }) {
  const { config, loadError, saveState, errors, warnings, commit, reload, dismissErrors, dismissWarnings } =
    usePolicyDraft(compositionId);
  const [inspector, setInspector] = useState<{ kind: string; phase: string } | null>(null);

  // Chip reordering gets its OWN DndContext (nested inside the Muster page's
  // target-drag context; the chip draggables register here only).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } })
  );
  const onDragEnd = (e: DragEndEvent) => {
    if (!config) return;
    const activeId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId || !activeId.startsWith("chip:") || !overId.startsWith("chip:")) return;
    const a = activeId.split(":");
    const o = overId.split(":");
    if (a[1] !== o[1] || a[2] === o[2]) return;
    const kind = a[1];
    commit((draft) => {
      const plan = draft.phasePlans[draft.workKinds[kind].phasePlan];
      const arr = plan.phases as PhaseEntry[];
      const ids = arr.map((entry) => (typeof entry === "string" ? entry : entry.id));
      const fi = ids.indexOf(a[2]);
      const ti = ids.indexOf(o[2]);
      if (fi === -1 || ti === -1) return draft;
      plan.phases = arrayMove(arr, fi, ti);
      return draft;
    });
  };

  if (loadError && !config) {
    return (
      <section className={styles.section} data-testid="policy-panel">
        <div className={styles.stateBox}>Could not load the routing policy. {loadError}</div>
      </section>
    );
  }
  if (!config) {
    return (
      <section className={styles.section} data-testid="policy-panel">
        <div className={styles.skel} data-testid="policy-loading" />
      </section>
    );
  }

  return (
    <section className={styles.section} data-testid="policy-panel">
      <div className={styles.panelHead}>
        <span className={styles.panelLead}>
          The routing policy: which phases each work kind runs, how concurrent runs coordinate,
          and the quality gates. Every edit autosaves and recompiles the policy the run engine
          reads.
        </span>
        <StatusPill state={saveState} />
      </div>

      {saveState === "conflict" ? (
        <div className={`${styles.banner} ${styles.bannerWarn}`} role="alert">
          <span>The policy changed on disk since you loaded it. Reload to continue editing.</span>
          <button type="button" onClick={() => void reload()}>
            Reload
          </button>
        </div>
      ) : null}
      {saveState === "invalid" ? (
        <div className={`${styles.banner} ${styles.bannerBad}`} role="alert">
          <span>Last edit rejected and reverted: {errors.join("; ")}</span>
          <button type="button" onClick={dismissErrors}>
            Dismiss
          </button>
        </div>
      ) : null}
      {warnings.length ? (
        <div className={`${styles.banner} ${styles.bannerWarn}`}>
          <span>Saved with warnings: {warnings.join("; ")}</span>
          <button type="button" onClick={dismissWarnings}>
            Dismiss
          </button>
        </div>
      ) : null}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <RailsSurface config={config} commit={commit} onInspect={(kind, phase) => setInspector({ kind, phase })} />
      </DndContext>
      <CoordinationSurface config={config} commit={commit} />
      <SecuritySurface config={config} commit={commit} />
      <QaSurface config={config} commit={commit} />
      <TryItStrip config={config} compositionId={compositionId} />

      {inspector ? (
        <Inspector config={config} target={inspector} commit={commit} onClose={() => setInspector(null)} />
      ) : null}
    </section>
  );
}
