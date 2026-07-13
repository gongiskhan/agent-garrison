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
  if (model.targets.length === 0) {
    return (
      <p className={styles.trayHint} data-testid="targets-empty">
        No targets in this composition yet. Add engine targets in Compose, then assign them to duty
        levels here.
      </p>
    );
  }
  return (
    <>
      <p className={styles.trayHint}>
        Drag a target onto a level&apos;s cell, or tap a target to arm it then tap a cell to place it.
        Skill cells need an agentic runtime.
      </p>
      <div className={styles.tray} data-testid="targets-tray">
        {model.targets.map((t) => (
          <TargetChip key={t.id} target={t} armed={actions.armed === t.id} onArm={actions.onArm} />
        ))}
      </div>
    </>
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
              <div className={styles.levelTag}>L{index + 1}</div>
              <div className={styles.levelBody}>
                <p className={styles.levelDesc}>{level.description}</p>
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
    () => Object.values(model.duties).filter((d) => !model.selectedDuties.includes(d.id)),
    [model.duties, model.selectedDuties]
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
              <span className={styles.addOptionSub}>{d.id}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
