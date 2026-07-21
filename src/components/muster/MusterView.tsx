"use client";

import { useMemo, useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import clsx from "clsx";
import { dutyEfforts } from "@/lib/types";
import { validateCell, isAgenticRuntime } from "./cell-validation";
import type {
  CompositionTarget,
  DutyEffort,
  MusterActions,
  MusterModel,
  MusterTargetUpdate,
  ResolvedDuty,
  RuleResult
} from "./types";
import styles from "./Muster.module.css";

// ── small inline glyphs (no emoji, per house rule) ──────────────────────────
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
function XMark() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

// A compact 2-3 letter mark for a target's runtime engine.
function runtimeMark(runtime: string): string {
  switch (runtime) {
    case "claude-code": return "CC";
    case "agent-sdk": return "SDK";
    case "codex": return "CX";
    case "gemini": return "GM";
    case "opencode": return "OP";
    case "garrison-call": return "GC";
    default: return (runtime || "?").slice(0, 2).toUpperCase();
  }
}

function targetById(targets: CompositionTarget[], id: string | undefined): CompositionTarget | undefined {
  return id ? targets.find((t) => t.id === id) : undefined;
}

// ── command bar (identity · readiness pill · composition switch) ─────────────
export function MusterHeader({ model, actions }: { model: MusterModel; actions: MusterActions }) {
  return (
    <header className={styles.commandBar}>
      <div className={styles.identity}>
        <div className={styles.kicker}>Muster</div>
        <h1 className={styles.title}>{model.compositionName}</h1>
        <div className={styles.titleId}>{model.compositionId}</div>
      </div>
      <div className={styles.command}>
        {model.ready ? (
          <span className={clsx(styles.statusPill, styles.pillReady)} data-testid="readiness-badge">
            <span className={styles.pillDot} />
            Ready to run
          </span>
        ) : (
          <span className={clsx(styles.statusPill, styles.pillNotReady)} data-testid="readiness-badge">
            <span className={styles.pillDot} />
            Not ready
          </span>
        )}
        <label className={styles.switcher}>
          <span className={styles.switcherLabel}>Composition</span>
          <select
            className={styles.select}
            value={model.compositionId}
            onChange={(e) => actions.switchComposition(e.target.value)}
            aria-label="Switch composition"
          >
            {model.compositions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.id})
              </option>
            ))}
          </select>
        </label>
      </div>
    </header>
  );
}

// ── readiness ledger (D10): the blocking notice + the per-rule checklist ─────
// Kept always-mounted under the command bar (not behind a section tab) so the
// operator sees run-readiness the instant the page loads, whatever tab is open.
export function ReadinessDetail({ model }: { model: MusterModel }) {
  const unmet = model.rules.filter((r) => !r.met);
  const dutyErrors = model.errors;
  const blocked = !model.ready;
  return (
    <section className={styles.readiness} aria-label="Readiness">
      {blocked && (unmet.length > 0 || dutyErrors.length > 0) ? (
        <div className={styles.blocking} role="alert" data-testid="readiness-blocking">
          <span className={styles.blockGlyph}>!</span>
          <div>
            <h5>Not ready to run</h5>
            <p>
              {unmet.length > 0 ? `Missing: ${unmet.map((r) => r.rule.description).join(", ")}.` : ""}
              {dutyErrors.length > 0 ? ` Duty graph: ${dutyErrors.map((e) => e.message).join("; ")}.` : ""}
            </p>
          </div>
        </div>
      ) : null}

      <div className={styles.rulePills} data-testid="readiness-rules">
        {model.rules.map((rule: RuleResult) => (
          <span
            key={rule.rule.id}
            className={clsx(styles.rulePill, rule.met ? styles.met : styles.unmet)}
            title={rule.message}
            data-testid={`rule-${rule.rule.id}`}
          >
            <span className={styles.ruleMark}>{rule.met ? "+" : "!"}</span>
            {rule.rule.description}
          </span>
        ))}
      </div>
    </section>
  );
}

