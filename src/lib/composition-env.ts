import { readActiveConfig } from "./active-composition";
import { stateEnvForProjection } from "./state-client";
import { readComposition } from "./compositions";
import { appPort, applyPortOffsetToConfig } from "./instance-profile";
import { ownPortConfigEnv } from "./own-port-lifecycle";
import { selectedLibraryEntries } from "./compositions";
import { voiceEnvForEntry, voiceProviderIdFor } from "./voice-provider";

// The ACTIVE composition's per-fitting config, profile-shifted and projected
// into spawn env — the SAME projection startOperativeBoundFittings applies.
//
// Without this a caller that cannot resolve the running composition spawned
// own-port fittings with vault env only, so each one fell back to its
// HARDCODED seed default (the 27xxx codex family). On a single-instance box
// that merely looked odd; with prod and dev running side by side it is fatal —
// prod's fittings bound codex's ports and answered for the wrong instance.
// Best-effort: a composition that cannot be read must not stop the caller, it
// just yields no projection.
async function compositionEnvById(): Promise<{
  byId: Record<string, Record<string, string>>;
  compositionId: string | null;
}> {
  try {
    const compositionId = (await readActiveConfig()).active_composition || "default";
    const composition = await readComposition(compositionId);
    // The voice-provider projection the runner applies (voiceEnvForEntry): a
    // Views Start with the operative down must hand a voice consumer the same
    // GARRISON_VOICE_FITTING_ID up() would, or the heal fingerprint differs and
    // the next up() restarts it for nothing.
    const entries = await selectedLibraryEntries(composition.selections);
    const resolverEntries = entries.map((entry) => ({ id: entry.id, metadata: entry.metadata }));
    const voiceProvider = voiceProviderIdFor(resolverEntries);
    const entryById = new Map(resolverEntries.map((entry) => [entry.id, entry]));
    const byId: Record<string, Record<string, string>> = {};
    for (const items of Object.values(composition.selections)) {
      for (const item of items ?? []) {
        const config = applyPortOffsetToConfig((item.config ?? {}) as Record<string, unknown>);
        const entry = entryById.get(item.id);
        byId[item.id] = {
          ...ownPortConfigEnv(item.id, config),
          ...(entry ? voiceEnvForEntry(entry, voiceProvider) : {}),
          GARRISON_COMPOSITION_ID: compositionId,
          GARRISON_COMPOSITION_DIR: composition.directory,
          GARRISON_BASE_URL: `http://127.0.0.1:${
            process.env.GARRISON_APP_PORT?.trim() || process.env.PORT?.trim() || String(appPort())
          }`,
          ...stateEnvForProjection()
        };
      }
    }
    return { byId, compositionId };
  } catch (error) {
    console.warn("[garrison] composition config projection unavailable:", error);
    return { byId: {}, compositionId: null };
  }
}

// The ACTIVE composition's projected env for ONE fitting, independent of
// whether an operative is running.
//
// runner.ts's operativeEnvForFitting only answers for a composition in the
// `running` state, so the Views Start/Restart routes fell back to vault-only
// env whenever the operative was down — dropping the port and every other
// config key, and leaving the fitting to guess from its own baked default.
// The active composition is on disk either way, so the config is knowable
// either way. Callers layer the richer running-composition env on top when
// there is one; this is the floor, not a replacement.
export async function activeCompositionEnvForFitting(
  fittingId: string
): Promise<Record<string, string>> {
  const { byId } = await compositionEnvById();
  return byId[fittingId] ?? {};
}
