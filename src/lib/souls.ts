// Souls assembly (a `modes` provider → GARRISON_SOULS_CONFIG).
//
// When a fitting providing capability kind `modes` is selected, the runner composes
// one system prompt per mode — shared voice + soul stance + the {{capabilities}}
// block + the {{routing}} policy — writes them under <composition>/.garrison/souls/,
// and hands the gateway a GARRISON_SOULS_CONFIG. That activates the gateway's
// orchestrator/soul mode (fittings/seed/http-gateway/scripts/gateway.mjs), which
// boots an orchestrator session (the assembled orchestrator prompt) and spawns the
// per-mode soul sessions on demand, keyed `soul-<mode>` in its session registry.
//
// DORMANT by default (S3f2b): the multi-face `modes` seed fitting (Gary/Joe/James)
// was retired in favour of the single-persona identity fitting (identity-gary),
// which provides kind `identity`, NOT kind `modes`. So `findModesEntry` returns
// null for the default composition and the runner never reaches souls assembly —
// it stays in normal routed mode. This module remains live and no-op-safe: given a
// dir with no usable modes.json, `assembleSouls` returns null (never throws), and
// with a valid modes-shaped provider it still composes souls. Nothing here reads a
// seed dir at import time, so the fitting's removal doesn't affect it.
//
// This module deliberately imports nothing from runner.ts (which imports it) —
// the caller passes the already-rendered capabilities block + routing section, so
// there is no import cycle.
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// One soul/orchestrator spawn entry, matching the shape gateway.mjs reads
// (orchSpawn.promptPath / .resolvedBasePath; spawnHeadless reads optional
// preset/allowed_tools/disallowed_tools/exclude_dynamic_sections).
export interface SoulSpawnConfig {
  promptPath: string;
  resolvedBasePath: string;
  preset: "claude_code";
}

// The GARRISON_SOULS_CONFIG blob: an orchestrator entry + one entry per soul,
// keyed `soul-<mode>` (gateway.mjs looks up `soul-${soul}` first, then `${soul}`).
// Mode-switching metadata the gateway uses to resolve which face handles a turn
// (name-at-start / sticky / channel default) and where to append the switch-log.
export interface SoulsModesMeta {
  names: string[];
  defaultMode: string;
  channelDefaults: Record<string, string>;
  switchLogPath: string; // absolute, under the composition
  // Per-mode nominal compute tier (fast|standard|expert), derived from the mode's
  // routing bias via routing-core's biasRole. Surfaced to the orchestrator so it
  // spawns each soul at its mode's tier.
  tierByMode: Record<string, string>;
}

export interface SoulsConfig {
  orchestratorFittingId: string;
  orchestrator: SoulSpawnConfig;
  souls: Record<string, SoulSpawnConfig>;
  modes: SoulsModesMeta;
}

interface EntryLike {
  id: string;
  metadata: { provides?: Array<{ kind: string; name?: string }> };
}

// The selected fitting that provides the `modes` capability, or null. The
// resolver enforces at most one (modes is a singleton kind), so first match wins.
export function findModesEntry<T extends EntryLike>(entries: T[]): T | null {
  return (
    entries.find((e) => e.metadata?.provides?.some((p) => p.kind === "modes")) ?? null
  );
}

// The selected orchestrator fitting's id (orchestrator by default), used as the
// orchestratorFittingId so the gateway labels the orchestrator session.
export function findOrchestratorEntryId(entries: EntryLike[]): string | null {
  return (
    entries.find((e) => e.metadata?.provides?.some((p) => p.kind === "orchestrator"))?.id ??
    null
  );
}