// ── targets tray ─────────────────────────────────────────────────────────────
export function TargetsTray({ model, actions }: { model: MusterModel; actions: MusterActions }) {
  const [editing, setEditing] = useState<CompositionTarget | "new" | null>(null);
  return (
    <>
      <p className={styles.trayHint}>
        Drag a target onto a level&apos;s cell, or tap a target to arm it then tap a cell to place it.
        Skill cells need an agentic runtime.
      </p>
      <button
        type="button"
        className={styles.addBtn}
        onClick={() => setEditing("new")}
        data-testid="add-target"
        style={{ width: "100%", marginBottom: 9 }}
      >
        + Add target
      </button>
      {model.targets.length === 0 ? (
        <p className={styles.trayHint} data-testid="targets-empty">
          No targets yet. Add a stationed runtime target, then assign it to duty levels.
        </p>
      ) : (
        <div className={styles.tray} data-testid="targets-tray">
          {model.targets.map((t) => (
            <div key={t.id} style={{ display: "flex", gap: 5, width: "100%" }}>
              <TargetChip target={t} armed={actions.armed === t.id} onArm={actions.onArm} />
              <button
                type="button"
                className={styles.removeBtn}
                onClick={() => setEditing(t)}
                aria-label={`Edit ${t.id}`}
                title={`Edit ${t.id}`}
                data-testid={`edit-target-${t.id}`}
                style={{ margin: 0, minWidth: 36 }}
              >
                edit
              </button>
            </div>
          ))}
        </div>
      )}
      {editing ? (
        <TargetEditor
          target={editing === "new" ? null : editing}
          runtimeOptions={model.runtimeOptions}
          saving={actions.saving}
          onSave={actions.saveTarget}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

function TargetEditor({
  target,
  runtimeOptions,
  saving,
  onSave,
  onClose
}: {
  target: CompositionTarget | null;
  runtimeOptions: MusterModel["runtimeOptions"];
  saving: boolean;
  onSave: (target: MusterTargetUpdate) => Promise<boolean>;
  onClose: () => void;
}) {
  const options = useMemo(() => {
    const byId = new Map(runtimeOptions.map((option) => [option.id, option]));
    if (target && !byId.has(target.runtime)) {
      byId.set(target.runtime, { id: target.runtime, fittingId: "current target" });
    }
    return [...byId.values()];
  }, [runtimeOptions, target]);
  const [id, setId] = useState(target?.id ?? "");
  const [runtime, setRuntime] = useState(target?.runtime ?? options[0]?.id ?? "");
  const [provider, setProvider] = useState(target?.provider ?? "");
  const [model, setModel] = useState(target?.model ?? "");
  const initialPromptMode = target?.params?.promptMode;
  const [promptMode, setPromptMode] = useState(
    initialPromptMode === "lean" || initialPromptMode === "full" ? initialPromptMode : ""
  );
  const [maxTurns, setMaxTurns] = useState(
    typeof target?.params?.maxTurns === "number" ? String(target.params.maxTurns) : ""
  );
  const [error, setError] = useState<string | null>(null);

  return (
    <div className={styles.modalBackdrop} data-testid="target-editor" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !saving) onClose();
    }}>
      <form
        className={styles.modal}
        onSubmit={async (event) => {
          event.preventDefault();
          const turns = maxTurns.trim() ? Number(maxTurns) : null;
          if (turns !== null && (!Number.isInteger(turns) || turns < 1 || turns > 100)) {
            setError("Max turns must be a whole number from 1 to 100.");
            return;
          }
          const ok = await onSave({
            ...(target ? { originalId: target.id } : {}),
            id: id.trim(),
            runtime,
            provider: provider.trim() || undefined,
            model: model.trim(),
            promptMode: promptMode === "lean" || promptMode === "full" ? promptMode : null,
            maxTurns: turns
          });
          if (ok) onClose();
        }}
      >
        <div className={styles.modalHead}>
          <div>
            <div className={styles.modalTitle}>{target ? `Edit ${target.id}` : "Add target"}</div>
            <div className={styles.modalSub}>Engine identity and Agent SDK harness settings.</div>
          </div>
          <button type="button" className={styles.modalClose} onClick={onClose} aria-label="Close target editor">
            <XMark />
          </button>
        </div>
        <div style={{ padding: "14px 16px", display: "grid", gap: 12, overflowY: "auto" }}>
          <label className={styles.newIdRow} style={{ margin: 0 }}>
            <span>Target id</span>
            <input
              className={styles.pickerSearch}
              style={{ margin: 0 }}
              value={id}
              disabled={Boolean(target) || saving}
              onChange={(event) => setId(event.target.value)}
              placeholder="sdk-haiku-full"
              data-testid="target-id"
            />
          </label>
          <label className={styles.newIdRow} style={{ margin: 0 }}>
            <span>Runtime</span>
            <select
              className={styles.pickerSearch}
              style={{ margin: 0 }}
              value={runtime}
              disabled={saving}
              onChange={(event) => setRuntime(event.target.value)}
              data-testid="target-runtime"
            >
              {options.map((option) => (
                <option key={option.id} value={option.id}>{option.id} · {option.fittingId}</option>
              ))}
            </select>
          </label>
          <label className={styles.newIdRow} style={{ margin: 0 }}>
            <span>Provider (optional)</span>
            <input
              className={styles.pickerSearch}
              style={{ margin: 0 }}
              value={provider}
              disabled={saving}
              onChange={(event) => setProvider(event.target.value)}
              placeholder="anthropic"
              data-testid="target-provider"
            />
          </label>
          <label className={styles.newIdRow} style={{ margin: 0 }}>
            <span>Model</span>
            <input
              className={styles.pickerSearch}
              style={{ margin: 0 }}
              value={model}
              disabled={saving}
              onChange={(event) => setModel(event.target.value)}
              placeholder="claude-haiku-4-5"
              data-testid="target-model"
            />
          </label>
          <label className={styles.newIdRow} style={{ margin: 0 }}>
            <span>Prompt mode</span>
            <select
              className={styles.pickerSearch}
              style={{ margin: 0 }}
              value={promptMode}
              disabled={saving}
              onChange={(event) => setPromptMode(event.target.value)}
              data-testid="target-prompt-mode"
            >
              <option value="">runtime default</option>
              <option value="lean">lean · tools off</option>
              <option value="full">full · tools and gate evidence</option>
            </select>
          </label>
          <label className={styles.newIdRow} style={{ margin: 0 }}>
            <span>Max turns (optional)</span>
            <input
              className={styles.pickerSearch}
              style={{ margin: 0 }}
              type="number"
              min={1}
              max={100}
              value={maxTurns}
              disabled={saving}
              onChange={(event) => setMaxTurns(event.target.value)}
              placeholder="8"
              data-testid="target-max-turns"
            />
          </label>
          {error ? <div className={styles.modalError} style={{ margin: 0 }}>{error}</div> : null}
        </div>
        <div className={styles.modalFoot}>
          <button type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            type="submit"
            disabled={saving || !id.trim() || !runtime || !model.trim()}
            data-testid="target-submit"
          >
            {saving ? "Saving…" : target ? "Save target" : "Add target"}
          </button>
        </div>
      </form>
    </div>
  );
}

function TargetChip({
  target,
  armed,
  onArm
}: {
  target: CompositionTarget;
  armed: boolean;
  onArm: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `target:${target.id}` });
  const agentic = isAgenticRuntime(target.runtime);
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={clsx(
        styles.targetChip,
        armed && styles.armed,
        isDragging && styles.dragging,
        !agentic && styles.nonAgentic
      )}
      {...attributes}
      {...listeners}
      onClick={() => onArm(target.id)}
      title={
        armed
          ? "Armed - tap a level cell to place it here; tap again to disarm"
          : agentic
            ? "Drag onto a cell, or tap to arm for tap-to-place"
            : "Single-shot runtime - cannot host a skill cell. Drag or tap to arm."
      }
      data-testid={`target-chip-${target.id}`}
      data-armed={armed ? "true" : "false"}
    >
      <span className={styles.chipMark}>{runtimeMark(target.runtime)}</span>
      <span className={styles.chipBody}>
        <span className={styles.chipId}>{target.id}</span>
        <span className={styles.chipRuntime}>
          {target.runtime}
          {target.model ? ` · ${target.model}` : ""}
        </span>
      </span>
    </button>
  );
}

