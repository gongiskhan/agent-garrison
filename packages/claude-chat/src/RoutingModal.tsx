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

// The routing console — the pin EDITOR for a conversation. A master–detail
// dialog: the left strip is the whole routing state at a glance (every
// dimension with its live value), the right pane edits one dimension at a
// time with room for real descriptions. Supersedes the rail's inline
// popovers, which broke the composer layout and could not express the
// levelled/tiered system.
//
// Ground rules, inherited from the rail model:
//  - Every change applies IMMEDIATELY through `onPin` (house rule: no Save
//    buttons; the host persists). Closing the dialog never discards anything.
//  - An "Automatic" row says what runs INSTEAD, never just "clear".
//  - Duty and flow are ONE question asked from two ends: pinning one releases
//    the other, and both sections say so.
//  - A pinned tier decides the execution; the execution pane replaces its
//    controls with the reason and an inline release, never a silent override.

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

type SectionId = "work" | "tier" | "execution" | "account" | "project" | "flow" | "phases";

const SECTION_OF_FIELD: Partial<Record<PinField, SectionId>> = {
  duty: "work", level: "work", tier: "tier",
  target: "execution", model: "execution", effort: "execution",
  account: "account", project: "project",
  flow: "flow", phasesOff: "phases", phasesOn: "phases",
};

/** The inverse of SECTION_OF_FIELD — which pins a section speaks for. */
const FIELDS_OF_SECTION: Record<SectionId, PinField[]> = {
  work: ["duty", "level"],
  tier: ["tier"],
  execution: ["target", "model", "effort"],
  account: ["account"],
  project: ["project"],
  flow: ["flow"],
  phases: ["phasesOff", "phasesOn"],
};

/**
 * Why a whole section cannot be edited right now, or "" when it can.
 *
 * A dimension can be spoken for: the host owns it (the Kanban board decides a
 * card's working directory through the card's own Project field, so a second
 * picker here would silently WIN), or its vocabulary is unreachable. A section
 * whose EVERY field carries a reason offers that reason instead of controls
 * that would be refused. A section only PARTLY blocked keeps its own inline
 * gate — which is how `effort` alone has always behaved, and must keep behaving.
 */
export function blockedSection(options: RailOptions | null | undefined, id: SectionId): string {
  const fields = FIELDS_OF_SECTION[id];
  const reasons = fields.map((f) => str(options?.unavailable?.[f])).filter(Boolean);
  return reasons.length === fields.length ? reasons[0] : "";
}

export interface RoutingModalProps {
  pins?: TurnRouting | null;
  options?: RailOptions | null;
  onPin: (patch: PinPatch) => void;
  onClose: () => void;
  /** Open on this dimension's section. */
  focusField?: PinField | null;
  musterUrl?: string | null;
}

function LockGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" className="cc-rm-lock">
      <rect x="2.2" y="5" width="7.6" height="5.4" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4 5V3.8a2 2 0 0 1 4 0V5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/** One selectable option (radio semantics within its pane). */
function Opt({
  label, detail, mono, selected, disabled, onPick,
}: {
  label: string;
  detail?: string | null;
  mono?: boolean;
  selected?: boolean;
  disabled?: boolean;
  onPick?: () => void;
}) {
  return (
    <button
      type="button"
      className={`cc-rm-opt${selected ? " cc-rm-opt-sel" : ""}`}
      disabled={disabled}
      onClick={onPick}
      role="radio"
      aria-checked={selected ?? false}
    >
      <span className={`cc-rm-opt-label${mono ? " cc-rm-mono" : ""}`}>{label}</span>
      {detail ? <span className="cc-rm-opt-detail">{detail}</span> : null}
    </button>
  );
}

