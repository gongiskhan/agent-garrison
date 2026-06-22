// Souls assembly (modes faculty → GARRISON_SOULS_CONFIG).
//
// When a `modes` provider is selected, the runner composes one system prompt per
// mode (Gary/Joe/James) — shared voice + soul stance + the {{capabilities}} block
// + the {{routing}} policy — writes them under <composition>/.garrison/souls/, and
// hands the gateway a GARRISON_SOULS_CONFIG. That activates the gateway's
// orchestrator/soul mode (fittings/seed/http-gateway/scripts/gateway.mjs), which
// boots an orchestrator session (the assembled model-router prompt) and spawns the
// per-mode soul sessions on demand, keyed `soul-<mode>` in its session registry.
//
// This module deliberately imports nothing from runner.ts (which imports it) —
// the caller passes the already-rendered capabilities block + routing section, so
// there is no import cycle.
import { promises as fs } from "node:fs";
import path from "node:path";

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
export interface SoulsConfig {
  orchestratorFittingId: string;
  orchestrator: SoulSpawnConfig;
  souls: Record<string, SoulSpawnConfig>;
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

// The selected orchestrator fitting's id (model-router by default), used as the
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

interface ModesJson {
  sharedVoiceRef: string;
  modes: Record<string, { soulRef: string; label?: string }>;
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
}): Promise<SoulsConfig | null> {
  const {
    compositionDir,
    modesDir,
    orchestratorPromptPath,
    orchestratorFittingId,
    capabilitiesBlock,
    routingSection
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

  return {
    orchestratorFittingId,
    orchestrator: {
      promptPath: orchestratorPromptPath,
      resolvedBasePath: compositionDir,
      preset: "claude_code"
    },
    souls
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