// ── duty list ────────────────────────────────────────────────────────────────
export function DutyList({ model, actions }: { model: MusterModel; actions: MusterActions }) {
  if (model.selectedDuties.length === 0) {
    return (
      <div className={styles.stateBox} data-testid="duties-empty">
        <div className={styles.stateTitle}>No duties selected</div>
        <p className={styles.stateBody}>
          A composition runs the duties you select. Add one below to give the operative work to route.
        </p>
      </div>
    );
  }
  return (
    <div className={styles.dutyList} data-testid="duty-list">
      {model.selectedDuties.map((id) => {
        const duty = model.duties[id];
        if (!duty) {
          return (
            <div key={id} className={styles.dutyRow} data-testid={`duty-row-${id}`}>
              <div className={styles.dutyToggle} style={{ cursor: "default" }}>
                <span className={styles.dutyName}>{id}</span>
                <span className={clsx(styles.dutySummary, styles.dutyViolation)}>unknown duty - no definition</span>
              </div>
            </div>
          );
        }
        return <DutyRow key={id} duty={duty} model={model} actions={actions} />;
      })}
    </div>
  );
}

function dutyLeafSummary(duty: ResolvedDuty, targets: CompositionTarget[]): { text: string; violation: boolean } {
  const usedTargets = new Set<string>();
  let hasComposite = false;
  let violation = false;
  for (const level of duty.levels) {
    if (level.cell) {
      if (level.cell.target) usedTargets.add(level.cell.target);
      if (validateCell(level.cell, targets).length > 0) violation = true;
    }
    if (level.sequence) hasComposite = true;
  }
  const parts: string[] = [`${duty.levels.length} level${duty.levels.length === 1 ? "" : "s"}`];
  if (hasComposite) parts.push("composite");
  if (usedTargets.size > 0) parts.push([...usedTargets].join(", "));
  return { text: parts.join(" · "), violation };
}

