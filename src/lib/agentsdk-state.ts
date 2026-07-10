// agentsdk-state.ts — read-only state for the Quarters-AgentSDK view. Computes the
// provider table, capability records, and HARNESS state by calling the REAL
// agent-sdk fitting functions (single source of truth — never a copy), so the view
// reflects the runtime's actual behaviour. No secrets, no network.
//
// The Agent SDK runtime is first-class routable (D29): it reaches the Anthropic
// endpoint on the Max subscription as well as third-party Anthropic-compatible
// endpoints. Each provider carries an authMode (subscription / api-key / local).
// @ts-ignore — pure .mjs fitting modules
import { SDK_PROVIDERS, capabilityRecord, authModeFor } from "../../fittings/seed/agent-sdk-runtime/lib/providers.mjs";
// @ts-ignore
import { buildHarness } from "../../fittings/seed/agent-sdk-runtime/lib/harness.mjs";

export interface CapabilityRec {
  provider: string | null;
  text: boolean;
  toolUse: boolean;
  image: boolean;
  document: boolean;
  webSearch: boolean;
  mcp: boolean;
  effort: "supported" | "unsupported";
}

export interface ProviderView {
  id: string;
  baseUrl: string | null;
  configurable: boolean;
  needsKey: boolean;
  vaultKey: string | null;
  authMode: string;
  capabilities: CapabilityRec;
}

export interface HarnessView {
  promptMode: string;
  preset: string | null;
  settingSources: string[];
  claudeMdLoaded: boolean;
  skillsMounted: boolean;
  loadsUserSettings: boolean;
}

export interface AgentSdkState {
  providers: ProviderView[];
  harness: { full: HarnessView; lean: HarnessView };
  note: string;
  litellmPin: { max: string; forbidden: string[] };
  sdkPin: string;
}

const PROXY_DEMO_URL = "https://your-proxy.example/anthropic";

function harnessView(mode: "full" | "lean"): HarnessView {
  const h = buildHarness(mode);
  return {
    promptMode: h.promptMode,
    preset: h.preset,
    settingSources: h.settingSources,
    claudeMdLoaded: h.claudeMdLoaded,
    skillsMounted: h.skillsMounted,
    loadsUserSettings: h.settingSources.includes("user")
  };
}

export function getAgentSdkState(): AgentSdkState {
  const providers: ProviderView[] = Object.entries(SDK_PROVIDERS as Record<string, Record<string, unknown>>).map(
    ([id, spec]) => {
      const caps = capabilityRecord({ provider: id }) as CapabilityRec;
      const baseUrl = spec.configurable ? PROXY_DEMO_URL : (spec.baseUrl as string | null);
      return {
        id,
        baseUrl: baseUrl ?? null,
        configurable: !!spec.configurable,
        needsKey: !!spec.needsKey,
        vaultKey: (spec.vaultKey as string | undefined) ?? null,
        authMode: authModeFor({ provider: id }) as string,
        capabilities: caps
      };
    }
  );

  return {
    providers,
    harness: { full: harnessView("full"), lean: harnessView("lean") },
    note:
      "The Agent SDK is a first-class runtime (D29). The `anthropic` provider runs on the Max subscription (OAuth, billed to the plan); the rest reach third-party Anthropic-compatible endpoints by base URL, authenticated from the Vault.",
    litellmPin: { max: "1.82.6", forbidden: ["1.82.7", "1.82.8"] },
    // Pin string without the package scope prefix.
    sdkPin: "claude-agent-sdk@0.3.179"
  };
}
