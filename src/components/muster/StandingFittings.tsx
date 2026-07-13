"use client";

// The Muster Standing Fittings section (GARRISON-UNIFY-V1 D12, slice S5b). The
// non-duty half of the page: one slot card per infrastructure faculty
// (channels/gateway/runtimes/memory/observability/sessions/surfaces/connectors),
// each showing its current fitting(s), a config_schema-driven form (autosaved,
// no Save button), a Swap picker (the D9 library picker scoped to the slot's
// faculty), live health for own-port fittings, and - for the runtimes slot - the
// create-runtime flow (clone a template, configure, test, set primary).
//
// Owns its own data (GET /api/muster/standing) and writes, decoupled from the
// S5a Duties model so the two sections never contend for one payload. Reference
// loss (a swap that leaves another fitting without a provider) is OFFERED for
// removal via a confirm banner - never auto-applied.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./Muster.module.css";

type ConfigValue = string | number | boolean;

interface ConfigSchemaField {
  key: string;
  type: "string" | "integer" | "number" | "boolean" | "select" | "path" | "secret-ref";
  default?: ConfigValue;
  description: string;
  required?: boolean;
  options?: string[];
}

interface StandingFittingView {
  id: string;
  name: string;
  summary: string;
  faculty: string;
  componentShape: string;
  clonedFrom?: string;
  ownPort: boolean;
  providesRuntime: boolean;
  isPrimaryRuntime: boolean;
  configSchema: ConfigSchemaField[];
  config: Record<string, ConfigValue>;
}

interface StandingCandidate {
  id: string;
  name: string;
  summary: string;
  clonedFrom?: string;
}

interface StandingSlot {
  faculty: string;
  facultyName: string;
  role: string;
  cardinality: "single" | "multi";
  fittings: StandingFittingView[];
  candidates: StandingCandidate[];
}

interface RuntimeTemplate {
  id: string;
  name: string;
  summary: string;
  clonable: boolean;
}

interface StandingModel {
  compositionId: string;
  compositionName: string;
  slots: StandingSlot[];
  runtimeTemplates: RuntimeTemplate[];
  primaryRuntime: string;
}

interface OrphanedConsumer {
  fittingId: string;
  faculty: string;
  kind: string;
  name?: string;
  message: string;
}

interface RuntimeCheck {
  label: string;
  ok: boolean;
  detail?: string;
}

interface RuntimeTestResult {
  fittingId: string;
  ok: boolean;
  checks: RuntimeCheck[];
  note: string;
}

// ── small inline glyphs (no emoji, per house rule) ──────────────────────────
function XMark() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

type SwapTarget = { faculty: string; fromId?: string };

