// Orchestrator Composer (GARRISON-UNIFY-V1 S3, brief D10/D11/D12).
//
// One page, four surfaces, Garrison's slots-and-pieces metaphor - NOT
// forms-and-dropdowns:
//   1. TARGETS TRAY   - every config target is a draggable card with an effort dial.
//   2. MATRIX BOARD   - 20 task-types × 3 tiers; drop a target to assign; resolved
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
  MeasuringStrategy,
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
  authMode?: string;
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
// Severity vocabulary for the ux-qa threshold (blocker strictest → note loosest).
const SEVERITIES = ["blocker", "major", "minor", "note"];

// The runtime label shown on each target card (the engine the turn runs on).
function runtimeLabel(t: AnyTarget | null | undefined): string {
  if (!t) return "unset";
  if (t.type === "workflow") return "workflow";
  if (t.provider === "ollama-local") return `${t.runtime || "claude-code"} · ollama`;
  return t.runtime || t.type || "target";
}

// The auth mode a target uses (subscription / API key / local). An explicit
// target.authMode wins; else derive sensibly per runtime/provider so hand-added
// targets still display a mode (cc-* / anthropic → subscription, ollama → local,
// codex/gemini/third-party → API key).
function authModeFor(t: AnyTarget | null | undefined): string {
  if (!t) return "-";
  if (t.authMode) return t.authMode;
  if (t.provider === "ollama-local" || t.provider === "ollama") return "local";
  if (t.runtime === "codex" || t.runtime === "gemini") return "api-key";
  if (t.runtime === "agent-sdk" && t.provider && t.provider !== "anthropic") return "api-key";
  return "subscription";
}

// Compact display label for an auth mode (API key reads better than the id).
function authModeLabel(mode: string): string {
  if (mode === "api-key") return "API key";
  return mode;
}

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
  const [warnings, setWarnings] = useState<string[]>([]);
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
    // A 200 can still carry warnings (e.g. primaryRuntime accepted WITHOUT
    // installed-fitting validation because the composition is unknown) —
    // degraded acceptance is surfaced, never dropped.
    setWarnings(Array.isArray(j.warnings) ? j.warnings : []);
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

  return {
    config,
    saveState,
    errors,
    warnings,
    commit,
    reload: load,
    dismissErrors: () => setSaveState("idle"),
    dismissWarnings: () => setWarnings([])
  };
}

// ── Installed runtime fittings (GARRISON-RUNTIMES-V1 P3/D3/D4) ───────────────
// Feeds the primary-runtime picker and the per-mechanism provider editor from
// the composition on disk (own-port server /runtime-fittings) — no gateway.
interface RuntimeFittingInfo {
  id: string;
  engine: string;
  installed: boolean;
  providerMechanism: {
    type?: string;
    base_url_env?: string;
    auth_env?: string;
    model_arg?: string;
    model_env?: string;
    config_file?: string;
    config_format?: string;
    config_key?: string;
    model_key?: string;
  } | null;
  quartersDescriptor: unknown;
  warning?: string;
}
interface RuntimeFittingsState {
  available: boolean;
  defaultPrimary?: string;
  warning?: string;
  runtimes: RuntimeFittingInfo[];
}

const DEFAULT_PRIMARY_ID = "claude-code-runtime";

