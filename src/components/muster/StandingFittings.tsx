"use client";

// The Muster Standing Fittings section (GARRISON-UNIFY-V1 D12, slice S5b). The
// non-duty half of the page: one slot card per infrastructure faculty
// (channels/gateway/memory/observability/sessions/surfaces/connectors), each
// showing its current fitting(s), a config_schema-driven form (autosaved,
// no Save button), a Swap picker (the D9 library picker scoped to the slot's
// faculty), and live health for own-port fittings. The runtimes slot is NOT
// rendered here: runtimes are first-class on the Muster Runtimes tab
// (RuntimesPanel below - featured primary card, create/swap/test flows).
//
// Owns its own data (GET /api/muster/standing) and writes, decoupled from the
// S5a Duties model so the two sections never contend for one payload. Reference
// loss (a swap that leaves another fitting without a provider) is OFFERED for
// removal via a confirm banner - never auto-applied.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { useAppShell } from "@/components/chrome/AppShell";
import { AccountField, GenericLoginPanel } from "@/components/accounts/AccountField";
import { runtimeAccountContract } from "@/components/accounts/shared";
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
  category: string;
  dutyFitting?: boolean;
  componentShape: string;
  clonedFrom?: string;
  ownPort: boolean;
  providesRuntime: boolean;
  isPrimaryRuntime: boolean;
  configSchema: ConfigSchemaField[];
  config: Record<string, ConfigValue>;
  login?: { command: string; env_var?: string; storage_hint?: string };
}

interface StandingCandidate {
  id: string;
  name: string;
  summary: string;
  category: string;
  clonedFrom?: string;
}

// The human browsing groups (presentation only; the write path stays keyed on
// the fitting's faculty). Order is a reading order, not an alphabet.
const CATEGORY_ORDER = ["Core", "Interfaces", "Building", "Knowledge", "Connections", "Operations"] as const;
const CATEGORY_BLURBS: Record<string, string> = {
  Core: "The essentials the composition stands on - gateway, memory, the plumbing everything else uses.",
  Interfaces: "How you reach it - chat surfaces, voice, screens, and the dev environment.",
  Building: "How it builds and checks software - implementation aids, QA, design, code intelligence.",
  Knowledge: "What it knows and how it learns - documentation, research, skills.",
  Connections: "Outside services it can act on, with credentials sealed in the Vault.",
  Operations: "What keeps it healthy - schedulers, monitors, backups, self-improvement.",
};

/** One stationed fitting with the slot facts its actions need. */
interface StationedItem {
  fitting: StandingFittingView;
  faculty: string;
}

