import { readActiveConfig } from "./active-composition";
import { resolveCapabilities, type ResolverInput } from "./capabilities";
import { readComposition, selectedLibraryEntries } from "./compositions";
import { scopedSecretsViaAuthority } from "./composition-sync";
import { StateApiError, StateUnavailableError } from "./state-client";
import { vaultStatus } from "./vault";

// The voice layer's two shell-side facts (docs/decisions/2026-09-garrison-app.md
// D22/D23): WHICH fitting provides `kind: voice` in the active composition, and
// the capture token that gates its /stt and /tts. Neither is a constant: the
// provider is a composition choice read off the capability graph, and the token
// is read from this node's secret source on every request (unavailable = null,
// never a cached copy). The talk router receives both as callbacks; the runner
// projects the provider id into every own-port fitting that consumes voice.

export const CAPTURE_TOKEN_SECRET = "CAPTURE_TOKEN";
export const VOICE_FITTING_ID_ENV = "GARRISON_VOICE_FITTING_ID";

// The one fitting providing `kind: voice` among the selected entries, or null
// when none does. `voice` is a singleton kind, so two providers is a resolver
// error up() refuses; here that ambiguity reads as "no provider" rather than a
// coin toss between the two.
export function voiceProviderIdFor(entries: readonly ResolverInput[]): string | null {
  const { graph } = resolveCapabilities([...entries]);
  const ids = new Set((graph.providers.get("voice") ?? []).map((node) => node.fittingId));
  if (ids.size !== 1) return null;
  const [id] = ids;
  return id;
}

// The env projection for ONE fitting: GARRISON_VOICE_FITTING_ID when the fitting
// consumes `kind: voice` and a provider is stationed; nothing otherwise. Both
// runner paths (up() and the manual start/restart) call this same helper so the
// heal fingerprint cannot drift between them, and swapping the provider is an
// env change that restarts its consumers.
export function voiceEnvForEntry(
  entry: ResolverInput,
  providerId: string | null
): Record<string, string> {
  if (!providerId) return {};
  const consumesVoice = entry.metadata.consumes.some((c) => c.kind === "voice");
  return consumesVoice ? { [VOICE_FITTING_ID_ENV]: providerId } : {};
}

// The active composition's voice provider. Best-effort: an unreadable
// composition or library is "no provider", never a throw - the voice surface
// degrades to unavailable, the request that asked still answers.
export async function voiceProviderId(): Promise<string | null> {
  try {
    const compositionId = (await readActiveConfig()).active_composition;
    const composition = await readComposition(compositionId);
    const entries = await selectedLibraryEntries(composition.selections);
    return voiceProviderIdFor(entries.map((entry) => ({ id: entry.id, metadata: entry.metadata })));
  } catch {
    return null;
  }
}

// Why the capture token could not be read, in the talk router's operator-facing
// words (packages/talk/src/router.mjs exports the same strings; the router test
// pins the two sets against each other). Each names a different fix.
export const VOICE_LOCKED = "voice locked";
export const VOICE_TOKEN_UNSET = "capture token not sealed";
export const VOICE_TOKEN_DENIED = "capture token not granted to this node";
export const VOICE_SECRETS_UNREACHABLE = "secret authority unreachable";
export type VoiceTokenReason =
  | typeof VOICE_LOCKED
  | typeof VOICE_TOKEN_UNSET
  | typeof VOICE_TOKEN_DENIED
  | typeof VOICE_SECRETS_UNREACHABLE;

export interface VoiceTokenRead {
  token: string | null;
  // Set exactly when `token` is null.
  reason: VoiceTokenReason | null;
}

// The capture token from this node's secret source (D31): the mesh secret
// authority on an enrolled node, the local vault on a standalone box. The same
// seam the runner hands own-port fittings their secrets through, so the shell
// and capture-service cannot disagree about which CAPTURE_TOKEN is in force.
// Read per request and never cached: an unlock, a grant or a reseal is seen on
// the next call. The value goes to the router's upstream Bearer header only.
export async function readCaptureToken(): Promise<VoiceTokenRead> {
  try {
    const out = await scopedSecretsViaAuthority([CAPTURE_TOKEN_SECRET]);
    const token = out.values[CAPTURE_TOKEN_SECRET] ?? "";
    return token.length > 0 ? { token, reason: null } : { token: null, reason: VOICE_TOKEN_UNSET };
  } catch (err) {
    if (err instanceof StateApiError && err.status === 403) return { token: null, reason: VOICE_TOKEN_DENIED };
    if (err instanceof StateUnavailableError) return { token: null, reason: VOICE_SECRETS_UNREACHABLE };
    // The local vault threw: locked is the one failure it names; anything else
    // reads as the token not being there, the historical meaning.
    return { token: null, reason: vaultStatus().unlocked ? VOICE_TOKEN_UNSET : VOICE_LOCKED };
  }
}

export async function voiceToken(): Promise<string | null> {
  return (await readCaptureToken()).token;
}

// Why voiceToken() came back null. The router asks this only after the token
// read failed; it reads again rather than remembering, so the answer describes
// the source as it is now (an auto-unlock the failed read attempted included).
export async function voiceTokenReason(): Promise<VoiceTokenReason> {
  return (await readCaptureToken()).reason ?? VOICE_TOKEN_UNSET;
}