export function RoutingModal({ pins, options, onPin, onClose, focusField, musterUrl }: RoutingModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState<SectionId>(
    (focusField && SECTION_OF_FIELD[focusField]) || "work"
  );
  const [projectQuery, setProjectQuery] = useState("");
  const [modelDraft, setModelDraft] = useState(str(pinnedValue(pins, "model")));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const duty = str(pinnedValue(pins, "duty"));
  const level = pinnedValue(pins, "level");
  const tier = str(pinnedValue(pins, "tier"));
  const target = str(pinnedValue(pins, "target"));
  const model = str(pinnedValue(pins, "model"));
  const effort = str(pinnedValue(pins, "effort"));
  const account = str(pinnedValue(pins, "account"));
  const project = str(pinnedValue(pins, "project"));
  const flowPin = str(pinnedValue(pins, "flow"));
  const phasesOff = useMemo(() => splitPhasesOff(pinnedValue(pins, "phasesOff")), [pins]);
  const phasesOn = useMemo(() => splitPhasesOff(pinnedValue(pins, "phasesOn")), [pins]);

  const dutyOptions = options?.duties ?? [];
  const selectedDuty = dutyOptions.find((d) => str(d.id) === duty) ?? null;
  const groups = useMemo(() => runtimeGroups(options), [options]);
  const plan = useMemo(() => resolvedPlanForPins(options, pins), [options, pins]);
  const catalog = (options?.phaseCatalog ?? []).map((p) => str(p)).filter(Boolean);
  const beyondPlan = catalog.filter((p) => !(plan?.phases ?? []).includes(p));
  const tierGated = Boolean(tier);
  const effortBlocked = str(options?.unavailable?.effort);
  const sectionBlocked = useCallback((id: SectionId) => blockedSection(options, id), [options]);
  const projects = (options?.projects ?? []).filter((p) =>
    !projectQuery.trim() || p.toLowerCase().includes(projectQuery.trim().toLowerCase())
  );

  // The header's pinned-chip strip: every pin in force, each removable.
  const pinChips = useMemo(() => {
    const chips: { key: string; label: string; patch: PinPatch }[] = [];
    if (duty) chips.push({ key: "duty", label: `${duty}${level ? ` L${level}` : ""}`, patch: { duty: null, level: null } });
    if (tier) chips.push({ key: "tier", label: tier, patch: { tier: null } });
    if (target) chips.push({ key: "target", label: target, patch: { target: null } });
    if (model) chips.push({ key: "model", label: model, patch: { model: null } });
    if (effort) chips.push({ key: "effort", label: `effort ${effort}`, patch: { effort: null } });
    if (account) chips.push({ key: "account", label: account, patch: { account: null } });
    if (project) chips.push({ key: "project", label: project, patch: { project: null } });
    if (flowPin) chips.push({ key: "flow", label: `flow ${flowPin}`, patch: { flow: null } });
    if (phasesOff.length) chips.push({ key: "phasesOff", label: `-${phasesOff.length} phase${phasesOff.length > 1 ? "s" : ""}`, patch: { phasesOff: null } });
    if (phasesOn.length) chips.push({ key: "phasesOn", label: `+${phasesOn.length} phase${phasesOn.length > 1 ? "s" : ""}`, patch: { phasesOn: null } });
    return chips;
  }, [duty, level, tier, target, model, effort, account, project, flowPin, phasesOff, phasesOn]);

  const navValue: Record<SectionId, { value: string; pinned: boolean; gated?: boolean }> = {
    work: { value: duty ? `${duty}${level ? ` L${level}` : ""}` : "auto", pinned: Boolean(duty) },
    tier: { value: tier || "auto", pinned: Boolean(tier) },
    execution: tierGated
      ? { value: "tier-decided", pinned: false, gated: true }
      : {
          value: [target, model, effort].filter(Boolean).join(" · ") || "auto",
          pinned: Boolean(target || model || effort),
        },
    account: { value: account || "auto", pinned: Boolean(account) },
    project: { value: project || "auto", pinned: Boolean(project) },
    flow: { value: flowPin || (str(options?.defaultFlow) ? `auto · ${options?.defaultFlow}` : "auto"), pinned: Boolean(flowPin) },
    phases: {
      value: phasesOff.length || phasesOn.length
        ? [phasesOff.length ? `-${phasesOff.length}` : "", phasesOn.length ? `+${phasesOn.length}` : ""].filter(Boolean).join(" ")
        : "plan",
      pinned: Boolean(phasesOff.length || phasesOn.length),
    },
  };
  // A section that is spoken for wears the lock in the nav too, so the reason is
  // discoverable without opening the pane to find an explanation.
  for (const id of Object.keys(navValue) as SectionId[]) {
    if (sectionBlocked(id)) navValue[id] = { ...navValue[id], gated: true };
  }

  const NAV: { id: SectionId; label: string }[] = [
    { id: "work", label: "Duty & level" },
    { id: "tier", label: "Tier" },
    { id: "execution", label: "Execution" },
    { id: "account", label: "Account" },
    { id: "project", label: "Project" },
    { id: "flow", label: "Flow" },
    { id: "phases", label: "Phases" },
  ];

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

  const hint = (text: string) => <p className="cc-rm-hint">{text}</p>;

  const detail = (() => {
    const blocked = sectionBlocked(active);
    if (blocked) {
      // The project section is blocked BY DESIGN once the card owns the working
      // directory — but a card can still carry a leftover `routing.project` pin
      // (set before the card had its own Project field, or set directly on the
      // wire) that this same block then makes impossible to release. Offer the
      // same "gate card + clear button" the tier-gated execution pane uses,
      // rather than replacing the whole pane with an inert message.
      if (active === "project" && project) {
        return (
          <div className="cc-rm-pane" data-section="project">
            <div className="cc-rm-gatecard">
              <LockGlyph />
              <div>{blocked}</div>
              <button type="button" className="cc-rm-ghost" onClick={() => onPin({ project: null })}>
                Clear project pin ({project})
              </button>
            </div>
          </div>
        );
      }
      return (
        <div className="cc-rm-pane" data-section={active}>
          <p className="cc-rm-gate">{blocked}</p>
        </div>
      );
    }
    switch (active) {
      case "work":
        return (
          <div className="cc-rm-pane" data-section="work">
            {hint("What kind of work the next message is. Automatic lets routing inference read the message; pinning skips the classifier. Pinning a duty releases a pinned flow — they answer the same question.")}
            <div className="cc-rm-list" role="radiogroup" aria-label="Duty">
              <Opt
                label="Automatic"
                detail="Routing inference picks the duty and level from the message."
                selected={!duty && !flowPin}
                onPick={() => onPin({ duty: null, level: null, flow: null, phasesOff: null, phasesOn: null })}
              />
              <div className="cc-rm-grid">
                {dutyOptions.map((d) => {
                  const id = str(d.id);
                  if (!id) return null;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={duty === id}
                      className={`cc-rm-card${duty === id ? " cc-rm-card-sel" : ""}`}
                      onClick={() => onPin({ duty: id, level: null, flow: null, phasesOff: null, phasesOn: null })}
                    >
                      <span className="cc-rm-card-title">{str(d.title) || id}</span>
                      <span className="cc-rm-card-id cc-rm-mono">{id}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            {selectedDuty && (selectedDuty.levels ?? []).length > 0 ? (
              <div className="cc-rm-sub">
                <span className="cc-rm-kicker">Level</span>
                <div className="cc-rm-seg" role="radiogroup" aria-label="Level">
                  <button
                    type="button"
                    className={`cc-rm-segbtn${level === null ? " cc-rm-segbtn-sel" : ""}`}
                    onClick={() => onPin({ level: null })}
                  >auto</button>
                  {(selectedDuty.levels ?? []).map((l) =>
                    typeof l?.n === "number" && l.n > 0 ? (
                      <button
                        key={l.n}
                        type="button"
                        className={`cc-rm-segbtn${level === Math.trunc(l.n) ? " cc-rm-segbtn-sel" : ""}`}
                        onClick={() => onPin({ level: Math.trunc(l.n) })}
                      >L{l.n}</button>
                    ) : null
                  )}
                </div>
                <p className="cc-rm-leveldesc">
                  {level
                    ? str((selectedDuty.levels ?? []).find((l) => Math.trunc(l?.n ?? 0) === level)?.description) || " "
                    : "Automatic — the router weighs the message and picks the level."}
                </p>
              </div>
            ) : null}
          </div>
        );
      case "tier":
        return (
          <div className="cc-rm-pane" data-section="tier">
            {hint("The compute tier the routing matrix is keyed on. A pinned tier decides the execution — runtime, model, and effort come from the duty×tier cell.")}
            <div className="cc-rm-list" role="radiogroup" aria-label="Tier">
              <Opt
                label="Automatic"
                detail="Routing inference weighs the message and picks the tier."
                selected={!tier}
                onPick={() => onPin({ tier: null })}
              />
              {(options?.tiers ?? []).map((t) => (
                <Opt
                  key={t}
                  label={t}
                  mono
                  detail={str(options?.tierDefinitions?.[t]) || null}
                  selected={tier === t}
                  onPick={() => onPin({ tier: t })}
                />
              ))}
            </div>
          </div>
        );
      case "execution":
        return (
          <div className={`cc-rm-pane${tierGated ? " cc-rm-section-off" : ""}`} data-section="execution">
            {tierGated ? (
              <div className="cc-rm-gatecard">
                <LockGlyph />
                <div>
                  <strong>{tier}</strong> decides the execution — runtime, model, and effort come from
                  the duty×tier cell.
                </div>
                <button type="button" className="cc-rm-ghost" onClick={() => onPin({ tier: null })}>
                  Clear tier
                </button>
              </div>
            ) : (
              <>
                {hint("Which engine runs the message. A target pins the coherent runtime+model pair; the model box overlays a different model id onto it.")}
                <div className="cc-rm-list" role="radiogroup" aria-label="Target">
                  <Opt
                    label="Automatic"
                    detail="The composition's routing picks the target."
                    selected={!target}
                    onPick={() => onPin({ target: null, model: null })}
                  />
                  {[...groups.entries()].map(([runtime, targets]) => (
                    <div className="cc-rm-group" key={runtime}>
                      <span className="cc-rm-kicker">{runtime}</span>
                      {(targets ?? []).map((t) => {
                        const id = str(t.id);
                        if (!id) return null;
                        const notes = [str(t.model), str(t.effort) && `effort ${str(t.effort)}`, str(t.account)]
                          .filter(Boolean).join(" · ");
                        return (
                          <Opt
                            key={id}
                            label={id}
                            mono
                            detail={notes || null}
                            selected={target === id}
                            onPick={() => onPin({ target: id, model: null })}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
                <div className="cc-rm-sub">
                  <span className="cc-rm-kicker">Model override</span>
                  <input
                    className="cc-rm-input cc-rm-mono"
                    type="text"
                    value={modelDraft}
                    placeholder="exact model id — overlays the resolved target"
                    onChange={(e) => setModelDraft(e.target.value)}
                    onBlur={applyModelDraft}
                    onKeyDown={(e) => { if (e.key === "Enter") applyModelDraft(); }}
                  />
                </div>
                <div className="cc-rm-sub">
                  <span className="cc-rm-kicker">Effort</span>
                  {effortBlocked ? <p className="cc-rm-gate">{effortBlocked}</p> : null}
                  <div className="cc-rm-seg" role="radiogroup" aria-label="Effort">
                    <button
                      type="button"
                      className={`cc-rm-segbtn${!effort ? " cc-rm-segbtn-sel" : ""}`}
                      disabled={Boolean(effortBlocked)}
                      onClick={() => onPin({ effort: null })}
                    >auto</button>
                    {(options?.efforts ?? []).map((e) => (
                      <button
                        key={e}
                        type="button"
                        className={`cc-rm-segbtn${effort === e ? " cc-rm-segbtn-sel" : ""}`}
                        disabled={Boolean(effortBlocked)}
                        onClick={() => onPin({ effort: e })}
                      >{e}</button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        );
      case "account":
        return (
          <div className="cc-rm-pane" data-section="account">
            {hint("The named runtime account the turn authenticates as. Only meaningful for targets on a matching platform — a mismatched pin is refused at the edge, with the reason on the badge.")}
            <div className="cc-rm-list" role="radiogroup" aria-label="Account">
              <Opt
                label="Automatic"
                detail="The composition's account, or the machine's own login."
                selected={!account}
                onPick={() => onPin({ account: null })}
              />
              {(options?.accounts ?? []).map((a) => (
                <Opt
                  key={a.name}
                  label={a.name}
                  mono
                  detail={str(a.platform) ? `platform: ${a.platform}` : null}
                  selected={account === a.name}
                  onPick={() => onPin({ account: a.name })}
                />
              ))}
            </div>
          </div>
        );
      case "project":
        return (
          <div className="cc-rm-pane" data-section="project">
            {hint("The repository the turn runs in (its working directory). Sticky: new conversations start with your last pinned project until you clear it.")}
            <input
              className="cc-rm-input"
              type="search"
              placeholder="Filter projects…"
              value={projectQuery}
              onChange={(e) => setProjectQuery(e.target.value)}
            />
            <div className="cc-rm-list cc-rm-scroll" role="radiogroup" aria-label="Project">
              <Opt
                label="Automatic"
                detail="The operative's own directory."
                selected={!project}
                onPick={() => onPin({ project: null })}
              />
              <div className="cc-rm-grid cc-rm-grid-tight">
                {projects.map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={project === p}
                    className={`cc-rm-card cc-rm-card-slim${project === p ? " cc-rm-card-sel" : ""}`}
                    onClick={() => onPin({ project: p })}
                  >
                    <span className="cc-rm-card-title cc-rm-mono">{p}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      case "flow":
        return (
          <div className="cc-rm-pane" data-section="flow">
            {hint("The phase plan for work that becomes a card. Automatic derives the flow from the routed duty; its level picks the plan. Pinning a flow releases a pinned duty — same question, asked from the plan end.")}
            <div className="cc-rm-list" role="radiogroup" aria-label="Flow">
              <Opt
                label={str(options?.defaultFlow) ? `Automatic — default ${options?.defaultFlow}` : "Automatic"}
                detail="The router derives the flow from the duty; the flow's level defines the plan."
                selected={!flowPin}
                onPick={() => onPin({ flow: null, phasesOff: null, phasesOn: null })}
              />
              {(options?.flows ?? []).map((f) => {
                const id = str(f.id);
                if (!id) return null;
                const phases = (f.phases ?? []).map((p) => str(p)).filter(Boolean);
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={flowPin === id}
                    className={`cc-rm-flow${flowPin === id ? " cc-rm-flow-sel" : ""}`}
                    onClick={() => onPin({ flow: id, duty: null, level: null, phasesOff: null, phasesOn: null })}
                  >
                    <span className="cc-rm-flow-head">
                      <span className="cc-rm-mono cc-rm-flow-id">{id}</span>
                      {phases.length ? (
                        <span className="cc-rm-flow-plan cc-rm-mono">
                          {phases.join(" → ")}
                        </span>
                      ) : null}
                    </span>
                    {str(f.description) ? <span className="cc-rm-opt-detail">{f.description}</span> : null}
                  </button>
                );
              })}
            </div>
          </div>
        );
      case "phases":
        return (
          <div className="cc-rm-pane" data-section="phases">
            {plan
              ? hint(`Toggles against the ${plan.pinned ? "pinned" : "default"} flow's plan (${plan.flowId}). Tap a plan phase to skip it; tap one beyond the plan to add it. A phase both added and skipped stays off.`)
              : hint("No resolved plan to toggle against — pin a flow (or set a default flow in the policy) first.")}
            {plan ? (
              <>
                <div className="cc-rm-chips">
                  {plan.phases.map((p) => {
                    const off = phasesOff.includes(p);
                    return (
                      <button
                        key={p}
                        type="button"
                        aria-pressed={!off}
                        className={`cc-rm-phase cc-rm-mono${off ? " cc-rm-phase-off" : ""}`}
                        onClick={() => togglePlanPhase(p)}
                        title={off ? "Skipped — tap to run it" : "In the plan — tap to skip"}
                      >
                        {p}
                      </button>
                    );
                  })}
                </div>
                {beyondPlan.length ? (
                  <div className="cc-rm-sub">
                    <span className="cc-rm-kicker">Beyond the plan</span>
                    <div className="cc-rm-chips">
                      {beyondPlan.map((p) => {
                        const on = phasesOn.includes(p);
                        return (
                          <button
                            key={p}
                            type="button"
                            aria-pressed={on}
                            className={`cc-rm-phase cc-rm-phase-extra cc-rm-mono${on ? " cc-rm-phase-added" : ""}`}
                            onClick={() => toggleExtraPhase(p)}
                            title={on ? "Added — tap to remove" : "Not in the plan — tap to add"}
                          >
                            {p}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        );
    }
  })();

  return (
    <div className="cc-rm-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cc-rm" role="dialog" aria-modal="true" aria-label="Turn routing" tabIndex={-1} ref={dialogRef}>
        <header className="cc-rm-head">
          <div className="cc-rm-head-text">
            <span className="cc-rm-kicker">Routing</span>
            <h2>Where your next message runs</h2>
          </div>
          <button type="button" className="cc-rm-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="cc-rm-pins" aria-label="Pins in force">
          {pinChips.length ? (
            pinChips.map((c) => (
              <button
                key={c.key}
                type="button"
                className="cc-rm-chip cc-rm-mono"
                title="Clear this pin"
                onClick={() => onPin(c.patch)}
              >
                {c.label}
                <span className="cc-rm-chip-x" aria-hidden>×</span>
              </button>
            ))
          ) : (
            <span className="cc-rm-pins-none">Everything automatic — the router decides. Saves as you tap.</span>
          )}
        </div>

        <div className="cc-rm-split">
          <nav className="cc-rm-nav" aria-label="Routing dimensions">
            {NAV.map((n) => {
              const v = navValue[n.id];
              return (
                <button
                  key={n.id}
                  type="button"
                  className={`cc-rm-navitem${active === n.id ? " cc-rm-navitem-on" : ""}`}
                  aria-current={active === n.id ? "true" : undefined}
                  onClick={() => setActive(n.id)}
                >
                  <span className="cc-rm-navlabel">
                    {n.label}
                    {v.gated ? <LockGlyph /> : null}
                  </span>
                  <span className={`cc-rm-navvalue cc-rm-mono${v.pinned ? " cc-rm-navvalue-pin" : ""}`}>
                    {v.value}
                  </span>
                </button>
              );
            })}
          </nav>
          <div className="cc-rm-detail">{detail}</div>
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
              className="cc-rm-ghost"
              disabled={!pinChips.length}
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