/** One addable library candidate, remembering which slot Add writes into. */
interface AddableItem {
  candidate: StandingCandidate;
  faculty: string;
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
function Caret({ open }: { open: boolean }) {
  return (
    <svg
      className={clsx(styles.caret, open && styles.open)}
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path d="M4 2.5L8 6l-4 3.5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type SwapTarget = { faculty: string; fromId?: string };

export function StandingFittings({ compositionId }: { compositionId: string }) {
  // The shell owns the Fitting file editor (Monaco modal + tree) and the library
  // index it needs; the Edit-files action on each fitting block opens it.
  const { library, openFittingEditor } = useAppShell();
  const [model, setModel] = useState<StandingModel | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [health, setHealth] = useState<Record<string, boolean>>({});
  const [orphaned, setOrphaned] = useState<OrphanedConsumer[]>([]);
  const [swap, setSwap] = useState<SwapTarget | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [search, setSearch] = useState("");

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

  const removeFitting = useCallback(
    (faculty: string, fittingId: string) => void doSwap(faculty, undefined, fittingId),
    [doSwap]
  );

  // Open the shell's Monaco file editor on a fitting. Only local fittings (a
  // localPath in the library) have files on disk to edit.
  const editFitting = useCallback(
    (fittingId: string) => {
      const entry = library.find((e) => e.id === fittingId);
      if (entry) openFittingEditor(entry);
    },
    [library, openFittingEditor]
  );
  const isEditable = useCallback(
    (fittingId: string) => Boolean(library.find((e) => e.id === fittingId)?.localPath),
    [library]
  );

  // Runtimes have their own Muster tab (RuntimesPanel); this tab covers the rest.
  // The faculty slots flatten into ONE list of stationed fittings, grouped for
  // presentation by CATEGORY - faculty is an internal contract, not a browsing
  // axis a human should have to learn.
  const stationed = useMemo<StationedItem[]>(() => {
    if (!model) return [];
    return model.slots
      .filter((slot) => slot.faculty !== "runtimes")
      .flatMap((slot) => slot.fittings.map((fitting) => ({ fitting, faculty: slot.faculty })));
  }, [model]);
  const stationedIds = useMemo(
    () => new Set((model?.slots ?? []).flatMap((slot) => slot.fittings.map((f) => f.id))),
    [model]
  );
  // Everything in the library that could be ADDED: every slot's candidates,
  // minus what is stationed anywhere, deduped (a fitting is one row even if
  // two slots could take it - the first slot wins as the write target).
  const addable = useMemo<AddableItem[]>(() => {
    if (!model) return [];
    const seen = new Set<string>();
    const out: AddableItem[] = [];
    for (const slot of model.slots) {
      if (slot.faculty === "runtimes") continue;
      for (const candidate of slot.candidates) {
        if (stationedIds.has(candidate.id) || seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        out.push({ candidate, faculty: slot.faculty });
      }
    }
    return out.sort((a, b) => a.candidate.name.localeCompare(b.candidate.name));
  }, [model, stationedIds]);

  const query = search.trim().toLowerCase();
  const visibleStationed = useMemo(() => {
    if (!query) return stationed;
    return stationed.filter(({ fitting }) =>
      `${fitting.id} ${fitting.name} ${fitting.summary} ${fitting.category} ${fitting.faculty} ${fitting.componentShape}`
        .toLowerCase()
        .includes(query)
    );
  }, [stationed, query]);
  const matchingAddable = useMemo(() => {
    if (!query) return [];
    return addable.filter(({ candidate }) =>
      `${candidate.id} ${candidate.name} ${candidate.summary} ${candidate.category}`.toLowerCase().includes(query)
    );
  }, [addable, query]);
  // Category sections, in reading order; anything with an unknown category
  // (a manifest written after this build) lands in a trailing group.
  const sections = useMemo(() => {
    const byCategory = new Map<string, StationedItem[]>();
    for (const item of visibleStationed) {
      const key = item.fitting.category || "Operations";
      byCategory.set(key, [...(byCategory.get(key) ?? []), item]);
    }
    const known = CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((c) => ({
      category: c as string,
      items: (byCategory.get(c) ?? []).sort((a, b) => a.fitting.name.localeCompare(b.fitting.name))
    }));
    const unknown = [...byCategory.keys()]
      .filter((c) => !(CATEGORY_ORDER as readonly string[]).includes(c))
      .sort()
      .map((c) => ({ category: c, items: byCategory.get(c) ?? [] }));
    return [...known, ...unknown];
  }, [visibleStationed]);

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
          Fittings <span className={styles.sectionCount}>· {stationed.length} stationed</span>
        </span>
        {saving ? <span className={styles.saving}>saving…</span> : null}
        <button
          type="button"
          className={styles.addBtn}
          style={{ marginLeft: "auto" }}
          onClick={() => setAddOpen(true)}
          data-testid="standing-add-open"
        >
          + Add fitting
        </button>
      </div>

      <div className={styles.standingSearch}>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search fittings - stationed and available…"
          aria-label="Search fittings"
        />
        {search ? (
          <button type="button" onClick={() => setSearch("")}>
            Clear
          </button>
        ) : null}
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

      {sections.length > 0 ? (
        sections.map(({ category, items }) => (
          <CategorySection
            key={category}
            category={category}
            items={items}
            health={health}
            onSwap={(faculty, fromId) => setSwap({ faculty, fromId })}
            onRemoveFitting={removeFitting}
            onConfig={commitConfig}
            onEdit={editFitting}
            isEditable={isEditable}
          />
        ))
      ) : query ? null : (
        <div className={styles.stateBox}>
          <div className={styles.stateTitle}>Nothing stationed yet.</div>
          <p className={styles.stateBody}>Add a fitting to give this composition its first capability.</p>
        </div>
      )}

      {query && matchingAddable.length > 0 ? (
        <div style={{ marginTop: sections.length > 0 ? 18 : 0 }} data-testid="standing-addable-results">
          <div className={styles.sectionHead}>
            <span className={styles.sectionLabel}>
              Available to add <span className={styles.sectionCount}>· {matchingAddable.length}</span>
            </span>
          </div>
          <div className={styles.standingGrid}>
            {matchingAddable.map(({ candidate, faculty }) => (
              <AddableCard
                key={candidate.id}
                candidate={candidate}
                onAdd={() => void doSwap(faculty, candidate.id, undefined)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {query && sections.length === 0 && matchingAddable.length === 0 ? (
        <div className={styles.stateBox} data-testid="standing-search-empty">
          <div className={styles.stateTitle}>No fittings match that search.</div>
          <p className={styles.stateBody}>Try a fitting&apos;s name or a word from what it does.</p>
        </div>
      ) : null}

      {swap && swapSlot ? (
        <SwapModal slot={swapSlot} fromId={swap.fromId} onPick={doSwap} onClose={() => setSwap(null)} />
      ) : null}

      {addOpen ? (
        <AddFittingModal
          addable={addable}
          onPick={(faculty, toId) => {
            setAddOpen(false);
            void doSwap(faculty, toId, undefined);
          }}
          onClose={() => setAddOpen(false)}
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

// ── one category section: human group header + a grid of fitting cards ──────
function CategorySection({
  category,
  items,
  health,
  onSwap,
  onRemoveFitting,
  onConfig,
  onEdit,
  isEditable
}: {
  category: string;
  items: StationedItem[];
  health: Record<string, boolean>;
  onSwap: (faculty: string, fromId?: string) => void;
  onRemoveFitting: (faculty: string, fittingId: string) => void;
  onConfig: (faculty: string, fittingId: string, field: ConfigSchemaField, value: ConfigValue) => void;
  onEdit: (fittingId: string) => void;
  isEditable: (fittingId: string) => boolean;
}) {
  return (
    <div style={{ marginBottom: 22 }} data-testid={`standing-category-${category}`}>
      <div className={styles.slotHead} style={{ marginBottom: 10 }}>
        <div className={styles.slotHeadTop}>
          <span className={styles.slotName}>{category}</span>
          <span className={styles.slotCardinality}>{items.length}</span>
        </div>
        {CATEGORY_BLURBS[category] ? <p className={styles.slotRole}>{CATEGORY_BLURBS[category]}</p> : null}
      </div>
      <div className={styles.standingGrid}>
        {items.map(({ fitting, faculty }) => (
          <div key={fitting.id} className={styles.slotCard}>
            <FittingBlock
              fitting={fitting}
              health={fitting.ownPort ? health[fitting.id] : undefined}
              onSwap={() => onSwap(faculty, fitting.id)}
              onRemove={() => onRemoveFitting(faculty, fitting.id)}
              onConfig={(field, value) => onConfig(faculty, fitting.id, field, value)}
              onEdit={isEditable(fitting.id) ? () => onEdit(fitting.id) : undefined}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── one addable library fitting (search results / Add modal) ─────────────────
function AddableCard({ candidate, onAdd }: { candidate: StandingCandidate; onAdd: () => void }) {
  return (
    <div className={styles.slotCard} data-testid={`standing-addable-${candidate.id}`}>
      <div className={styles.fittingBlock}>
        <div className={styles.fittingHead}>
          <span className={styles.fittingName}>{candidate.name}</span>
          {candidate.clonedFrom ? <span className={styles.cloneTag}>clone</span> : null}
        </div>
        {candidate.summary ? <p className={styles.fittingSummary}>{candidate.summary}</p> : null}
        <div className={styles.runtimeControls} style={{ borderTop: "none", paddingTop: 6, marginTop: 8 }}>
          <button type="button" className={styles.testBtn} onClick={onAdd} data-testid={`standing-addable-add-${candidate.id}`}>
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

// ── the Add picker: every addable fitting in the library, grouped by category ─
function AddFittingModal({
  addable,
  onPick,
  onClose
}: {
  addable: AddableItem[];
  onPick: (faculty: string, toId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q) return addable;
    return addable.filter(({ candidate }) =>
      `${candidate.name} ${candidate.summary} ${candidate.id} ${candidate.category}`.toLowerCase().includes(q)
    );
  }, [addable, q]);
  const groups = useMemo(() => {
    const byCategory = new Map<string, AddableItem[]>();
    for (const item of results) {
      const key = item.candidate.category || "Operations";
      byCategory.set(key, [...(byCategory.get(key) ?? []), item]);
    }
    const order = [...(CATEGORY_ORDER as readonly string[]), ...[...byCategory.keys()].filter(
      (c) => !(CATEGORY_ORDER as readonly string[]).includes(c)
    ).sort()];
    return order.filter((c) => byCategory.has(c)).map((c) => ({ category: c, items: byCategory.get(c) ?? [] }));
  }, [results]);

  return (
    <Modal
      title="Add a fitting"
      subtitle={`${addable.length} available`}
      onClose={onClose}
      testId="standing-add-modal"
    >
      <input
        type="search"
        className={styles.pickerSearch}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name or what it does…"
        aria-label="Search available fittings"
        data-testid="standing-add-search"
        autoFocus
      />
      {results.length === 0 ? (
        <div className={styles.pickerEmpty}>No fittings match that search.</div>
      ) : (
        <div className={styles.pickerList}>
          {groups.map(({ category, items }) => (
            <div key={category}>
              <div
                className="font-mono"
                style={{
                  fontSize: 10,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  color: "var(--brass)",
                  margin: "10px 2px 6px"
                }}
              >
                {category}
              </div>
              {items.map(({ candidate, faculty }) => (
                <button
                  key={candidate.id}
                  type="button"
                  className={styles.pickerItem}
                  onClick={() => onPick(faculty, candidate.id)}
                  data-testid={`standing-add-item-${candidate.id}`}
                >
                  <div className={styles.pickerItemTop}>
                    <span className={styles.pickerItemName}>{candidate.name}</span>
                    {candidate.clonedFrom ? <span className={styles.cloneTag}>clone</span> : null}
                  </div>
                  <span className={styles.pickerItemSummary}>{candidate.summary}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ── one fitting block: identity + config form + file/swap actions ────────────
function FittingBlock({
  fitting,
  health,
  onSwap,
  onRemove,
  onConfig,
  onEdit
}: {
  fitting: StandingFittingView;
  health: boolean | undefined;
  onSwap: () => void;
  onRemove?: () => void;
  onConfig: (field: ConfigSchemaField, value: ConfigValue) => void;
  onEdit?: () => void;
}) {
  // Config starts folded: the scan view is fitting identities, not forms. A
  // fitting's knobs open on demand.
  const [cfgOpen, setCfgOpen] = useState(false);
  return (
    <div className={styles.fittingBlock} data-testid={`standing-fitting-${fitting.id}`}>
      <div className={styles.fittingHead}>
        <span className={styles.fittingName} data-testid={`standing-fitting-name-${fitting.id}`}>
          {fitting.name}
        </span>
        <span className={styles.shapeTag}>{fitting.componentShape}</span>
        {fitting.clonedFrom ? (
          <span className={styles.cloneTag} title={`Cloned from ${fitting.clonedFrom}`}>
            clone
          </span>
        ) : null}
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
      {fitting.summary ? (
        <p className={styles.fittingSummary} data-testid={`standing-fitting-summary-${fitting.id}`}>
          {fitting.summary}
        </p>
      ) : null}

      {fitting.dutyFitting ? (
        <p className={styles.cfgEmpty} data-testid={`standing-duty-note-${fitting.id}`}>
          Runs as a duty - its routing and levels are managed in Orchestrator → Duties.
        </p>
      ) : fitting.configSchema.length > 0 || fitting.login ? (
        <>
          <button
            type="button"
            className={styles.cfgToggle}
            aria-expanded={cfgOpen}
            onClick={() => setCfgOpen((v) => !v)}
            data-testid={`standing-config-toggle-${fitting.id}`}
          >
            <Caret open={cfgOpen} />
            Configuration
            <span className={styles.cfgCount}>{fitting.configSchema.length}</span>
          </button>
          {cfgOpen ? (
            <div className={styles.configForm}>
              {fitting.configSchema.map((field) => (
                <ConfigField
                  key={field.key}
                  faculty={fitting.faculty}
                  fittingId={fitting.id}
                  field={field}
                  value={fitting.config[field.key] ?? field.default ?? ""}
                  provider={String(fitting.config.provider ?? "")}
                  onChange={(value) => onConfig(field, value)}
                />
              ))}
              {fitting.login ? (
                <div className={styles.cfgField}>
                  <span className={styles.cfgLabel}>native login</span>
                  <GenericLoginPanel fittingId={fitting.id} storageHint={fitting.login.storage_hint} />
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <p className={styles.cfgEmpty}>No configuration for this fitting.</p>
      )}

      <div className={styles.runtimeControls} style={{ borderTop: "none", paddingTop: 6, marginTop: 8 }}>
        {onEdit ? (
          <button
            type="button"
            className={styles.testBtn}
            onClick={onEdit}
            title="Open this fitting's files in the editor"
            data-testid={`standing-edit-${fitting.id}`}
          >
            Edit files
          </button>
        ) : null}
        {fitting.dutyFitting ? null : (
          <>
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
          </>
        )}
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
  provider,
  onChange
}: {
  faculty: string;
  fittingId: string;
  field: ConfigSchemaField;
  value: ConfigValue;
  /** The sibling `provider` config value, for engines that front several endpoint families. */
  provider?: string;
  onChange: (value: ConfigValue) => void;
}) {
  const testId = `standing-config-${faculty}-${fittingId}-${field.key}`;
  const label = (
    <span className={styles.cfgLabel}>
      {field.key}
      {field.required ? " *" : ""}
    </span>
  );

  // RUNTIME-ACCOUNTS-V1: the "account" key renders as the account selector +
  // guided login flow (registry-driven options; mirrors Compose ConfigInput).
  if (field.key === "account") {
    const accountContract = runtimeAccountContract(fittingId, undefined, provider);
    if (!accountContract) {
      return (
        <div className={styles.cfgField} data-testid={testId}>
          {label}
          <span className={styles.cfgHint}>
            This provider is keyless or has no declared named-account mapping.
          </span>
          {String(value) ? (
            <button type="button" className="btn small" onClick={() => onChange("")}>
              Clear incompatible account “{String(value)}”
            </button>
          ) : null}
          {field.description ? <span className={styles.cfgHint}>{field.description}</span> : null}
        </div>
      );
    }
    return (
      <div className={styles.cfgField} data-testid={testId}>
        {label}
        <AccountField
          value={String(value)}
          onChange={(next) => onChange(next)}
          contract={accountContract}
        />
        {field.description ? <span className={styles.cfgHint}>{field.description}</span> : null}
      </div>
    );
  }

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
    <Modal title={title} subtitle={`${slot.candidates.length} compatible`} onClose={onClose} testId="standing-swap-modal">
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

// ── RuntimesPanel: dedicated tab for runtime configuration ───────────────────
export function RuntimesPanel({ compositionId }: { compositionId: string }) {
  const { library, openFittingEditor } = useAppShell();
  const [model, setModel] = useState<StandingModel | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [health, setHealth] = useState<Record<string, boolean>>({});
  const [swap, setSwap] = useState<SwapTarget | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [tests, setTests] = useState<Record<string, RuntimeTestResult>>({});
  const [orphaned, setOrphaned] = useState<OrphanedConsumer[]>([]);
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // The still-pending POST for each debounced field, so a tab-away (which
  // unmounts this panel) flushes the last edit instead of dropping it.
  const pendingPosts = useRef<Map<string, () => void>>(new Map());
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

  useEffect(() => { void load(); refreshHealth(); }, [load, refreshHealth]);

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
    (fittingId: string, field: ConfigSchemaField, value: ConfigValue) => {
      setModel((m) =>
        m
          ? {
              ...m,
              slots: m.slots.map((slot) =>
                slot.faculty !== "runtimes"
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
      const timerKey = `runtimes:${fittingId}:${field.key}`;
      const doPost = () => {
        pendingPosts.current.delete(timerKey);
        void persist("/api/muster/standing/config", { faculty: "runtimes", fittingId, key: field.key, value });
      };
      const existing = debounceTimers.current.get(timerKey);
      if (existing) clearTimeout(existing);
      if (debounced) {
        pendingPosts.current.set(timerKey, doPost);
        debounceTimers.current.set(timerKey, setTimeout(doPost, 450));
      } else {
        doPost();
      }
    },
    [persist]
  );

  useEffect(() => {
    const timers = debounceTimers.current;
    const pending = pendingPosts.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      // Flush, don't drop: fire the last debounced edit so tab-away still saves.
      for (const flush of pending.values()) flush();
      pending.clear();
    };
  }, []);

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

  const doSwap = useCallback(
    async (faculty: string, toId: string | undefined, fromId: string | undefined) => {
      setSwap(null);
      // A runtime swap/removal can strand a consumer of the outgoing fitting.
      // Surface the offer to remove it (same contract as the Fittings tab) —
      // never auto-remove.
      const data = await persist("/api/muster/standing/swap", { faculty, toId, fromId });
      if (data && Array.isArray(data.orphaned)) setOrphaned(data.orphaned as OrphanedConsumer[]);
      refreshHealth();
    },
    [persist, refreshHealth]
  );

  const removeOrphan = useCallback(
    async (orphan: OrphanedConsumer) => {
      const data = await persist("/api/muster/standing/swap", { faculty: orphan.faculty, fromId: orphan.fittingId });
      setOrphaned(data && Array.isArray(data.orphaned) ? (data.orphaned as OrphanedConsumer[]) : []);
    },
    [persist]
  );

  const editFitting = useCallback(
    (fittingId: string) => {
      const entry = library.find((e) => e.id === fittingId);
      if (entry) openFittingEditor(entry);
    },
    [library, openFittingEditor]
  );
  const isEditable = useCallback(
    (fittingId: string) => Boolean(library.find((e) => e.id === fittingId)?.localPath),
    [library]
  );

  const runtimeSlot = useMemo(
    () => model?.slots.find((s) => s.faculty === "runtimes") ?? null,
    [model]
  );
  const primaryFitting = useMemo(
    () => runtimeSlot?.fittings.find((f) => f.id === model?.primaryRuntime) ?? null,
    [runtimeSlot, model]
  );
  const secondaryFittings = useMemo(
    () => runtimeSlot?.fittings.filter((f) => f.id !== model?.primaryRuntime) ?? [],
    [runtimeSlot, model]
  );

  if (status === "loading" && !model) {
    return (
      <div className={styles.rtPanel} data-testid="runtimes-loading">
        <div className={styles.skelRow} />
        <div className={styles.skelRow} />
      </div>
    );
  }

  if (status === "error" && !model) {
    return (
      <div className={styles.rtPanel}>
        <div className={styles.stateBox} data-testid="runtimes-error">
          <div className={styles.stateTitle}>Could not load runtimes</div>
          <p className={styles.stateBody}>{errorMsg}</p>
          <button type="button" className={styles.addBtn} style={{ marginTop: 16 }} onClick={() => void load()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!model || !runtimeSlot) return null;

  const swapSlot = swap ? model.slots.find((s) => s.faculty === swap.faculty) ?? null : null;

  return (
    <div className={styles.rtPanel} data-testid="runtimes-panel">
      <div className={styles.rtPanelHead}>
        <p className={styles.stageLead}>
          The execution engine for this composition. The primary runtime runs the orchestrator loop;
          secondary runtimes are available as delegate targets via the uniform runtime bridge.
        </p>
        <div className={styles.rtPanelActions}>
          {saving ? <span className={styles.saving}>saving...</span> : null}
          {errorMsg ? (
            <div className={styles.blocking} role="alert" style={{ marginBottom: 0, fontSize: 11.5 }}>
              <span className={styles.blockGlyph}>!</span>
              <p style={{ margin: 0 }}>{errorMsg}</p>
            </div>
          ) : null}
          <button
            type="button"
            className={styles.slotFootBtn}
            onClick={() => setSwap({ faculty: "runtimes" })}
            data-testid="runtimes-add-fitting"
          >
            + Add fitting
          </button>
          <button
            type="button"
            className={styles.slotFootBtn}
            onClick={() => setCreateOpen(true)}
            data-testid="runtimes-new-runtime"
          >
            + New runtime
          </button>
        </div>
      </div>

      {orphaned.length > 0 ? (
        <OrphanBanner orphaned={orphaned} onRemove={removeOrphan} onDismiss={() => setOrphaned([])} />
      ) : null}

      <div className={styles.rtSection}>
        <h3 className={styles.rtSectionLabel}>Primary runtime</h3>
        {primaryFitting ? (
          <div className={styles.rtPrimaryCard} data-testid={`rt-primary-${primaryFitting.id}`}>
            <RuntimeCard
              fitting={primaryFitting}
              isPrimary={true}
              providesRuntime={primaryFitting.providesRuntime}
              health={primaryFitting.ownPort ? health[primaryFitting.id] : undefined}
              test={tests[primaryFitting.id]}
              onConfig={(field, value) => commitConfig(primaryFitting.id, field, value)}
              onSetPrimary={() => setPrimary(primaryFitting.id)}
              onTest={() => void testRuntime(primaryFitting.id)}
              onSwap={() => setSwap({ faculty: "runtimes", fromId: primaryFitting.id })}
              onRemove={undefined}
              onEdit={isEditable(primaryFitting.id) ? () => editFitting(primaryFitting.id) : undefined}
            />
          </div>
        ) : (
          <div className={styles.rtEmpty} data-testid="rt-primary-empty">
            No primary runtime set. Add a runtime fitting below and set it as primary.
          </div>
        )}
      </div>

      <div className={styles.rtSection}>
        <h3 className={styles.rtSectionLabel}>
          Secondary runtimes
          {secondaryFittings.length > 0 && (
            <span className={styles.rtSectionCount}>{secondaryFittings.length}</span>
          )}
        </h3>
        {secondaryFittings.length === 0 ? (
          <div className={styles.rtEmpty} data-testid="rt-secondary-empty">
            No secondary runtimes stationed. Add one to enable runtime delegation.
          </div>
        ) : (
          <div className={styles.rtSecondaryGrid}>
            {secondaryFittings.map((fitting) => (
              <div key={fitting.id} className={styles.rtSecondaryCard}>
                <RuntimeCard
                  fitting={fitting}
                  isPrimary={false}
                  providesRuntime={fitting.providesRuntime}
                  health={fitting.ownPort ? health[fitting.id] : undefined}
                  test={tests[fitting.id]}
                  onConfig={(field, value) => commitConfig(fitting.id, field, value)}
                  onSetPrimary={() => setPrimary(fitting.id)}
                  onTest={() => void testRuntime(fitting.id)}
                  onSwap={() => setSwap({ faculty: "runtimes", fromId: fitting.id })}
                  onRemove={() => void doSwap("runtimes", undefined, fitting.id)}
                  onEdit={isEditable(fitting.id) ? () => editFitting(fitting.id) : undefined}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {swap && swapSlot ? (
        <SwapModal slot={swapSlot} fromId={swap.fromId} onPick={doSwap} onClose={() => setSwap(null)} />
      ) : null}
      {createOpen ? (
        <CreateRuntimeModal
          templates={model.runtimeTemplates}
          onCreate={createRuntime}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
    </div>
  );
}

// At-a-glance spec chips: the effective value of each non-secret config field
// (model, account, effort, ...) readable without unfolding the form.
function runtimeSpecChips(fitting: StandingFittingView): { key: string; value: string }[] {
  const chips: { key: string; value: string }[] = [];
  for (const field of fitting.configSchema) {
    if (field.type === "secret-ref") continue;
    const raw = fitting.config[field.key] ?? field.default;
    if (raw === undefined || raw === "") continue;
    chips.push({ key: field.key, value: String(raw) });
    if (chips.length === 4) break;
  }
  return chips;
}

// ── RuntimeCard: a single runtime fitting with identity + config + actions ────
function RuntimeCard({
  fitting,
  isPrimary,
  providesRuntime,
  health,
  test,
  onConfig,
  onSetPrimary,
  onTest,
  onSwap,
  onRemove,
  onEdit
}: {
  fitting: StandingFittingView;
  isPrimary: boolean;
  providesRuntime: boolean;
  health: boolean | undefined;
  test: RuntimeTestResult | undefined;
  onConfig: (field: ConfigSchemaField, value: ConfigValue) => void;
  onSetPrimary: () => void;
  onTest: () => void;
  onSwap: () => void;
  onRemove: (() => void) | undefined;
  onEdit: (() => void) | undefined;
}) {
  const [cfgOpen, setCfgOpen] = useState(false);
  const specs = runtimeSpecChips(fitting);
  return (
    <div className={styles.rtCard}>
      <div className={styles.rtCardHead}>
        <div className={styles.rtCardMeta}>
          <h4 className={styles.rtCardName}>{fitting.name}</h4>
          <div className={styles.rtCardTags}>
            {isPrimary ? (
              <span className={styles.rtPrimaryBadge} data-testid={`rt-primary-badge-${fitting.id}`}>
                Primary
              </span>
            ) : null}
            <span className={styles.shapeTag}>{fitting.componentShape}</span>
            {fitting.clonedFrom ? (
              <span className={styles.cloneTag} title={`Cloned from ${fitting.clonedFrom}`}>clone</span>
            ) : null}
            {!providesRuntime ? (
              <span
                className={styles.rtSupportTag}
                title="Stationed under the runtimes faculty but does not provide an execution engine — it cannot be made primary."
                data-testid={`rt-support-${fitting.id}`}
              >
                support
              </span>
            ) : null}
          </div>
        </div>
        {fitting.ownPort ? (
          <span
            className={clsx(styles.healthPip, health === true && styles.up, health === false && styles.down)}
            title={health === true ? "Serving on its port" : health === false ? "Not responding" : "Not running"}
          >
            <span className={styles.healthDot} />
            {health === true ? "live" : health === false ? "down" : "idle"}
          </span>
        ) : null}
      </div>

      {fitting.summary ? (
        <p className={styles.rtCardSummary}>{fitting.summary}</p>
      ) : null}

      {specs.length > 0 ? (
        <div className={styles.rtSpecs} data-testid={`rt-specs-${fitting.id}`}>
          {specs.map((s) => (
            <span key={s.key} className={styles.rtSpecChip} title={`${s.key}: ${s.value}`}>
              <span className={styles.rtSpecKey}>{s.key}</span>
              <span className={styles.rtSpecVal}>{s.value}</span>
            </span>
          ))}
        </div>
      ) : null}

      {fitting.configSchema.length > 0 || fitting.login ? (
        <>
          <button
            type="button"
            className={styles.cfgToggle}
            aria-expanded={cfgOpen}
            onClick={() => setCfgOpen((v) => !v)}
            data-testid={`rt-cfg-toggle-${fitting.id}`}
          >
            <Caret open={cfgOpen} />
            Configuration
            <span className={styles.cfgCount}>{fitting.configSchema.length}</span>
          </button>
          {cfgOpen ? (
            <div className={styles.configForm}>
              {fitting.configSchema.map((field) => (
                <ConfigField
                  key={field.key}
                  faculty="runtimes"
                  fittingId={fitting.id}
                  field={field}
                  value={fitting.config[field.key] ?? field.default ?? ""}
                  provider={String(fitting.config.provider ?? "")}
                  onChange={(value) => onConfig(field, value)}
                />
              ))}
              {fitting.login ? (
                <div className={styles.cfgField}>
                  <span className={styles.cfgLabel}>native login</span>
                  <GenericLoginPanel fittingId={fitting.id} storageHint={fitting.login.storage_hint} />
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <p className={styles.cfgEmpty}>No configuration for this fitting.</p>
      )}

      {test ? (
        <div
          className={styles.testResult}
          role="status"
          aria-live="polite"
          data-testid={`rt-test-result-${fitting.id}`}
        >
          {test.checks.map((c) => (
            <div key={c.label} className={clsx(styles.checkRow, c.ok ? styles.ok : styles.bad)}>
              <span className={styles.checkMark} aria-hidden="true">{c.ok ? "+" : "!"}</span>
              <span className="visually-hidden">{c.ok ? "pass:" : "fail:"}</span>
              <span>
                {c.label}
                {c.detail ? <span className={styles.checkDetail}> · {c.detail}</span> : null}
              </span>
            </div>
          ))}
          <p className={styles.testNote}>{test.note}</p>
        </div>
      ) : null}

      <div className={styles.rtCardFoot}>
        {!isPrimary && providesRuntime ? (
          <button
            type="button"
            className={styles.rtSetPrimaryBtn}
            onClick={onSetPrimary}
            data-testid={`rt-set-primary-${fitting.id}`}
          >
            Set as primary
          </button>
        ) : null}
        {providesRuntime ? (
          <button type="button" className={styles.testBtn} onClick={onTest} data-testid={`rt-test-${fitting.id}`}>
            Test
          </button>
        ) : null}
        {onEdit ? (
          <button
            type="button"
            className={styles.testBtn}
            onClick={onEdit}
            title="Open this fitting's files in the editor"
          >
            Edit files
          </button>
        ) : null}
        <button type="button" className={styles.testBtn} onClick={onSwap} data-testid={`rt-swap-${fitting.id}`}>
          Swap
        </button>
        {onRemove ? (
          <button
            type="button"
            className={styles.testBtn}
            onClick={onRemove}
            data-testid={`rt-remove-${fitting.id}`}
          >
            Remove
          </button>
        ) : null}
      </div>
    </div>
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