// Compose one mode's system prompt. Identity first (shared voice, then the soul
// stance) — mirroring assembleSystemPrompt's "identity before behavior" ordering
// so the voice lands before the long policy section — then the tool inventory and
// the routing policy.
export function composeSoulPrompt(input: {
  sharedVoice: string;
  stance: string;
  capabilitiesBlock: string;
  routingSection: string | null;
}): string {
  const parts = [input.sharedVoice.trim(), "", input.stance.trim()];
  if (input.capabilitiesBlock && input.capabilitiesBlock.trim()) {
    parts.push("", "## Tools and Faculties available in this Operative", "", input.capabilitiesBlock.trim());
  }
  if (input.routingSection && input.routingSection.trim()) {
    parts.push("", input.routingSection.trim());
  }
  return parts.join("\n") + "\n";
}

// Instruction appended to the orchestrator session's prompt in soul mode, so the
// gateway's turn-header mode annotation is ACTED ON, not merely informational: the
// orchestrator must delegate the turn to that soul. The gateway emits the mode inside
// the structured turn header `[origin: <origin>, channel: <channel>, mode: <name>]`
// (buildOrchestratorTurn), so the prompt must reference that exact format — not a
// standalone `[mode: <name>]` the gateway never emits.
export const MODE_DELEGATION_INSTRUCTION = `## Mode delegation (Gary / Joe / James)

Each inbound turn begins with a structured header \`[origin: <origin>, channel: <channel>, mode: <name>]\`.
When it carries \`mode: <name>\` — the user's selected face (one of the installed modes),
resolved by the gateway from a mode name at the start
of the message, the channel default, or the sticky current mode. When a mode is set,
HONOR it: delegate the turn to that soul via the garrison-control
\`talk_to(soul=<name>, message=...)\` tool, wait for its result, and report back in
that soul's voice. Do not answer in your own voice when a mode is set — route to the
soul. All souls share one memory.`;

// Compose the orchestrator session's prompt for soul mode = the base assembled
// prompt + the mode-delegation instruction + (when known) per-mode tier guidance,
// so the orchestrator spawns each soul at its mode's routing-bias tier.
export function composeOrchestratorPrompt(
  basePrompt: string,
  tierByMode?: Record<string, string>
): string {
  let out = `${basePrompt.trimEnd()}\n\n${MODE_DELEGATION_INSTRUCTION}\n`;
  if (tierByMode && Object.keys(tierByMode).length > 0) {
    const lines = Object.entries(tierByMode).map(([m, t]) => `- ${m}: spawn at the **${t}** tier.`);
    out += `\n### Per-mode tier (from each mode's routing bias)\nWhen you delegate to a soul, spawn it at its mode's tier:\n${lines.join("\n")}\n`;
  }
  return out;
}

interface ModesJson {
  sharedVoiceRef: string;
  defaultMode?: string;
  channelDefaults?: Record<string, string>;
  switching?: { switchLog?: string };
  routingBias?: Record<string, { floor?: string; prefer?: string }>;
  modes: Record<string, { soulRef: string; label?: string; routingBias?: string }>;
}

