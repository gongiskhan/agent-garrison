import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TurnRouting } from "./transport";
import {
  joinPhasesOff,
  pinnedValue,
  splitPhasesOff,
  type PinField,
  type PinPatch,
  type RailOptions,
} from "./AttributionRail";

// The routing modal — the pin EDITOR for a conversation, superseding the rail's
// inline popovers (which broke the composer layout and could not express the
// levelled/tiered system). The rail keeps showing badges; tapping one opens
// this dialog scrolled to that dimension.
//
// Ground rules, inherited from the rail model:
//  - Every change applies IMMEDIATELY through `onPin` (house rule: no Save
//    buttons; the host persists). Closing the dialog never discards anything.
//  - An "Automatic" row says what runs INSTEAD, never just "clear".
//  - Duty and flow are ONE question asked from two ends: pinning a duty clears
//    the flow pin and vice versa (the 2026-08-07 merge) — the sections say so.
//  - A pinned tier decides the execution, so the execution section disables
//    itself under a tier pin instead of offering controls that would be
//    overridden silently.

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Serialize an ON set (phases beyond the plan), catalog-ordered for stability. */
export function joinPhasesOn(on: string[], catalogOrder: string[]): string | null {
  const set = new Set(on);
  const ordered = catalogOrder.filter((p) => set.has(p));
  for (const p of on) if (!catalogOrder.includes(p)) ordered.push(p);
  return ordered.length ? ordered.join(",") : null;
}

/** The plan the phases section edits against: the pinned flow's, else the
 *  default flow's. Null when the options carry no usable plan. */
export function resolvedPlanForPins(
  options: RailOptions | null | undefined,
  pins: TurnRouting | null | undefined
): { flowId: string; phases: string[]; pinned: boolean } | null {
  const flows = options?.flows ?? [];
  const pinnedFlow = str(pinnedValue(pins, "flow"));
  const flowId = pinnedFlow || str(options?.defaultFlow);
  if (!flowId) return null;
  const flow = flows.find((f) => str(f.id) === flowId);
  if (!flow) return null;
  const phases = (flow.phases ?? []).map((p) => str(p)).filter(Boolean);
  return { flowId, phases, pinned: Boolean(pinnedFlow) };
}

/** Distinct runtimes across the targets, insertion-ordered — the execution
 *  section's grouping. */
export function runtimeGroups(options: RailOptions | null | undefined) {
  const groups = new Map<string, NonNullable<RailOptions["targets"]>>();
  for (const t of options?.targets ?? []) {
    const runtime = str(t.runtime) || "other";
    if (!groups.has(runtime)) groups.set(runtime, []);
    groups.get(runtime)!.push(t);
  }
  return groups;
}

const EVERY_PIN_CLEARED: PinPatch = {
  duty: null, level: null, tier: null, target: null, model: null,
  effort: null, account: null, project: null, flow: null,
  phasesOff: null, phasesOn: null,
};

export interface RoutingModalProps {
  pins?: TurnRouting | null;
  options?: RailOptions | null;
  onPin: (patch: PinPatch) => void;
  onClose: () => void;
  /** Scroll this dimension's section into view on open. */
  focusField?: PinField | null;
  musterUrl?: string | null;
}

/** One selectable row (radio semantics within its section). */
function Row({
  label, detail, selected, disabled, onPick,
}: {
  label: string;
  detail?: string | null;
  selected?: boolean;
  disabled?: boolean;
  onPick?: () => void;
}) {
  return (
    <button
      type="button"
      className={`cc-rm-row${selected ? " cc-rm-row-sel" : ""}`}
      disabled={disabled}
      onClick={onPick}
      role="radio"
      aria-checked={selected ?? false}
    >
      <span className="cc-rm-row-dot" aria-hidden />
      <span className="cc-rm-row-main">
        <span className="cc-rm-row-label">{label}</span>
        {detail ? <span className="cc-rm-row-detail">{detail}</span> : null}
      </span>
    </button>
  );
}

function Section({
  id, title, hint, pinnedNote, children, refFn, disabled, disabledNote,
}: {
  id: string;
  title: string;
  hint?: string;
  pinnedNote?: string | null;
  children: React.ReactNode;
  refFn?: (el: HTMLElement | null) => void;
  disabled?: boolean;
  disabledNote?: string | null;
}) {
  return (
    <section className={`cc-rm-section${disabled ? " cc-rm-section-off" : ""}`} data-section={id} ref={refFn}>
      <header className="cc-rm-sechead">
        <h3>{title}</h3>
        {pinnedNote ? <span className="cc-rm-pinned">{pinnedNote}</span> : null}
      </header>
      {hint ? <p className="cc-rm-hint">{hint}</p> : null}
      {disabled && disabledNote ? <p className="cc-rm-gate">{disabledNote}</p> : null}
      <div className="cc-rm-rows" role="radiogroup" aria-label={title} aria-disabled={disabled ?? false}>
        {children}
      </div>
    </section>
  );
}

