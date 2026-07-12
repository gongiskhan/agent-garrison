// tour-machine.ts — the pure step-advance state machine shared by both tour
// players. The DEMO player calls advance() on a timer after each step's hold;
// the GUIDED player calls advance() only once a step's assert passes (or Skip is
// pressed). Keeping it pure (no DOM, no React) makes the advance logic directly
// unit-testable in the node test env.
import type { TourStep } from "./metadata";

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
