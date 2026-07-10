// Orchestrator placement (deliverable #3, "place at birth").
//
// Front door for starting a session THROUGH the orchestrator: given a channel
// (e.g. "dev-env") and an optional explicit mode, pick the face (channel default
// — dev-env → joe — or the explicit mode), compose that mode's system prompt
// (shared voice + soul), pick the model/effort from the mode's routing bias, and
// return the spec. The Dev Env then spawns Claude Code with the composed prompt +
// model instead of a bare session. This is a live Garrison API (it does NOT
// depend on the gateway's orchestrator/soul mode being booted).
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { composeSoulPrompt } from "./souls";
import { ROOT_DIR, COMPOSITIONS_DIR } from "./paths";

// A composition id is joined into a filesystem path, so it must be a safe slug — a
// traversal-y value (path separators / "..") is rejected back to "default".
export function safeComposition(id: unknown): string {
  return typeof id === "string" && /^[a-z0-9_-]+$/i.test(id) ? id : "default";
}

// Resolve the placement config from the LIVE installed composition when it exists, so
// placement reflects the user's actual modes.json / composition-scoped routing.json
// rather than the repo seed defaults (which can diverge). Falls back to the seed when a
// piece is not installed in the named composition.
export function resolvePlacementPaths(
  composition: string,
  // Roots are injectable so the resolution logic can be exercised against controlled
  // fixtures. In production both default to the repo's real dirs; the installed-state
  // they probe (apm_modules/_local/modes, .garrison/routing.json) is local + gitignored,
  // so a test must never assert against the real COMPOSITIONS_DIR (its content varies by
  // machine — see tests/orchestrator-placement.test.ts).
  roots: { compositionsDir?: string; rootDir?: string } = {}
): { modesDir: string; routingConfigPath: string } {
  const comp = safeComposition(composition);
  const compositionsDir = roots.compositionsDir ?? COMPOSITIONS_DIR;
  const rootDir = roots.rootDir ?? ROOT_DIR;
  const compDir = path.join(compositionsDir, comp);
  const installedModes = path.join(compDir, "apm_modules", "_local", "modes");
  const scopedRouting = path.join(compDir, ".garrison", "routing.json");
  return {
    modesDir: existsSync(path.join(installedModes, "modes.json"))
      ? installedModes
      : path.join(rootDir, "fittings/seed/modes"),
    routingConfigPath: existsSync(scopedRouting)
      ? scopedRouting
      : path.join(rootDir, "fittings/seed/model-router/config/routing.seed.json")
  };
}

export interface PlacementResult {
  mode: string;
  promptPath: string;
  model: string | null;
  effort: string | null;
  role: string;
}

export interface PlacementOptions {
  channel: string;
  mode?: string | null;
  modesDir: string; // the modes fitting dir (souls + voice + modes.json)
  routingConfigPath: string; // routing.json / routing.seed.json (role → target)
  outDir: string; // where the composed mode prompt is written
}

// ── Mode bias (pure TS mirror of routing-core.mjs biasRole/modeBiasFor) ──────
// Inlined here, NOT dynamic-imported from the .mjs: a runtime import() of an
// external .mjs by file URL fails inside the Next server runtime (it works under
// vitest, which is why a unit test wouldn't catch it). The logic is tiny and
// covered by tests on both sides; keep the two in sync.
const COMPUTE_RANK: Record<string, number> = { fast: 0, standard: 1, expert: 2 };
const RANK_ROLE = ["fast", "standard", "expert"];

function biasRole(role: string, bias: { floor?: string; prefer?: string } | null): string {
  if (!(role in COMPUTE_RANK) || !bias) return role;
  let rank = COMPUTE_RANK[role];
  if (role === "standard" && bias.prefer && bias.prefer in COMPUTE_RANK && COMPUTE_RANK[bias.prefer] < rank) {
    rank = COMPUTE_RANK[bias.prefer];
  }
  if (bias.floor && bias.floor in COMPUTE_RANK && COMPUTE_RANK[bias.floor] > rank) {
    rank = COMPUTE_RANK[bias.floor];
  }
  return RANK_ROLE[rank];
}

