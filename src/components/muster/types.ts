// Client-side view of the Muster model (mirrors the server payload in
// src/app/api/muster/model.ts). The resolver types are pure (no node imports),
// so they import cleanly into the client bundle; CompositionTarget is pulled as
// a type-only import (erased) from compositions.ts to avoid its fs dependency.

import type { DutyGraphError, ResolvedDuty, RuleResult } from "@/lib/resolver";
import type { CompositionTarget } from "@/lib/compositions";
import type { DutyEffort } from "@/lib/types";

export type { DutyGraphError, ResolvedDuty, RuleResult, CompositionTarget, DutyEffort };

export interface MusterCompositionRef {
  id: string;
  name: string;
}

export interface MusterModel {
  compositionId: string;
  compositionName: string;
  compositions: MusterCompositionRef[];
  duties: Record<string, ResolvedDuty>;
  selectedDuties: string[];
  targets: CompositionTarget[];
  rules: RuleResult[];
  ready: boolean;
  errors: DutyGraphError[];
}

// The handlers the container threads down to the presentational tree.
export interface MusterActions {
  armed: string | null;
  saving: boolean;
  onArm: (targetId: string) => void;
  assignCell: (dutyId: string, level: number, targetId: string) => void;
  setEffort: (dutyId: string, level: number, effort: DutyEffort) => void;
  addDuty: (dutyId: string) => void;
  removeDuty: (dutyId: string) => void;
  addLevel: (dutyId: string) => void;
  removeLevel: (dutyId: string, level: number) => void;
  describeLevel: (dutyId: string, level: number, description: string) => void;
  switchComposition: (id: string) => void;
}