function DutyRow({
  duty,
  model,
  actions
}: {
  duty: ResolvedDuty;
  model: MusterModel;
  actions: MusterActions;
}) {
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => dutyLeafSummary(duty, model.targets), [duty, model.targets]);
  return (
    <div className={clsx(styles.dutyRow, open && styles.expanded)} data-testid={`duty-row-${duty.id}`}>
      <div className={styles.dutyHead}>
        <button
          type="button"
          className={styles.dutyToggle}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          data-testid={`duty-toggle-${duty.id}`}
        >
          <Caret open={open} />
          <span className={styles.dutyName}>{duty.title}</span>
          <span className={clsx(styles.dutySummary, summary.violation && styles.dutyViolation)}>
            {summary.violation ? "needs attention · " : ""}
            {summary.text}
          </span>
        </button>
        <button
          type="button"
          className={styles.removeBtn}
          onClick={() => actions.removeDuty(duty.id)}
          title={`Remove ${duty.title}`}
          aria-label={`Remove ${duty.title}`}
          data-testid={`duty-remove-${duty.id}`}
        >
          <XMark />
        </button>
      </div>
      {open ? (
        <div className={styles.levels} data-testid={`duty-levels-${duty.id}`}>
          {duty.levels.map((level, index) => (
            <div className={styles.level} key={index}>
              <div className={styles.levelRail}>
                <div className={styles.levelTag}>L{index + 1}</div>
                {duty.levels.length > 1 ? (
                  <button
                    type="button"
                    className={styles.levelRemove}
                    onClick={() => actions.removeLevel(duty.id, index + 1)}
                    title={`Remove level ${index + 1}`}
                    aria-label={`Remove level ${index + 1} of ${duty.title}`}
                    data-testid={`level-remove-${duty.id}-${index + 1}`}
                  >
                    <XMark />
                  </button>
                ) : null}
              </div>
              <div className={styles.levelBody}>
                <input
                  type="text"
                  className={styles.levelDescInput}
                  value={level.description}
                  onChange={(e) => actions.describeLevel(duty.id, index + 1, e.target.value)}
                  spellCheck={false}
                  aria-label={`Level ${index + 1} routing criterion`}
                  title="The Dispatcher routes by this description - say when this depth is the right one"
                  data-testid={`level-desc-${duty.id}-${index + 1}`}
                />
                {level.cell ? (
                  <LeafCell
                    dutyId={duty.id}
                    level={index + 1}
                    cell={level.cell}
                    targets={model.targets}
                    actions={actions}
                  />
                ) : (
                  <CompositeLevel sequence={level.sequence ?? []} />
                )}
              </div>
            </div>
          ))}
          <button
            type="button"
            className={styles.addLevelBtn}
            onClick={() => actions.addLevel(duty.id)}
            data-testid={`level-add-${duty.id}`}
          >
            + Add level
          </button>
        </div>
      ) : null}
    </div>
  );
}