// Read the modes fitting's modes.json + souls + shared voice from `modesDir`,
// compose a prompt per mode, write each to <compositionDir>/.garrison/souls/<mode>.md,
// and return the GARRISON_SOULS_CONFIG. Returns null when `modesDir` has no usable
// modes.json (so the caller falls back to non-souls gateway mode).
export async function assembleSouls(input: {
  compositionDir: string;
  modesDir: string;
  orchestratorPromptPath: string;
  orchestratorFittingId: string;
  capabilitiesBlock: string;
  routingSection: string | null;
  // Path to routing-core.mjs — dynamic-imported (never bundled) to derive each
  // mode's nominal tier from its routing bias. Omit/unreadable → no tier guidance.
  routingCorePath?: string;
}): Promise<SoulsConfig | null> {
  const {
    compositionDir,
    modesDir,
    orchestratorPromptPath,
    orchestratorFittingId,
    capabilitiesBlock,
    routingSection,
    routingCorePath
  } = input;

  let modesJson: ModesJson;
  try {
    modesJson = JSON.parse(await fs.readFile(path.join(modesDir, "modes.json"), "utf8"));
  } catch {
    return null;
  }
  if (!modesJson?.modes || Object.keys(modesJson.modes).length === 0) return null;

  const sharedVoice = await fs.readFile(
    path.join(modesDir, modesJson.sharedVoiceRef),
    "utf8"
  );
  const soulsDir = path.join(compositionDir, ".garrison", "souls");
  await fs.mkdir(soulsDir, { recursive: true });

  const souls: Record<string, SoulSpawnConfig> = {};
  for (const [mode, def] of Object.entries(modesJson.modes)) {
    const stance = await fs.readFile(path.join(modesDir, def.soulRef), "utf8");
    const prompt = composeSoulPrompt({ sharedVoice, stance, capabilitiesBlock, routingSection });
    const promptPath = path.join(soulsDir, `${mode}.md`);
    await fs.writeFile(promptPath, prompt, "utf8");
    souls[`soul-${mode}`] = {
      promptPath,
      resolvedBasePath: compositionDir,
      preset: "claude_code"
    };
  }

  // Compose the orchestrator session's prompt for soul mode: the base assembled
  // prompt + the mode-delegation instruction (so the gateway's [mode: <name>]
  // annotation is acted on — the orchestrator delegates to that soul). Falls back
  // to instruction-only if the base prompt can't be read.
  // Per-mode nominal tier from each mode's routing bias (routing-core biasRole),
  // dynamic-imported to avoid bundling. Best-effort: empty on missing path/import.
  const tierByMode: Record<string, string> = {};
  if (routingCorePath) {
    try {
      // webpackIgnore keeps the specifier out of EVERY webpack compilation -
      // without it Next compiles this fully-dynamic import into an empty lazy
      // context that rejects every request (same fix as src/instrumentation.ts).
      const rc = (await import(/* webpackIgnore: true */ pathToFileURL(routingCorePath).href)) as {
        biasRole: (role: string, bias: unknown) => string;
        modeBiasFor: (mode: string, modesConfig: unknown) => unknown;
      };
      for (const m of Object.keys(modesJson.modes)) {
        const bias = rc.modeBiasFor(m, modesJson);
        tierByMode[m] = bias ? rc.biasRole("standard", bias) : "standard";
      }
    } catch {
      // leave tierByMode empty — no per-mode tier guidance in the prompt
    }
  }

  let baseOrchestrator = "";
  try {
    baseOrchestrator = await fs.readFile(orchestratorPromptPath, "utf8");
  } catch {
    baseOrchestrator = "";
  }
  const orchestratorPath = path.join(soulsDir, "_orchestrator.md");
  await fs.writeFile(orchestratorPath, composeOrchestratorPrompt(baseOrchestrator, tierByMode), "utf8");

  const modesMeta: SoulsModesMeta = {
    names: Object.keys(modesJson.modes),
    defaultMode: modesJson.defaultMode ?? Object.keys(modesJson.modes)[0],
    channelDefaults: modesJson.channelDefaults ?? {},
    switchLogPath: path.join(
      compositionDir,
      modesJson.switching?.switchLog ?? ".garrison/switch-log.jsonl"
    ),
    tierByMode
  };

  return {
    orchestratorFittingId,
    orchestrator: {
      promptPath: orchestratorPath,
      resolvedBasePath: compositionDir,
      preset: "claude_code"
    },
    souls,
    modes: modesMeta
  };
}

// The gateway's orchestrator/soul mode drives souls through the mcp-gateway
// sidecar (talk_to / spawn-soul MCP tools). Activating orchestrator mode without
// it boots an orchestrator that cannot reach its souls, so the runner gates
// activation on this: mcp-gateway must be installed (selected or transitive) at
// <composition>/apm_modules/_local/mcp-gateway/scripts/gateway.mjs.
export async function mcpGatewayPresent(compositionDir: string): Promise<boolean> {
  try {
    await fs.access(
      path.join(compositionDir, "apm_modules", "_local", "mcp-gateway", "scripts", "gateway.mjs")
    );
    return true;
  } catch {
    return false;
  }
}
