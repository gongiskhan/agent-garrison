// tour-machine.ts — the pure step-advance state machine shared by both tour
// players. The DEMO player calls advance() on a timer after each step's hold;
// the GUIDED player calls advance() only once a step's assert passes (or Skip is
// pressed). Keeping it pure (no DOM, no React) makes the advance logic directly
// unit-testable in the node test env.
import type { TourStep } from "./metadata";
import { evaluateAssert, type AssertContext } from "./tour-selector";

export type TourStatus = "running" | "complete";

export interface TourState {
  index: number;
  total: number;
  status: TourStatus;
}

export function initTour(total: number): TourState {
  return { index: 0, total, status: total > 0 ? "running" : "complete" };
}

// Move to the next step, or mark the tour complete when the last step is done.
// On complete the index stays clamped to the final step so the overlay can keep
// showing it for the closing beat.
export function advanceTour(state: TourState): TourState {
  if (state.status === "complete") return state;
  const next = state.index + 1;
  if (next >= state.total) {
    return { ...state, index: Math.max(0, state.total - 1), status: "complete" };
  }
  return { ...state, index: next, status: "running" };
}

export function isComplete(state: TourState): boolean {
  return state.status === "complete";
}

export function currentStep<T extends TourStep>(steps: T[], state: TourState): T | undefined {
  return steps[state.index];
}

// The DEMO player advances automatically; the GUIDED player waits for the user.
// A step with an action or with no assert is "auto" (the user isn't gated on an
// assertion) — the engine uses this to decide whether to show a Continue/Skip
// affordance.
export function stepIsAssertGated(step: TourStep): boolean {
  return Boolean(step.assert);
}

// --- DEMO player decision logic --------------------------------------------

export interface DemoStepPlan {
  acts: boolean;
  actionType?: NonNullable<TourStep["action"]>["type"];
  navigatePath?: string;
}

// What the DEMO player will do for a step: perform its action (if any). The
// engine reads this to decide whether to fire performAction / router.push.
export function planDemoStep(step: TourStep): DemoStepPlan {
  if (!step.action) return { acts: false };
  return {
    acts: true,
    actionType: step.action.type,
    navigatePath: step.action.type === "navigate" ? step.action.path : undefined
  };
}

// A synchronous, clock-free simulation of the DEMO player used in tests: for
// each step it "visits" (spotlight) and, if the step has an element action,
// resolves the target and performs it. Returns the ordered record. The real
// engine mirrors this with timers between steps; keeping the decision logic
// here makes it directly testable without a DOM.
export interface DemoDrivers {
  resolve: (selector: string) => unknown | null;
  perform: (element: unknown, action: NonNullable<TourStep["action"]>) => void;
  navigate?: (path: string) => void;
}

export function runDemoSequence(
  steps: TourStep[],
  drivers: DemoDrivers
): { visited: string[]; performed: Array<{ stepId: string; type: string }> } {
  const visited: string[] = [];
  const performed: Array<{ stepId: string; type: string }> = [];
  let state = initTour(steps.length);
  while (!isComplete(state)) {
    const step = steps[state.index];
    visited.push(step.id);
    const plan = planDemoStep(step);
    if (plan.acts && step.action) {
      if (plan.actionType === "navigate" && plan.navigatePath) {
        drivers.navigate?.(plan.navigatePath);
      } else {
        const el = drivers.resolve(step.selector);
        if (el) {
          drivers.perform(el, step.action);
          performed.push({ stepId: step.id, type: step.action.type });
        }
      }
    }
    state = advanceTour(state);
  }
  // The final step is visited on completion too (the closing beat).
  const last = steps[state.index];
  if (last && visited[visited.length - 1] !== last.id) visited.push(last.id);
  return { visited, performed };
}

// --- GUIDED player decision logic ------------------------------------------

// Whether the GUIDED player should advance now: only assert-gated steps auto
// advance, and only once their assert passes against the current DOM/route.
// Assert-less (informational) steps return false — the user advances them with
// the Continue control.
export function shouldGuidedAdvance(step: TourStep, ctx: AssertContext = {}): boolean {
  if (!step.assert) return false;
  return evaluateAssert(step.assert, ctx);
}