function LeafCell({
  dutyId,
  level,
  cell,
  targets,
  actions
}: {
  dutyId: string;
  level: number;
  cell: NonNullable<ResolvedDuty["levels"][number]["cell"]>;
  targets: CompositionTarget[];
  actions: MusterActions;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `cell:${dutyId}:${level}` });
  const issues = validateCell(cell, targets);
  const invalid = issues.length > 0;
  const assigned = targetById(targets, cell.target);

  return (
    <div className={styles.leafCell} data-testid={`cell-${dutyId}-${level}`}>
      {cell.skill ? (
        <span className={styles.skillChip} data-testid={`cell-skill-${dutyId}-${level}`}>
          <span className={styles.metaMark}>skill</span>
          {cell.skill}
        </span>
      ) : null}

      <button
        ref={setNodeRef}
        type="button"
        className={clsx(
          styles.dropTarget,
          assigned && styles.set,
          isOver && styles.over,
          actions.armed && styles.armable,
          invalid && styles.invalid
        )}
        onClick={() => {
          if (actions.armed) actions.assignCell(dutyId, level, actions.armed);
        }}
        title={
          actions.armed
            ? `Place ${actions.armed} here`
            : "Drag a target here, or arm a target and tap"
        }
        data-testid={`cell-target-${dutyId}-${level}`}
        data-target={cell.target ?? ""}
      >
        <span className={styles.dropLabel}>target</span>
        {cell.target ? (
          <span className={styles.dropValue}>{cell.target}</span>
        ) : (
          <span className={styles.dropEmpty}>no target</span>
        )}
      </button>

      <div className={styles.efforts} role="group" aria-label="effort">
        {dutyEfforts.map((e) => (
          <button
            key={e}
            type="button"
            className={clsx(styles.effortSeg, cell.effort === e && styles.on)}
            onClick={() => actions.setEffort(dutyId, level, e as DutyEffort)}
            data-testid={`cell-effort-${dutyId}-${level}-${e}`}
            aria-pressed={cell.effort === e}
          >
            {e}
          </button>
        ))}
      </div>

      {invalid ? (
        <div className={styles.cellNote} data-testid={`cell-violation-${dutyId}-${level}`}>
          <span className={styles.noteMark}>!</span>
          <span>{issues[0].message}</span>
        </div>
      ) : null}
    </div>
  );
}

function CompositeLevel({ sequence }: { sequence: { duty: string; level?: number }[] }) {
  return (
    <div className={styles.composite}>
      <span className={styles.compositeLabel}>runs</span>
      {sequence.map((entry, i) => (
        <span key={`${entry.duty}-${i}`} className={styles.seqChip}>
          {i > 0 ? <span className={styles.seqArrow}>›</span> : null}
          {entry.duty}
          {entry.level ? <span className={styles.seqLevel}>L{entry.level}</span> : null}
        </span>
      ))}
    </div>
  );
}

// ── add duty ─────────────────────────────────────────────────────────────────
export function AddDuty({ model, actions }: { model: MusterModel; actions: MusterActions }) {
  const [open, setOpen] = useState(false);
  const available = useMemo(
    () => [
      ...Object.values(model.duties)
        .filter((d) => !model.selectedDuties.includes(d.id))
        .map((d) => ({ id: d.id, title: d.title, fittingId: null as string | null })),
      ...(model.dutyCandidates ?? [])
        .filter((d) => !model.selectedDuties.includes(d.id) && !model.duties[d.id])
        .map((d) => ({ id: d.id, title: d.title, fittingId: d.fittingId }))
    ],
    [model.duties, model.dutyCandidates, model.selectedDuties]
  );
  if (!open) {
    return (
      <button type="button" className={styles.addBtn} onClick={() => setOpen(true)} data-testid="add-duty">
        + Add duty
      </button>
    );
  }
  return (
    <div className={styles.addPanel} data-testid="add-duty-panel">
      <p className={styles.addPanelHead}>Select a duty to add to this composition.</p>
      {available.length === 0 ? (
        <span className={styles.addEmpty}>Every known duty is already selected.</span>
      ) : (
        <div className={styles.addOptions}>
          {available.map((d) => (
            <button
              key={d.id}
              type="button"
              className={styles.addOption}
              onClick={() => {
                actions.addDuty(d.id);
                setOpen(false);
              }}
              data-testid={`add-duty-option-${d.id}`}
            >
              {d.title}
              <span className={styles.addOptionSub}>
                {d.id}{d.fittingId ? ` · stations ${d.fittingId}` : ""}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