export function StandingFittings({ compositionId }: { compositionId: string }) {
  const [model, setModel] = useState<StandingModel | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [health, setHealth] = useState<Record<string, boolean>>({});
  const [orphaned, setOrphaned] = useState<OrphanedConsumer[]>([]);
  const [swap, setSwap] = useState<SwapTarget | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [tests, setTests] = useState<Record<string, RuntimeTestResult>>({});

  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const compositionParam = compositionId ? `?composition=${encodeURIComponent(compositionId)}` : "";

  const refreshHealth = useCallback(() => {
    fetch("/api/fittings/views")
      .then((r) => r.json())
      .then((d: { views?: { fittingId?: unknown; healthy?: unknown }[] }) => {
        if (!d?.views) return;
        const map: Record<string, boolean> = {};
        for (const v of d.views) {
          if (typeof v.fittingId === "string") map[v.fittingId] = Boolean(v.healthy);
        }
        setHealth(map);
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/muster/standing${compositionParam}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setModel(data as StandingModel);
      setStatus("ready");
      setErrorMsg(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, [compositionParam]);

  useEffect(() => {
    void load();
    refreshHealth();
  }, [load, refreshHealth]);

  // POST a mutation and reconcile the returned model. Reloads (discards the
  // optimistic edit) on failure. Returns the raw response for callers that need
  // the extra fields (swap → orphaned, create → newFittingId).
  const persist = useCallback(
    async (path: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
      setSaving(true);
      try {
        const res = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ composition: compositionId, ...body })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        // Swap/create wrap the model; config/primary return it bare.
        const nextModel = (data.model ?? data) as StandingModel;
        if (nextModel && Array.isArray(nextModel.slots)) setModel(nextModel);
        setErrorMsg(null);
        return data as Record<string, unknown>;
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
        await load();
        return null;
      } finally {
        setSaving(false);
      }
    },
    [compositionId, load]
  );

  const commitConfig = useCallback(
    (faculty: string, fittingId: string, field: ConfigSchemaField, value: ConfigValue) => {
      // Optimistic local patch so the input stays responsive while the write flies.
      setModel((m) =>
        m
          ? {
              ...m,
              slots: m.slots.map((slot) =>
                slot.faculty !== faculty
                  ? slot
                  : {
                      ...slot,
                      fittings: slot.fittings.map((f) =>
                        f.id !== fittingId ? f : { ...f, config: { ...f.config, [field.key]: value } }
                      )
                    }
              )
            }
          : m
      );
      const debounced = field.type !== "boolean" && field.type !== "select";
      const doPost = () =>
        void persist("/api/muster/standing/config", { faculty, fittingId, key: field.key, value });
      const timerKey = `${faculty}:${fittingId}:${field.key}`;
      const existing = debounceTimers.current.get(timerKey);
      if (existing) clearTimeout(existing);
      if (debounced) {
        debounceTimers.current.set(timerKey, setTimeout(doPost, 450));
      } else {
        doPost();
      }
    },
    [persist]
  );

  useEffect(() => {
    const timers = debounceTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
    };
  }, []);

  const doSwap = useCallback(
    async (faculty: string, toId: string | undefined, fromId: string | undefined) => {
      setSwap(null);
      const data = await persist("/api/muster/standing/swap", { faculty, toId, fromId });
      if (data && Array.isArray(data.orphaned)) setOrphaned(data.orphaned as OrphanedConsumer[]);
      refreshHealth();
    },
    [persist, refreshHealth]
  );

  const removeOrphan = useCallback(
    async (orphan: OrphanedConsumer) => {
      const data = await persist("/api/muster/standing/swap", { faculty: orphan.faculty, fromId: orphan.fittingId });
      // The removal response carries its own orphaned set (a cascade); replace.
      setOrphaned(data && Array.isArray(data.orphaned) ? (data.orphaned as OrphanedConsumer[]) : []);
    },
    [persist]
  );

  const setPrimary = useCallback(
    (fittingId: string) => void persist("/api/muster/standing/runtime", { action: "set-primary", fittingId }),
    [persist]
  );

  const testRuntime = useCallback(
    async (fittingId: string) => {
      const data = await persist("/api/muster/standing/runtime", { action: "test", fittingId });
      if (data && typeof data.ok === "boolean") setTests((t) => ({ ...t, [fittingId]: data as unknown as RuntimeTestResult }));
    },
    [persist]
  );

  const createRuntime = useCallback(
    async (templateId: string, newId: string | undefined): Promise<boolean> => {
      const data = await persist("/api/muster/standing/runtime", { action: "create", templateId, newId });
      if (data && typeof data.newFittingId === "string") {
        setCreateOpen(false);
        refreshHealth();
        return true;
      }
      return false;
    },
    [persist, refreshHealth]
  );

  const removeFitting = useCallback(
    (faculty: string, fittingId: string) => void doSwap(faculty, undefined, fittingId),
    [doSwap]
  );

  const runtimeSlot = useMemo(() => model?.slots.find((s) => s.faculty === "runtimes") ?? null, [model]);

  if (status === "loading" && !model) {
    return (
      <section className={styles.section} data-testid="standing-loading">
        <div className={styles.sectionHead}>
          <span className={styles.sectionLabel}>Standing Fittings</span>
        </div>
        <div className={styles.standingGrid}>
          <div className={styles.skelRow} />
          <div className={styles.skelRow} />
          <div className={styles.skelRow} />
        </div>
      </section>
    );
  }

  if (status === "error" && !model) {
    return (
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionLabel}>Standing Fittings</span>
        </div>
        <div className={styles.stateBox} data-testid="standing-error">
          <div className={styles.stateTitle}>Could not load standing fittings</div>
          <p className={styles.stateBody}>{errorMsg}</p>
          <button type="button" className={styles.addBtn} style={{ marginTop: 16 }} onClick={() => void load()}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  if (!model) return null;

  const swapSlot = swap ? model.slots.find((s) => s.faculty === swap.faculty) ?? null : null;

  return (
    <section className={styles.section} data-testid="standing-section">
      <div className={styles.sectionHead}>
        <span className={styles.sectionLabel}>
          Standing Fittings <span className={styles.sectionCount}>· {model.slots.length} slots</span>
        </span>
        {saving ? <span className={styles.saving}>saving…</span> : null}
      </div>

      {errorMsg ? (
        <div className={styles.blocking} role="alert" style={{ marginBottom: 12 }}>
          <span className={styles.blockGlyph}>!</span>
          <div>
            <h5>Last change did not save</h5>
            <p>{errorMsg}</p>
          </div>
        </div>
      ) : null}

      {orphaned.length > 0 ? (
        <OrphanBanner orphaned={orphaned} onRemove={removeOrphan} onDismiss={() => setOrphaned([])} />
      ) : null}

      <div className={styles.standingGrid}>
        {model.slots.map((slot) => (
          <SlotCard
            key={slot.faculty}
            slot={slot}
            health={health}
            tests={tests}
            primaryRuntime={model.primaryRuntime}
            onSwap={(fromId) => setSwap({ faculty: slot.faculty, fromId })}
            onRemoveFitting={removeFitting}
            onConfig={commitConfig}
            onSetPrimary={setPrimary}
            onTest={testRuntime}
            onNewRuntime={slot.faculty === "runtimes" ? () => setCreateOpen(true) : undefined}
          />
        ))}
      </div>

      {swap && swapSlot ? (
        <SwapModal slot={swapSlot} fromId={swap.fromId} onPick={doSwap} onClose={() => setSwap(null)} />
      ) : null}

      {createOpen && runtimeSlot ? (
        <CreateRuntimeModal
          templates={model.runtimeTemplates}
          onCreate={createRuntime}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
    </section>
  );
}

// ── orphan banner (reference-loss offer) ─────────────────────────────────────
function OrphanBanner({
  orphaned,
  onRemove,
  onDismiss
}: {
  orphaned: OrphanedConsumer[];
  onRemove: (o: OrphanedConsumer) => void;
  onDismiss: () => void;
}) {
  return (
    <div className={styles.orphanBanner} role="alert" data-testid="standing-orphan-banner">
      <p className={styles.orphanHead}>
        That swap left {orphaned.length} fitting{orphaned.length === 1 ? "" : "s"} without a provider. Remove or keep -
        nothing was removed for you.
      </p>
      {orphaned.map((o) => (
        <div key={`${o.fittingId}-${o.kind}-${o.name ?? ""}`} className={styles.orphanRow}>
          <div className={styles.orphanRowText}>
            <b>{o.fittingId}</b> ({o.faculty}) needs <code>{o.kind}</code>
            {o.name ? <code>:{o.name}</code> : null} - none provided now.
          </div>
          <div className={styles.orphanBtns}>
            <button
              type="button"
              className={`${styles.orphanBtn} ${styles.remove}`}
              onClick={() => onRemove(o)}
              data-testid={`standing-orphan-remove-${o.fittingId}`}
            >
              Remove
            </button>
            <button type="button" className={`${styles.orphanBtn} ${styles.keep}`} onClick={onDismiss}>
              Keep
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── one standing slot card ───────────────────────────────────────────────────
function SlotCard({
  slot,
  health,
  tests,
  primaryRuntime,
  onSwap,
  onRemoveFitting,
  onConfig,
  onSetPrimary,
  onTest,
  onNewRuntime
}: {
  slot: StandingSlot;
  health: Record<string, boolean>;
  tests: Record<string, RuntimeTestResult>;
  primaryRuntime: string;
  onSwap: (fromId?: string) => void;
  onRemoveFitting: (faculty: string, fittingId: string) => void;
  onConfig: (faculty: string, fittingId: string, field: ConfigSchemaField, value: ConfigValue) => void;
  onSetPrimary: (fittingId: string) => void;
  onTest: (fittingId: string) => void;
  onNewRuntime?: () => void;
}) {
  const empty = slot.fittings.length === 0;
  const addLabel = slot.cardinality === "single" ? "Set fitting" : "Add fitting";
  return (
    <div className={styles.slotCard} data-testid={`standing-slot-${slot.faculty}`}>
      <div className={styles.slotHead}>
        <div className={styles.slotHeadTop}>
          <span className={styles.slotName}>{slot.facultyName}</span>
          <span className={styles.slotCardinality}>{slot.cardinality === "single" ? "one" : "many"}</span>
        </div>
        <p className={styles.slotRole}>{slot.role}</p>
      </div>

      {empty ? (
        <div className={styles.slotEmpty} data-testid={`standing-empty-${slot.faculty}`}>
          No fitting stationed.
        </div>
      ) : (
        <div className={styles.slotFittings}>
          {slot.fittings.map((fitting) => (
            <FittingBlock
              key={fitting.id}
              fitting={fitting}
              health={fitting.ownPort ? health[fitting.id] : undefined}
              test={tests[fitting.id]}
              isPrimary={fitting.providesRuntime && fitting.id === primaryRuntime}
              onSwap={() => onSwap(fitting.id)}
              onRemove={slot.cardinality === "multi" ? () => onRemoveFitting(slot.faculty, fitting.id) : undefined}
              onConfig={(field, value) => onConfig(slot.faculty, fitting.id, field, value)}
              onSetPrimary={() => onSetPrimary(fitting.id)}
              onTest={() => onTest(fitting.id)}
            />
          ))}
        </div>
      )}

      <div className={styles.slotFoot}>
        <button
          type="button"
          className={styles.slotFootBtn}
          onClick={() => onSwap(undefined)}
          data-testid={`standing-add-${slot.faculty}`}
        >
          + {addLabel}
        </button>
        {onNewRuntime ? (
          <button
            type="button"
            className={styles.slotFootBtn}
            onClick={onNewRuntime}
            data-testid="standing-new-runtime"
          >
            + New runtime
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ── one fitting block: identity + config form + runtime controls ─────────────
function FittingBlock({
  fitting,
  health,
  test,
  isPrimary,
  onSwap,
  onRemove,
  onConfig,
  onSetPrimary,
  onTest
}: {
  fitting: StandingFittingView;
  health: boolean | undefined;
  test: RuntimeTestResult | undefined;
  isPrimary: boolean;
  onSwap: () => void;
  onRemove?: () => void;
  onConfig: (field: ConfigSchemaField, value: ConfigValue) => void;
  onSetPrimary: () => void;
  onTest: () => void;
}) {
  return (
    <div className={styles.fittingBlock} data-testid={`standing-fitting-${fitting.id}`}>
      <div className={styles.fittingHead}>
        <span className={styles.fittingName}>{fitting.name}</span>
        <span className={styles.shapeTag}>{fitting.componentShape}</span>
        {fitting.clonedFrom ? (
          <span className={styles.cloneTag} title={`Cloned from ${fitting.clonedFrom}`}>
            clone
          </span>
        ) : null}
        {isPrimary ? <span className={styles.primaryTag}>primary</span> : null}
        {fitting.ownPort ? (
          <span
            className={`${styles.healthPip} ${health === true ? styles.up : health === false ? styles.down : ""}`}
            title={health === true ? "Serving on its port" : health === false ? "Not responding" : "Not running"}
            data-testid={`standing-health-${fitting.id}`}
          >
            <span className={styles.healthDot} />
            {health === true ? "live" : health === false ? "down" : "idle"}
          </span>
        ) : null}
      </div>

      {fitting.configSchema.length > 0 ? (
        <div className={styles.configForm}>
          {fitting.configSchema.map((field) => (
            <ConfigField
              key={field.key}
              faculty={fitting.faculty}
              fittingId={fitting.id}
              field={field}
              value={fitting.config[field.key] ?? field.default ?? ""}
              onChange={(value) => onConfig(field, value)}
            />
          ))}
        </div>
      ) : (
        <p className={styles.cfgEmpty}>No configuration for this fitting.</p>
      )}

      {fitting.providesRuntime ? (
        <div className={styles.runtimeControls}>
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={onSetPrimary}
            disabled={isPrimary}
            data-testid={`standing-primary-${fitting.id}`}
          >
            {isPrimary ? "Primary runtime" : "Make primary"}
          </button>
          <button type="button" className={styles.testBtn} onClick={onTest} data-testid={`standing-test-${fitting.id}`}>
            Test connection
          </button>
          {test ? (
            <div className={styles.testResult} data-testid={`standing-test-result-${fitting.id}`}>
              {test.checks.map((c) => (
                <div key={c.label} className={`${styles.checkRow} ${c.ok ? styles.ok : styles.bad}`}>
                  <span className={styles.checkMark}>{c.ok ? "+" : "!"}</span>
                  <span>
                    {c.label}
                    {c.detail ? <span className={styles.checkDetail}> · {c.detail}</span> : null}
                  </span>
                </div>
              ))}
              <p className={styles.testNote}>{test.note}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className={styles.runtimeControls} style={{ borderTop: "none", paddingTop: 6, marginTop: 8 }}>
        <button
          type="button"
          className={styles.testBtn}
          onClick={onSwap}
          data-testid={`standing-swap-${fitting.faculty}-${fitting.id}`}
        >
          Swap
        </button>
        {onRemove ? (
          <button
            type="button"
            className={styles.testBtn}
            onClick={onRemove}
            data-testid={`standing-remove-${fitting.faculty}-${fitting.id}`}
          >
            Remove
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ── config field (config_schema-driven; mirrors Compose ConfigInput) ─────────
function ConfigField({
  faculty,
  fittingId,
  field,
  value,
  onChange
}: {
  faculty: string;
  fittingId: string;
  field: ConfigSchemaField;
  value: ConfigValue;
  onChange: (value: ConfigValue) => void;
}) {
  const testId = `standing-config-${faculty}-${fittingId}-${field.key}`;
  const label = (
    <span className={styles.cfgLabel}>
      {field.key}
      {field.required ? " *" : ""}
    </span>
  );

  if (field.type === "boolean") {
    const on = Boolean(value);
    return (
      <div className={styles.cfgField}>
        {label}
        <label className={styles.cfgCheckRow}>
          <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
          <span className={styles.cfgCheckVal}>{on ? "true" : "false"}</span>
        </label>
        {field.description ? <span className={styles.cfgHint}>{field.description}</span> : null}
      </div>
    );
  }

  if (field.type === "select") {
    return (
      <div className={styles.cfgField}>
        {label}
        <select
          className={styles.cfgControl}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          data-testid={testId}
        >
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        {field.description ? <span className={styles.cfgHint}>{field.description}</span> : null}
      </div>
    );
  }

  const numeric = field.type === "integer" || field.type === "number";
  return (
    <div className={styles.cfgField}>
      {label}
      <input
        className={styles.cfgControl}
        type={numeric ? "number" : "text"}
        value={String(value)}
        onChange={(e) => onChange(numeric ? Number(e.target.value) : e.target.value)}
        data-testid={testId}
      />
      {field.description ? <span className={styles.cfgHint}>{field.description}</span> : null}
    </div>
  );
}

// ── shared modal shell ───────────────────────────────────────────────────────
function Modal({
  title,
  subtitle,
  onClose,
  children,
  testId
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  testId: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.modalHead}>
          <div>
            <div className={styles.modalTitle}>{title}</div>
            {subtitle ? <div className={styles.modalSub}>{subtitle}</div> : null}
          </div>
          <button type="button" className={styles.modalClose} onClick={onClose} aria-label="Close">
            <XMark />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── swap picker modal (the D9 library picker, faculty-scoped) ─────────────────
function SwapModal({
  slot,
  fromId,
  onPick,
  onClose
}: {
  slot: StandingSlot;
  fromId?: string;
  onPick: (faculty: string, toId: string | undefined, fromId: string | undefined) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const currentIds = useMemo(() => new Set(slot.fittings.map((f) => f.id)), [slot.fittings]);
  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q) return slot.candidates;
    return slot.candidates.filter((c) =>
      `${c.name} ${c.summary} ${c.id}`.toLowerCase().includes(q)
    );
  }, [slot.candidates, q]);

  const title = fromId ? `Swap ${fromId}` : `Add to ${slot.facultyName}`;

  return (
    <Modal title={title} subtitle={`${slot.facultyName} · ${slot.candidates.length} available`} onClose={onClose} testId="standing-swap-modal">
      <input
        type="search"
        className={styles.pickerSearch}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search fittings by name or summary…"
        aria-label="Search fittings"
        data-testid="standing-picker-search"
        autoFocus
      />
      {results.length === 0 ? (
        <div className={styles.pickerEmpty}>No fittings match that search.</div>
      ) : (
        <div className={styles.pickerList}>
          {results.map((c) => {
            const isCurrent = currentIds.has(c.id);
            return (
              <button
                key={c.id}
                type="button"
                className={`${styles.pickerItem} ${isCurrent ? styles.current : ""}`}
                onClick={() => onPick(slot.faculty, c.id, fromId)}
                data-testid={`standing-picker-item-${c.id}`}
              >
                <div className={styles.pickerItemTop}>
                  <span className={styles.pickerItemName}>{c.name}</span>
                  {c.clonedFrom ? <span className={styles.cloneTag}>clone</span> : null}
                  {isCurrent ? <span className={styles.primaryTag}>stationed</span> : null}
                </div>
                <span className={styles.pickerItemSummary}>{c.summary}</span>
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

// ── create-runtime modal (clone a runtime template) ──────────────────────────
function CreateRuntimeModal({
  templates,
  onCreate,
  onClose
}: {
  templates: RuntimeTemplate[];
  onCreate: (templateId: string, newId: string | undefined) => Promise<boolean>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [newId, setNewId] = useState("");
  const [busy, setBusy] = useState(false);
  const clonable = templates.filter((t) => t.clonable);

  async function submit() {
    if (!selected || busy) return;
    setBusy(true);
    await onCreate(selected, newId.trim() || undefined);
    setBusy(false);
  }

  return (
    <Modal
      title="New runtime"
      subtitle="Clone a runtime template into an editable local copy, then configure it."
      onClose={onClose}
      testId="standing-create-modal"
    >
      {clonable.length === 0 ? (
        <div className={styles.pickerEmpty}>No clonable runtime templates are available.</div>
      ) : (
        <div className={styles.pickerList}>
          {clonable.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`${styles.pickerItem} ${selected === t.id ? styles.current : ""}`}
              onClick={() => setSelected(t.id)}
              data-testid={`standing-template-${t.id}`}
            >
              <div className={styles.pickerItemTop}>
                <span className={styles.pickerItemName}>{t.name}</span>
              </div>
              <span className={styles.pickerItemSummary}>{t.summary}</span>
            </button>
          ))}
        </div>
      )}

      {selected ? (
        <div className={styles.newIdRow}>
          <span className={styles.cfgLabel}>New id (optional)</span>
          <input
            className={styles.pickerSearch}
            style={{ margin: 0 }}
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            placeholder={`${selected}-copy`}
            aria-label="New runtime id"
            data-testid="standing-create-newid"
          />
        </div>
      ) : null}

      <div className={styles.modalFoot}>
        <button type="button" className={styles.slotFootBtn} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={styles.primaryBtn}
          onClick={() => void submit()}
          disabled={!selected || busy}
          data-testid="standing-create-submit"
        >
          {busy ? "Cloning…" : "Create runtime"}
        </button>
      </div>
    </Modal>
  );
}
