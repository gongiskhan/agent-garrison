import type { Composition } from "./types";
import { resolveActiveComposition } from "./active-composition";
import { readHomesState } from "./homes-migration";
import { readSharedState, selectedSharedSet } from "./home-ownership";
import { reconcileShared } from "./shared-fittings";
import { checkHomeLeaks } from "./home-leaks";

// A saved selection is desired state. Legacy nodes migrate before publishing
// primitives into user config; inactive compositions apply when brought up.
export async function reconcileSavedSharing(composition: Composition): Promise<void> {
  if ((await readHomesState())?.version !== 2) return;
  if ((await resolveActiveComposition()).id !== composition.id) return;
  const desired = selectedSharedSet(composition.selections);
  const previous = (await readSharedState()).byRuntime;
  const signature = (value: typeof desired) => JSON.stringify(Object.entries(value).map(([runtime, ids]) => [runtime, [...ids].sort()]));
  if (signature(desired) === signature(previous)) return;
  await reconcileShared(composition);
  await checkHomeLeaks();
}
