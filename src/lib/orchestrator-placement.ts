// Orchestrator placement (deliverable #3, "place at birth").
//
// Front door for starting a session THROUGH the orchestrator: given a channel
// (e.g. "dev-env") and an optional explicit mode, pick the face (channel default
// — dev-env → joe — or the explicit mode), compose that mode's system prompt
// (shared voice + soul), pick the model/effort from the mode's routing bias, and
// return the spec. The Dev Env then spawns Claude Code with the composed prompt +
// model instead of a bare session. This reuses the same souls/mode-bias logic as
// the runner's gateway path, but as a live Garrison API (it does NOT depend on the
// gateway's orchestrator/soul mode being booted).
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { composeSoulPrompt } from "./souls";

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
  routingCorePath: string; // routing-core.mjs (dynamic-imported for biasRole)
  routingConfigPath: string; // routing.json / routing.seed.json (role → target)
  outDir: string; // where the composed mode prompt is written
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

  // Compose the mode's identity prompt (shared voice + soul). Capabilities/routing
  // are folded by the runner's souls path; a placed Dev Env session is a native
  // code session, so its identity is the voice + soul (the Dev Env appends its own
  // browser-pane guidance).
  const sharedVoice = await fs.readFile(path.join(opts.modesDir, modesJson.sharedVoiceRef), "utf8");
  const stance = await fs.readFile(path.join(opts.modesDir, modesJson.modes[mode].soulRef), "utf8");
  const prompt = composeSoulPrompt({ sharedVoice, stance, capabilitiesBlock: "", routingSection: null });
  await fs.mkdir(opts.outDir, { recursive: true });
  const promptPath = path.join(opts.outDir, `${mode}.md`);
  await fs.writeFile(promptPath, prompt, "utf8");

  // Model/effort from the mode's routing bias → role → routing target.
  let role = "standard";
  let model: string | null = null;
  let effort: string | null = null;
  try {
    const rc = (await import(pathToFileURL(opts.routingCorePath).href)) as {
      biasRole: (role: string, bias: unknown) => string;
      modeBiasFor: (mode: string, modesConfig: unknown) => unknown;
    };
    const bias = rc.modeBiasFor(mode, modesJson);
    role = bias ? rc.biasRole("standard", bias) : "standard";
    const routing = JSON.parse(await fs.readFile(opts.routingConfigPath, "utf8")) as {
      activeProfile?: string;
      profiles?: Record<string, { roleMap?: Record<string, string> }>;
      targets?: Array<{ id: string; model?: string; effort?: string }>;
    };
    const profileName = routing.activeProfile ?? "balanced";
    const profile = (routing.profiles ?? {})[profileName] ?? {};
    const targetId = (profile.roleMap ?? {})[role];
    const target = (routing.targets ?? []).find((t) => t.id === targetId) ?? null;
    model = target?.model ?? null;
    effort = target?.effort ?? null;
  } catch {
    // leave model/effort null — the caller falls back to its default
  }

  return { mode, promptPath, model, effort, role };
}