export function RoutingModal({ pins, options, onPin, onClose, focusField, musterUrl }: RoutingModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const [projectQuery, setProjectQuery] = useState("");
  const [modelDraft, setModelDraft] = useState(str(pinnedValue(pins, "model")));

  // Esc closes; the backdrop click closes; focus starts on the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Field → section mapping for the "opened from a badge" scroll.
  useEffect(() => {
    if (!focusField) return;
    const sectionOf: Partial<Record<PinField, string>> = {
      duty: "work", level: "work", tier: "tier",
      target: "execution", model: "execution", effort: "execution",
      account: "account", project: "project",
      flow: "flow", phasesOff: "phases", phasesOn: "phases",
    };
    const el = sectionRefs.current[sectionOf[focusField] ?? "work"];
    el?.scrollIntoView({ block: "start" });
  }, [focusField]);

  const duty = str(pinnedValue(pins, "duty"));
  const level = pinnedValue(pins, "level");
  const tier = str(pinnedValue(pins, "tier"));
  const target = str(pinnedValue(pins, "target"));
  const model = str(pinnedValue(pins, "model"));
  const effort = str(pinnedValue(pins, "effort"));
  const account = pins?.account === null ? null : str(pinnedValue(pins, "account")) || null;
  const project = str(pinnedValue(pins, "project"));
  const flowPin = str(pinnedValue(pins, "flow"));

  const anyPin = Boolean(
    duty || level || tier || target || model || effort || account || project ||
    flowPin || str(pinnedValue(pins, "phasesOff")) || str(pinnedValue(pins, "phasesOn"))
  );

  const dutyOptions = options?.duties ?? [];
  const selectedDuty = dutyOptions.find((d) => str(d.id) === duty) ?? null;
  const groups = useMemo(() => runtimeGroups(options), [options]);
  const plan = useMemo(() => resolvedPlanForPins(options, pins), [options, pins]);
  const phasesOff = useMemo(() => splitPhasesOff(pinnedValue(pins, "phasesOff")), [pins]);
  const phasesOn = useMemo(() => splitPhasesOff(pinnedValue(pins, "phasesOn")), [pins]);
  const catalog = (options?.phaseCatalog ?? []).map((p) => str(p)).filter(Boolean);
  const beyondPlan = catalog.filter((p) => !(plan?.phases ?? []).includes(p));

  const sectionRef = useCallback((id: string) => (el: HTMLElement | null) => {
    sectionRefs.current[id] = el;
  }, []);

  const togglePlanPhase = useCallback((id: string) => {
    const next = phasesOff.includes(id) ? phasesOff.filter((p) => p !== id) : [...phasesOff, id];
    onPin({ phasesOff: joinPhasesOff(next, plan?.phases ?? []) });
  }, [phasesOff, plan, onPin]);

  const toggleExtraPhase = useCallback((id: string) => {
    const next = phasesOn.includes(id) ? phasesOn.filter((p) => p !== id) : [...phasesOn, id];
    onPin({ phasesOn: joinPhasesOn(next, catalog) });
  }, [phasesOn, catalog, onPin]);

  const applyModelDraft = useCallback(() => {
    const value = modelDraft.trim();
    if (value === model) return;
    onPin({ model: value || null });
  }, [modelDraft, model, onPin]);

  const tierGated = Boolean(tier);
  const effortBlocked = str(options?.unavailable?.effort);
  const projects = (options?.projects ?? []).filter((p) =>
    !projectQuery.trim() || p.toLowerCase().includes(projectQuery.trim().toLowerCase())
  );

  return (
    <div className="cc-rm-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cc-rm" role="dialog" aria-modal="true" aria-label="Turn routing" tabIndex={-1} ref={dialogRef}>
        <header className="cc-rm-head">
          <div>
            <h2>Turn routing</h2>
            <p>
              Pins apply to the next message in this conversation and stay in force
              until cleared. Everything saves as you tap.
            </p>
          </div>
          <button type="button" className="cc-rm-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="cc-rm-body">
          <Section
            id="work"
            title="Duty & level"
            refFn={sectionRef("work")}
            hint="What kind of work the next message is. The router infers this when automatic; pinning skips the classifier. Pinning a duty releases a pinned flow — they answer the same question."
            pinnedNote={duty ? `pinned: ${duty}${level ? ` L${level}` : ""}` : null}
          >
            <Row
              label="Automatic"
              detail="Routing inference reads the message and picks the duty and level."
              selected={!duty && !flowPin}
              onPick={() => onPin({ duty: null, level: null, flow: null, phasesOff: null, phasesOn: null })}
            />
            {dutyOptions.map((d) => {
              const id = str(d.id);
              if (!id) return null;
              return (
                <Row
                  key={id}
                  label={str(d.title) || id}
                  detail={id !== str(d.title) ? id : null}
                  selected={duty === id}
                  onPick={() => onPin({ duty: id, level: null, flow: null, phasesOff: null, phasesOn: null })}
                />
              );
            })}
            {selectedDuty && (selectedDuty.levels ?? []).length > 0 ? (
              <div className="cc-rm-levels">
                <span className="cc-rm-levels-title">Level</span>
                <Row
                  label="Automatic"
                  detail="The router picks the level from the message."
                  selected={level === null}
                  onPick={() => onPin({ level: null })}
                />
                {(selectedDuty.levels ?? []).map((l) =>
                  typeof l?.n === "number" && l.n > 0 ? (
                    <Row
                      key={l.n}
                      label={`L${l.n}`}
                      detail={str(l.description) || null}
                      selected={level === Math.trunc(l.n)}
                      onPick={() => onPin({ level: Math.trunc(l.n) })}
                    />
                  ) : null
                )}
              </div>
            ) : null}
          </Section>

          <Section
            id="tier"
            title="Tier"
            refFn={sectionRef("tier")}
            hint="The compute tier the routing matrix is keyed on. A pinned tier decides the execution — runtime, model, and effort come from the duty×tier cell, so those controls disable below."
            pinnedNote={tier ? `pinned: ${tier}` : null}
          >
            <Row
              label="Automatic"
              detail="Routing inference weighs the message and picks the tier."
              selected={!tier}
              onPick={() => onPin({ tier: null })}
            />
            {(options?.tiers ?? []).map((t) => (
              <Row
                key={t}
                label={t}
                detail={str(options?.tierDefinitions?.[t]) || null}
                selected={tier === t}
                onPick={() => onPin({ tier: t })}
              />
            ))}
          </Section>

          <Section
            id="execution"
            title="Execution — runtime, model, effort"
            refFn={sectionRef("execution")}
            hint="Which engine runs the message. Picking a target pins the coherent runtime+model pair; the model box overlays a different model id onto the resolved target."
            disabled={tierGated}
            disabledNote={`The pinned tier (${tier}) decides the execution. Clear the tier to pin these manually.`}
            pinnedNote={target || model || effort ? `pinned: ${[target, model, effort].filter(Boolean).join(" · ")}` : null}
          >
            <Row
              label="Automatic"
              detail="The composition's routing picks the target."
              selected={!target}
              disabled={tierGated}
              onPick={() => onPin({ target: null, model: null })}
            />
            {[...groups.entries()].map(([runtime, targets]) => (
              <div className="cc-rm-group" key={runtime}>
                <span className="cc-rm-group-title">{runtime}</span>
                {(targets ?? []).map((t) => {
                  const id = str(t.id);
                  if (!id) return null;
                  const detail = [str(t.model), str(t.effort) && `effort ${str(t.effort)}`, str(t.account)]
                    .filter(Boolean).join(" · ");
                  return (
                    <Row
                      key={id}
                      label={id}
                      detail={detail || null}
                      selected={target === id}
                      disabled={tierGated}
                      onPick={() => onPin({ target: id, model: null })}
                    />
                  );
                })}
              </div>
            ))}
            <label className="cc-rm-model">
              <span>Model override</span>
              <input
                type="text"
                value={modelDraft}
                disabled={tierGated}
                placeholder="exact model id (overlays the resolved target)"
                onChange={(e) => setModelDraft(e.target.value)}
                onBlur={applyModelDraft}
                onKeyDown={(e) => { if (e.key === "Enter") applyModelDraft(); }}
              />
            </label>
            <div className="cc-rm-group">
              <span className="cc-rm-group-title">effort</span>
              {effortBlocked ? <p className="cc-rm-gate">{effortBlocked}</p> : null}
              <div className="cc-rm-seg" role="radiogroup" aria-label="Effort">
                <button
                  type="button"
                  className={`cc-rm-segbtn${!effort ? " cc-rm-segbtn-sel" : ""}`}
                  disabled={tierGated || Boolean(effortBlocked)}
                  onClick={() => onPin({ effort: null })}
                >auto</button>
                {(options?.efforts ?? []).map((e) => (
                  <button
                    key={e}
                    type="button"
                    className={`cc-rm-segbtn${effort === e ? " cc-rm-segbtn-sel" : ""}`}
                    disabled={tierGated || Boolean(effortBlocked)}
                    onClick={() => onPin({ effort: e })}
                  >{e}</button>
                ))}
              </div>
            </div>
          </Section>

          <Section
            id="account"
            title="Account"
            refFn={sectionRef("account")}
            hint="The named runtime account the turn authenticates as. Only meaningful for targets whose platform matches — a mismatched pin is refused at the edge, with the reason on the badge."
            pinnedNote={account ? `pinned: ${account}` : null}
          >
            <Row
              label="Automatic"
              detail="The composition's account (or the machine's own login)."
              selected={!account}
              onPick={() => onPin({ account: null })}
            />
            {(options?.accounts ?? []).map((a) => (
              <Row
                key={a.name}
                label={a.name}
                detail={str(a.platform) ? `platform: ${a.platform}` : null}
                selected={account === a.name}
                onPick={() => onPin({ account: a.name })}
              />
            ))}
          </Section>

          <Section
            id="project"
            title="Project"
            refFn={sectionRef("project")}
            hint="The repository the turn runs in (its working directory). Sticky: new conversations start with your last pinned project until you clear it."
            pinnedNote={project ? `pinned: ${project}` : null}
          >
            <input
              className="cc-rm-filter"
              type="search"
              placeholder="Filter projects…"
              value={projectQuery}
              onChange={(e) => setProjectQuery(e.target.value)}
            />
            <Row
              label="Automatic"
              detail="The operative's own directory."
              selected={!project}
              onPick={() => onPin({ project: null })}
            />
            {projects.map((p) => (
              <Row key={p} label={p} selected={project === p} onPick={() => onPin({ project: p })} />
            ))}
          </Section>

          <Section
            id="flow"
            title="Flow"
            refFn={sectionRef("flow")}
            hint="The phase plan for work that becomes a card. Automatic derives the flow from the routed duty (its level picks the plan). Pinning a flow releases a pinned duty — same one question, asked from the plan end."
            pinnedNote={flowPin ? `pinned: ${flowPin}` : null}
          >
            <Row
              label={str(options?.defaultFlow) ? `Automatic (default: ${options?.defaultFlow})` : "Automatic"}
              detail="The router derives the flow from the duty; the flow's level defines the plan."
              selected={!flowPin}
              onPick={() => onPin({ flow: null, duty: duty ? duty : null, phasesOff: null, phasesOn: null })}
            />
            {(options?.flows ?? []).map((f) => {
              const id = str(f.id);
              if (!id) return null;
              const phases = (f.phases ?? []).map((p) => str(p)).filter(Boolean);
              return (
                <Row
                  key={id}
                  label={id}
                  detail={[str(f.description), phases.length ? `plan: ${phases.join(" → ")}` : ""]
                    .filter(Boolean).join(" — ") || null}
                  selected={flowPin === id}
                  onPick={() => onPin({ flow: id, duty: null, level: null, phasesOff: null, phasesOn: null })}
                />
              );
            })}
          </Section>

          <Section
            id="phases"
            title="Phases"
            refFn={sectionRef("phases")}
            hint={plan
              ? `Toggles against the ${plan.pinned ? "pinned" : "default"} flow's plan (${plan.flowId}). Unchecking a plan phase skips it; the second list adds phases the plan does not carry. A phase both added and skipped stays off.`
              : "No resolved plan to toggle against — pin a flow (or set a default flow in the policy) first."}
          >
            {plan ? (
              <>
                {plan.phases.map((p) => (
                  <label className="cc-rm-check" key={p}>
                    <input
                      type="checkbox"
                      checked={!phasesOff.includes(p)}
                      onChange={() => togglePlanPhase(p)}
                    />
                    <span>{p}</span>
                  </label>
                ))}
                {beyondPlan.length ? (
                  <div className="cc-rm-group">
                    <span className="cc-rm-group-title">beyond the plan</span>
                    {beyondPlan.map((p) => (
                      <label className="cc-rm-check" key={p}>
                        <input
                          type="checkbox"
                          checked={phasesOn.includes(p)}
                          onChange={() => toggleExtraPhase(p)}
                        />
                        <span>{p}</span>
                      </label>
                    ))}
                  </div>
                ) : null}
              </>
            ) : null}
          </Section>
        </div>

        <footer className="cc-rm-foot">
          {musterUrl ? (
            <a href={musterUrl} target="_blank" rel="noreferrer" className="cc-rm-muster">
              Composition defaults live in Muster
            </a>
          ) : <span />}
          <div className="cc-rm-foot-actions">
            <button
              type="button"
              className="cc-rm-clear"
              disabled={!anyPin}
              onClick={() => onPin(EVERY_PIN_CLEARED)}
            >
              Clear all pins
            </button>
            <button type="button" className="cc-rm-done" onClick={onClose}>Done</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