function useRuntimeFittings(): RuntimeFittingsState | null {
  const [state, setState] = useState<RuntimeFittingsState | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/runtime-fittings")
      .then((r) => r.json())
      .then((j) => alive && setState(j))
      .catch(() =>
        alive && setState({ available: false, warning: "/runtime-fittings unreachable — installed runtimes unknown", runtimes: [] })
      );
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

// The mechanism (if any) declared by the composed fitting providing this
// target's engine — decides whether provider overrides are editable (D3).
function mechanismForRuntime(rf: RuntimeFittingsState | null, engine: string | undefined) {
  if (!rf?.available || !engine) return null;
  const fit = rf.runtimes.find((r) => r.installed && r.engine === engine);
  return fit?.providerMechanism ?? null;
}

function PrimaryRuntimePicker({
  config,
  rf,
  commit
}: {
  config: Cfg;
  rf: RuntimeFittingsState | null;
  commit: (p: Producer) => void;
}) {
  const current = (config as { primaryRuntime?: string }).primaryRuntime?.trim() || DEFAULT_PRIMARY_ID;
  const composed = rf?.available ? rf.runtimes : [];
  const hasDefault = composed.some((r) => r.id === DEFAULT_PRIMARY_ID);
  const set = (id: string) =>
    commit((draft) => ({ ...(draft as Cfg), primaryRuntime: id } as Cfg));
  return (
    <div className="primary-picker" title="Which composed runtime hosts the Operative's orchestrator loop. Writes the policy file only — no operative needs to run.">
      <label htmlFor="primary-runtime">Primary</label>
      <select id="primary-runtime" value={current} onChange={(e) => set(e.target.value)}>
        {!hasDefault ? (
          <option value={DEFAULT_PRIMARY_ID}>Claude Code (default)</option>
        ) : null}
        {composed.map((r) => {
          // The DEFAULT id is ALWAYS selectable: the claude-code engine is
          // synthesized even when its fitting is not installed, and disabling
          // it would leave no way back to the default from a non-claude pick.
          const isDefault = r.id === DEFAULT_PRIMARY_ID;
          return (
            <option key={r.id} value={r.id} disabled={!r.installed && !isDefault} title={r.warning || r.engine}>
              {r.id}
              {!r.installed ? (isDefault ? " (engine built-in)" : " (not installed)") : ""}
            </option>
          );
        })}
      </select>
      {rf && !rf.available ? (
        <span className="primary-warn" title={rf.warning}>
          !
        </span>
      ) : null}
    </div>
  );
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

// D3: the provider control renders ONLY when the target's engine is provided
// by a composed fitting that declares a provider mechanism — a runtime with no
// declared mechanism is still a target, just without provider overrides.
function ProviderSelect({
  target,
  config,
  rf,
  commit
}: {
  target: AnyTarget;
  config: Cfg;
  rf: RuntimeFittingsState | null;
  commit: (p: Producer) => void;
}) {
  const mech = mechanismForRuntime(rf, target.runtime);
  if (!mech) return null;
  const providers = ((config as { providers?: Array<{ id: string }> }).providers || []).map((p) => p.id);
  if (!providers.length) return null;
  const applyHint =
    mech.type === "config-file"
      ? `applies via ${mech.config_file}${mech.config_key ? ` [${mech.config_key}]` : ""}`
      : `applies via ${[mech.base_url_env, mech.auth_env].filter(Boolean).join(" + ")}`;
  const set = (p: string) =>
    commit((draft) => {
      const t = (draft.targets as AnyTarget[]).find((x) => x.id === target.id);
      if (t) {
        t.provider = p;
        t.authMode = authModeFor(t);
      }
      return draft;
    });
  return (
    <select
      className="tcard-provider"
      title={`provider — ${applyHint}`}
      value={target.provider || "anthropic-plan"}
      onPointerDown={(ev) => ev.stopPropagation()}
      onChange={(e) => set(e.target.value)}
    >
      {providers.map((p) => (
        <option key={p} value={p}>
          {p}
        </option>
      ))}
    </select>
  );
}

function TargetCard({
  target,
  config,
  rf,
  commit,
  armed,
  onArm
}: {
  target: AnyTarget;
  config: Cfg;
  rf: RuntimeFittingsState | null;
  commit: (p: Producer) => void;
  armed?: boolean;
  onArm?: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `target:${target.id}` });
  const g = glyphFor(target);
  return (
    <div ref={setNodeRef} className={`tcard${isDragging ? " dragging" : ""}${armed ? " armed" : ""}`}>
      <div
        className="tcard-grab"
        {...attributes}
        {...listeners}
        // Click-to-assign: a plain click (PointerSensor needs 6px of travel to
        // start a drag, so clicks stay free) ARMS this target; clicking a matrix
        // cell / row header then assigns it. Deterministic alternative to drag —
        // works with scrolling, touch screens, and automation alike.
        onClick={() => onArm?.(target.id)}
        title={armed ? "armed — click a matrix cell or row to assign; click again to disarm" : "drag onto the matrix, or click to arm for click-assign"}
      >
        <span className={`glyph ${g.cls}`} title={g.title}>
          {g.mark}
        </span>
        <span className="tcard-main">
          <span className="tcard-model">{target.model || target.runtime || target.id}</span>
          <span className="tcard-id">{target.id}{target.pinned ? " · pinned" : ""}</span>
          <span className="tcard-meta">
            <span className="tcard-runtime" title="runtime">{runtimeLabel(target)}</span>
            <span className="tcard-auth" title="auth mode">{authModeLabel(authModeFor(target))}</span>
          </span>
        </span>
      </div>
      <ProviderSelect target={target} config={config} rf={rf} commit={commit} />
      <EffortDial target={target} commit={commit} />
    </div>
  );
}

function AddTargetCard({ config, rf, commit }: { config: Cfg; rf: RuntimeFittingsState | null; commit: (p: Producer) => void }) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  // Engines come from the COMPOSED runtime fittings when known (plus the
  // claude-code/ollama staples), so a newly fitted engine is addable without
  // touching this file; the historical constant is only the offline fallback.
  const runtimeOptions = rf?.available
    ? Array.from(new Set(["claude-code", "ollama", ...rf.runtimes.filter((r) => r.installed).map((r) => r.engine)]))
    : RUNTIME_OPTIONS;
  const [runtime, setRuntime] = useState(runtimeOptions[0]);
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
    built.authMode = authModeFor(built);
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
        {runtimeOptions.map((r) => (
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

function TargetsTray({ config, rf, commit, armed, onArm }: { config: Cfg; rf: RuntimeFittingsState | null; commit: (p: Producer) => void; armed?: string | null; onArm?: (id: string) => void }) {
  return (
    <section className="surface">
      <h2 className="surface-h">Targets</h2>
      <p className="surface-hint">Drag a card onto a matrix cell, row, or column to assign it — or click a card to arm it, then click cells/rows. Tap an effort segment to retune it; pick a provider where the runtime declares an override mechanism.</p>
      <div className="tray">
        {((config.targets || []) as AnyTarget[]).map((t) => (
          <TargetCard key={t.id} target={t} config={config} rf={rf} commit={commit} armed={armed === t.id} onArm={onArm} />
        ))}
        <AddTargetCard config={config} rf={rf} commit={commit} />
      </div>
    </section>
  );
}

// ── 2. MATRIX BOARD ───────────────────────────────────────────────────────────
function MatrixCell({ config, tt, tier, commit, armed }: { config: Cfg; tt: string; tier: string; commit: (p: Producer) => void; armed?: string | null }) {
  const { setNodeRef, isOver } = useDroppable({ id: `cell:${tt}:${tier}` });
  const r = resolveRoute(config, config.activeProfile, { taskType: tt, tier });
  const explicit = r.via === "cell";
  const clear = () =>
    commit((draft) => {
      const rows = draft.profiles[config.activeProfile].matrix.rows || {};
      if (rows[tt] && rows[tt].cells) delete rows[tt].cells[tier as keyof typeof rows[typeof tt]["cells"]];
      return draft;
    });
  const assign = () =>
    commit((draft) => {
      const rows = (draft.profiles[config.activeProfile].matrix.rows = draft.profiles[config.activeProfile].matrix.rows || {});
      const row = (rows[tt] = rows[tt] || { cells: {} });
      row.cells = row.cells || {};
      (row.cells as Record<string, string>)[tier] = armed as string;
      return draft;
    });
  return (
    <td
      ref={setNodeRef}
      className={`cell${isOver ? " over" : ""}${explicit ? " explicit" : " inherited"}`}
      onClick={armed ? assign : explicit ? clear : undefined}
      title={armed ? `click to assign ${armed}` : explicit ? "tap to clear (revert to inherited)" : `inherited · ${r.ruleId}`}
    >
      <Token config={config} targetId={r.targetId} faded={!explicit} rule={r.ruleId} />
    </td>
  );
}

function RowHeader({ config, tt, commit, armed }: { config: Cfg; tt: string; commit: (p: Producer) => void; armed?: string | null }) {
  const { setNodeRef, isOver } = useDroppable({ id: `row:${tt}` });
  const row = (config.profiles[config.activeProfile].matrix.rows || {})[tt];
  const def = row?.default || null;
  const clear = () =>
    commit((draft) => {
      const r = (draft.profiles[config.activeProfile].matrix.rows || {})[tt];
      if (r) delete r.default;
      return draft;
    });
  const assign = () =>
    commit((draft) => {
      const rows = (draft.profiles[config.activeProfile].matrix.rows = draft.profiles[config.activeProfile].matrix.rows || {});
      const r = (rows[tt] = rows[tt] || { cells: {} });
      r.default = armed as string;
      return draft;
    });
  return (
    <th
      ref={setNodeRef}
      className={`rowhead${isOver ? " over" : ""}`}
      scope="row"
      onClick={armed ? assign : undefined}
      title={armed ? `click to set ${armed} as the ${tt} row default` : undefined}
    >
      <span className="rh-name">{tt}</span>
      {def ? (
        <span className="rh-def" onClick={armed ? undefined : clear} title={armed ? undefined : `row default ${def} - tap to clear`}>
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

function MatrixBoard({ config, commit, armed }: { config: Cfg; commit: (p: Producer) => void; armed?: string | null }) {
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
                <RowHeader config={config} tt={tt} commit={commit} armed={armed} />
                {tiers.map((tier) => (
                  <MatrixCell key={tier} config={config} tt={tt} tier={tier} commit={commit} armed={armed} />
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
type GateResolution = {
  securityReview?: { included?: boolean; byPlan?: boolean; byProject?: boolean; project?: string | null; reason?: string };
  uxQa?: { included?: boolean; severityThreshold?: string; reason?: string };
};
type TryItResult = {
  classification?: { taskType?: string; tier?: string; execution?: string };
  workKind?: string | null;
  project?: string | null;
  rail?: Rail | null;
  gates?: GateResolution | null;
  error?: string;
};
function TryItStrip({ config }: { config: Cfg }) {
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
      const r = await fetch("/simulate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tryIt: true, prompt, workKind, project: project || null })
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
  const gates = result?.gates || null;
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
            {result.project ? <span className="pill">project: {result.project}</span> : null}
            {exec ? <span className={`pill exec ${exec}`}>{exec}</span> : null}
          </div>
          {gates ? (
            <div className="tryit-gates">
              <div className={`gate-row${gates.securityReview?.included ? " on" : " off"}`}>
                <span className="gate-name">security-review</span>
                <span className={`gate-flag${gates.securityReview?.included ? " on" : " off"}`}>
                  {gates.securityReview?.included ? "included" : "not included"}
                </span>
                <span className="gate-why">{gates.securityReview?.reason}</span>
              </div>
              <div className={`gate-row${gates.uxQa?.included ? " on" : " off"}`}>
                <span className="gate-name">ux-qa</span>
                <span className={`gate-flag${gates.uxQa?.included ? " on" : " off"}`}>
                  {gates.uxQa?.included ? "included" : "not included"}
                </span>
                <span className="gate-why">{gates.uxQa?.reason}</span>
              </div>
            </div>
          ) : null}
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

// ── D38 ghost edits (Improver proposals) ──────────────────────────────────────
type Ghost = { id: string; claim?: string; diff?: string; decision?: unknown; status: string; at?: string };
function GhostEdits({ onApplied }: { onApplied: () => void }) {
  const [proposals, setProposals] = useState<Ghost[] | null>(null);
  const [available, setAvailable] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/ghost-edits");
      const j = await r.json();
      setAvailable(!!j.available);
      setProposals(Array.isArray(j.proposals) ? j.proposals : []);
    } catch {
      setAvailable(false);
      setProposals([]);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // Absent Improver, no matching proposals, or none awaiting a decision → skip silently.
  if (!available || !proposals) return null;
  const pending = proposals.filter((p) => p.status === "pending");
  if (!pending.length) return null;

  const act = async (id: string, action: "apply" | "reject") => {
    setBusyId(id);
    setErr(null);
    try {
      const r = await fetch(`/ghost-edits/${encodeURIComponent(id)}/${action}`, { method: "POST" });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        setErr(b.message || b.error || `${action} failed`);
      } else if (action === "apply") {
        onApplied(); // the Improver mutated the policy — reload the composer draft
      }
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setBusyId(null);
      load();
    }
  };

  const renderDecision = (d: unknown) => (d == null ? "" : typeof d === "string" ? d : JSON.stringify(d));

  return (
    <div className="ghosts" role="region" aria-label="improver proposals">
      <div className="ghosts-head">
        <span className="ghosts-title">Improver proposals</span>
        <span className="ghosts-sub">
          {pending.length} policy edit{pending.length > 1 ? "s" : ""} proposed - review before applying (nothing is auto-applied)
        </span>
      </div>
      {err ? <div className="ghosts-err">{err}</div> : null}
      {pending.map((p) => (
        <div key={p.id} className="ghost">
          <div className="ghost-body">
            {p.claim ? <div className="ghost-claim">{p.claim}</div> : null}
            {p.diff ? <div className="ghost-diff">{p.diff}</div> : null}
            {renderDecision(p.decision) ? <div className="ghost-decision">decision: {renderDecision(p.decision)}</div> : null}
          </div>
          <div className="ghost-actions">
            <button type="button" className="primary" disabled={busyId === p.id} onClick={() => act(p.id, "apply")}>
              {busyId === p.id ? "..." : "Accept"}
            </button>
            <button type="button" disabled={busyId === p.id} onClick={() => act(p.id, "reject")}>
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── 5. COORDINATION (GARRISON-FLOW-V2 S6, D3/D6) ──────────────────────────────
// Same-branch multi-run coordination controls. Editing ANY control writes the
// `coordination` section into the config, which recompiles policy.json — the
// engine treats a present section as "coordination on" (an absent section, e.g.
// a legacy policy, never coordinates). fences + leaseTtlMinutes pass through
// verbatim (not surfaced here); we only touch the four surfaced keys.
function coordView(config: Cfg) {
  const c = config.coordination || {};
  return {
    enabled: c.enabled !== false,
    heavyFiles: c.thresholds?.heavyFiles ?? 3,
    heavyRatio: c.thresholds?.heavyRatio ?? 0.5,
    leases: Array.isArray(c.exclusiveLeases) ? c.exclusiveLeases : [],
    serialize: c.serializeWhenUnavailable !== false
  };
}
function ensureCoord(draft: Cfg) {
  const c = (draft.coordination = draft.coordination || {});
  c.thresholds = c.thresholds || {};
  if (!Array.isArray(c.exclusiveLeases)) c.exclusiveLeases = [];
  return c;
}

// A two-segment on/off toggle matching the profile/effort seg styling.
function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <span className="toggle" role="group" aria-label={label || "toggle"}>
      <button type="button" className={`seg${on ? " on" : ""}`} onClick={() => onChange(true)}>
        on
      </button>
      <button type="button" className={`seg${!on ? " on" : ""}`} onClick={() => onChange(false)}>
        off
      </button>
    </span>
  );
}

function CoordinationSurface({ config, commit }: { config: Cfg; commit: (p: Producer) => void }) {
  const v = coordView(config);
  const [newLease, setNewLease] = useState("");
  const setEnabled = (on: boolean) => commit((d) => ((ensureCoord(d).enabled = on), d));
  const setSerialize = (on: boolean) => commit((d) => ((ensureCoord(d).serializeWhenUnavailable = on), d));
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
    <section className="surface">
      <h2 className="surface-h">Coordination</h2>
      <p className="surface-hint">
        How concurrent autonomous runs on the same project + branch avoid stepping on each other. Overlap is scored from each
        run&rsquo;s predicted touch-set; heavy overlap serializes, medium waits for the earlier run&rsquo;s stability point.
      </p>
      <div className="ctl-grid">
        <div className="ctl-row">
          <span className="ctl-label">Enabled</span>
          <Toggle on={v.enabled} onChange={setEnabled} label="coordination enabled" />
          <span className="ctl-note">off = runs never coordinate (each proceeds independently)</span>
        </div>
        <div className="ctl-row">
          <span className="ctl-label">Heavy: shared files</span>
          <input
            className="ctl-num"
            type="number"
            min={1}
            step={1}
            value={v.heavyFiles}
            onChange={(e) => e.target.value !== "" && setHeavyFiles(Number(e.target.value))}
          />
          <span className="ctl-note">this many shared exact files (or more) grades the overlap heavy → serialize</span>
        </div>
        <div className="ctl-row">
          <span className="ctl-label">Heavy: shared ratio</span>
          <input
            className="ctl-num"
            type="number"
            min={0.01}
            max={1}
            step={0.05}
            value={v.heavyRatio}
            onChange={(e) => e.target.value !== "" && setHeavyRatio(Number(e.target.value))}
          />
          <span className="ctl-note">shared files ÷ smaller touch-set at or above this also grades heavy</span>
        </div>
        <div className="ctl-row">
          <span className="ctl-label">Serialize when unavailable</span>
          <Toggle on={v.serialize} onChange={setSerialize} label="serialize when unavailable" />
          <span className="ctl-note">if the coordination substrate is down, allow only one live card per project</span>
        </div>
      </div>
      <div className="lease-block">
        <div className="ctl-label">Exclusive-lease paths</div>
        <p className="ctl-note">
          A run touching any of these takes an exclusive lease first, so two runs never rewrite it at once (lockfiles are the
          classic case). Repo-relative paths.
        </p>
        <div className="lease-list">
          {v.leases.length ? (
            v.leases.map((p) => (
              <span key={p} className="lease-item">
                <span className="lease-path">{p}</span>
                <button type="button" className="lease-x" aria-label={`remove ${p}`} onClick={() => removeLease(p)}>
                  <IconClose />
                </button>
              </span>
            ))
          ) : (
            <span className="muted">none</span>
          )}
        </div>
        <div className="lease-add">
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

// ── 6. SECURITY (per-project, GARRISON-FLOW-V2 S6, D13) ───────────────────────
// Per-project security_sensitive flag. When set, the opt-in security-review
// phase runs for that project's work (the doorway/skill adds it) even though no
// default plan carries it — the Try-it strip resolves this live.
function SecuritySurface({ config, commit }: { config: Cfg; commit: (p: Producer) => void }) {
  const projects = config.projects || {};
  const names = Object.keys(projects).sort();
  const [newProj, setNewProj] = useState("");
  const setFlag = (name: string, on: boolean) =>
    commit((d) => {
      d.projects = d.projects || {};
      const p = (d.projects[name] = d.projects[name] || {});
      p.security_sensitive = on;
      return d;
    });
  const addProject = () => {
    const t = newProj.trim();
    if (!t) return;
    commit((d) => {
      d.projects = d.projects || {};
      if (!d.projects[t]) d.projects[t] = { security_sensitive: false };
      return d;
    });
    setNewProj("");
  };

  return (
    <section className="surface">
      <h2 className="surface-h">Security-sensitive projects</h2>
      <p className="surface-hint">
        Mark a project security-sensitive to add the opt-in security-review phase to its runs (boundary rubric + cross-model
        checks). No default work kind includes security-review otherwise.
      </p>
      <div className="proj-list">
        {names.length ? (
          names.map((name) => (
            <div key={name} className="proj-row">
              <span className="proj-name">{name}</span>
              <Toggle on={!!projects[name]?.security_sensitive} onChange={(on) => setFlag(name, on)} label={`${name} security-sensitive`} />
            </div>
          ))
        ) : (
          <div className="muted">no projects configured yet</div>
        )}
      </div>
      <div className="lease-add">
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

// ── 7. UX-QA threshold (GARRISON-FLOW-V2 S6, D14) ─────────────────────────────
function QaSurface({ config, commit }: { config: Cfg; commit: (p: Producer) => void }) {
  const sev = config.uxQa?.severityThreshold || "major";
  const setSev = (v: string) =>
    commit((d) => {
      d.uxQa = d.uxQa || {};
      d.uxQa.severityThreshold = v as NonNullable<Cfg["uxQa"]>["severityThreshold"];
      return d;
    });
  return (
    <section className="surface">
      <h2 className="surface-h">UX-QA threshold</h2>
      <p className="surface-hint">
        The ux-qa phase records findings by severity. At or above this level a finding loops the slice back to implement; below,
        it is recorded as a note.
      </p>
      <div className="sev-dial" role="group" aria-label="ux-qa severity threshold">
        {SEVERITIES.map((s) => (
          <button key={s} type="button" className={`seg${sev === s ? " on" : ""}`} onClick={() => setSev(s)}>
            {s}
          </button>
        ))}
      </div>
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
  const { config, saveState, errors, warnings, commit, reload, dismissErrors, dismissWarnings } = usePolicyDraft();
  const runtimeFittings = useRuntimeFittings();
  const [inspector, setInspector] = useState<{ kind: string; phase: string } | null>(null);
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  // Click-to-assign: the armed target id (click a tray card to arm, click a
  // matrix cell / row header to assign, click the card again to disarm).
  const [armedTarget, setArmedTarget] = useState<string | null>(null);
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
        <PrimaryRuntimePicker config={config} rf={runtimeFittings} commit={commit} />
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
      {warnings.length ? (
        <div className="banner warn">
          <span>Saved with warnings: {warnings.join("; ")}</span>
          <button type="button" onClick={dismissWarnings}>
            Dismiss
          </button>
        </div>
      ) : null}

      <GhostEdits onApplied={reload} />

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        // Droppable rects are measured once at drag start by default, so a drop
        // target that was OUTSIDE the viewport when the drag began (a matrix row
        // below the fold — the page scrolls mid-drag) could never register a
        // drop. Always re-measure so drag-to-scrolled-row works for real users.
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      >
        <main className="board">
          <TargetsTray config={config} rf={runtimeFittings} commit={commit} armed={armedTarget} onArm={(id) => setArmedTarget((cur) => (cur === id ? null : id))} />
          <MatrixBoard config={config} commit={commit} armed={armedTarget} />
          <RailsSurface config={config} commit={commit} onInspect={(kind, phase) => setInspector({ kind, phase })} />
          <CoordinationSurface config={config} commit={commit} />
          <SecuritySurface config={config} commit={commit} />
          <QaSurface config={config} commit={commit} />
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
