// Promoted-fittings service — the read/write surface the API + UI use.
//
// Read: join the authored catalog (`promoted-catalog.ts`) to the LIVE Quarters
// discovery (`getQuartersState`) and the setup overrides (`promoted-overrides.ts`),
// returning the Fittings grouped by faculty under their Agent/Dev tier. Reuses
// the existing discovery engine — no parallel mechanism.
//
// Write: persist edited setup instructions for one promoted Fitting (uniform
// override-store path, so the UI never clobbers a packaged seed's apm.yml that
// another session may own).

import { z } from "zod";
import { getQuartersState } from "./quarters";
import { setupStepSchema } from "./metadata";
import {
  resolvePromotedFittings,
  promotedById,
  type PromotedFittingsView
} from "./promoted-catalog";
import { readPromotedOverrides, writePromotedSetup } from "./promoted-overrides";
import type { SetupStep } from "./types";

// The editor may save zero steps (clearing), so — unlike the apm.yml `setup:`
// field, which requires a non-empty array — this accepts an empty list.
const setupStepsArraySchema = z.array(setupStepSchema);

export async function getPromotedFittingsView(): Promise<PromotedFittingsView> {
  const [model, overrides] = await Promise.all([getQuartersState(), readPromotedOverrides()]);
  return resolvePromotedFittings(model, overrides);
}

// One resolved promoted Fitting by id (merged setup + discovery presence), for
// the fitting detail view. Returns null when the id is not in the catalog.
export async function getPromotedFitting(id: string) {
  if (!promotedById.has(id)) return null;
  const view = await getPromotedFittingsView();
  return view.fittings.find((f) => f.id === id) ?? null;
}

// Validate + normalise an incoming list of setup steps from the editor against
// the shared `setupStepSchema` (one source of truth with the apm.yml parser):
// each step needs a non-empty (trimmed) command; idempotent defaults true;
// timeout_ms is a positive int when present; label is an optional non-empty
// string. Throws on a malformed step so the API returns a 400.
export function validateSetupSteps(input: unknown): SetupStep[] {
  return setupStepsArraySchema.parse(input);
}

export async function savePromotedSetup(id: string, steps: unknown): Promise<SetupStep[]> {
  if (!promotedById.has(id)) {
    throw new Error(`unknown promoted fitting: ${id}`);
  }
  const clean = validateSetupSteps(steps);
  await writePromotedSetup(id, clean);
  return clean;
}