function modeBiasFor(
  mode: string,
  modesJson: { modes?: Record<string, { routingBias?: string }>; routingBias?: Record<string, { floor?: string; prefer?: string }> }
): { floor?: string; prefer?: string } | null {
  const biasName = modesJson?.modes?.[mode]?.routingBias;
  return (biasName && modesJson.routingBias?.[biasName]) || null;
}

// Resolve the face for a new session: an explicit valid mode wins; else the
// channel default (dev-env → joe, slack → gary); else the configured default.
export function resolvePlacementMode(
  channel: string,
  explicit: string | null | undefined,
  names: string[],
  channelDefaults: Record<string, string>,
  defaultMode: string
): string {
  if (explicit && names.includes(explicit)) return explicit;
  const fromChannel = channelDefaults[channel];
  if (fromChannel && names.includes(fromChannel)) return fromChannel;
  return names.includes(defaultMode) ? defaultMode : names[0];
}

export async function placeOrchestratedSession(opts: PlacementOptions): Promise<PlacementResult | null> {
  let modesJson: {
    sharedVoiceRef: string;
    defaultMode?: string;
    channelDefaults?: Record<string, string>;
    routingBias?: Record<string, { floor?: string; prefer?: string }>;
    modes: Record<string, { soulRef: string; routingBias?: string }>;
  };
  try {
    modesJson = JSON.parse(await fs.readFile(path.join(opts.modesDir, "modes.json"), "utf8"));
  } catch {
    return null;
  }
  const names = Object.keys(modesJson.modes || {});
  if (names.length === 0) return null;

  const mode = resolvePlacementMode(
    opts.channel,
    opts.mode,
    names,
    modesJson.channelDefaults ?? {},
    modesJson.defaultMode ?? names[0]
  );

  // Mode ids come from modes.json keys (config, not request input) but are still
  // untrusted for filesystem purposes: a malformed modes.json key with path
  // separators / ".." would let `${mode}.md` escape outDir. Require a safe id and
  // confine the resolved prompt path under outDir before writing.
  if (!/^[a-z0-9_-]+$/i.test(mode)) return null;

  // Compose the mode's identity prompt (shared voice + soul). A placed Dev Env
  // session is a native code session, so its identity is the voice + soul (the
  // Dev Env appends its own browser-pane guidance).
  const sharedVoice = await fs.readFile(path.join(opts.modesDir, modesJson.sharedVoiceRef), "utf8");
  const stance = await fs.readFile(path.join(opts.modesDir, modesJson.modes[mode].soulRef), "utf8");
  const prompt = composeSoulPrompt({ sharedVoice, stance, capabilitiesBlock: "", routingSection: null });
  await fs.mkdir(opts.outDir, { recursive: true });
  const promptPath = path.join(opts.outDir, `${mode}.md`);
  // belt-and-braces: the written path must stay inside outDir
  if (path.relative(path.resolve(opts.outDir), path.resolve(promptPath)).startsWith("..")) return null;
  await fs.writeFile(promptPath, prompt, "utf8");

  // Model/effort from the mode's routing bias → compute rank → routing target.
  // v1 configs map the rank label through the profile roleMap; v2 configs (the
  // policy schema) index the profile's computeLadder [fast, standard, expert].
  let role = "standard";
  let model: string | null = null;
  let effort: string | null = null;
  try {
    const bias = modeBiasFor(mode, modesJson);
    role = bias ? biasRole("standard", bias) : "standard";
    const routing = JSON.parse(await fs.readFile(opts.routingConfigPath, "utf8")) as {
      version?: number;
      activeProfile?: string;
      profiles?: Record<string, { roleMap?: Record<string, string>; computeLadder?: string[] }>;
      targets?: Array<{ id: string; model?: string; effort?: string }>;
    };
    const profileName = routing.activeProfile ?? "balanced";
    const profile = (routing.profiles ?? {})[profileName] ?? {};
    const targetId =
      routing.version === 2
        ? (profile.computeLadder ?? [])[COMPUTE_RANK[role] ?? 1]
        : (profile.roleMap ?? {})[role];
    const target = (routing.targets ?? []).find((t) => t.id === targetId) ?? null;
    model = target?.model ?? null;
    effort = target?.effort ?? null;
  } catch {
    // leave model/effort null — the caller falls back to its default
  }

  return { mode, promptPath, model, effort, role };
}
