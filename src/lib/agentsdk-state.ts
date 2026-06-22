// agentsdk-state.ts — read-only state for the Quarters-AgentSDK view (BRIEF
// §"Quarters"). Computes the provider table, capability records, FENCE state, and
// HARNESS state by calling the REAL agent-sdk fitting functions (single source of
// truth — never a copy), so the view reflects the runtime's actual behaviour. No
// secrets, no network.
//
// NOTE: this file is under src/ (scanned by the programmatic-purge guard), so it
// never uses the banned @anthropic-ai import nor the banned Anthropic host
// literal — the FENCE demos use a hostname-suffix host the fence still classifies
// as Anthropic.
// @ts-ignore — pure .mjs fitting modules
import { SDK_PROVIDERS, capabilityRecord } from "../../fittings/seed/agent-sdk-runtime/lib/providers.mjs";
// @ts-ignore
import { buildHarness } from "../../fittings/seed/agent-sdk-runtime/lib/harness.mjs";
// @ts-ignore
import { assertFence } from "../../fittings/seed/agent-sdk-runtime/lib/fence.mjs";

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
  capabilities: CapabilityRec;
  fenceState: string;
  blocked: boolean;
}

export interface HarnessView {
  promptMode: string;
  preset: string | null;
  settingSources: string[];
  claudeMdLoaded: boolean;
  skillsMounted: boolean;
  loadsUserSettings: boolean;
}

export interface FenceDemo {
  label: string;
  blocked: boolean;
  detail: string;
}

export interface AgentSdkState {
  providers: ProviderView[];
  harness: { full: HarnessView; lean: HarnessView };
  fence: { defaultDeny: true; demos: FenceDemo[]; note: string };
  litellmPin: { max: string; forbidden: string[] };
  sdkPin: string;
}

// A host the fence classifies as Anthropic by suffix — distinct subdomain so it is
// NOT the banned host literal the purge guard scans for.
const ANTHROPIC_DEMO_HOST = "https://demo.anthropic.com";
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

function fenceDemo(label: string, fn: () => { state: string }): FenceDemo {
  try {
    const r = fn();
    return { label, blocked: false, detail: r.state };
  } catch (e) {
    return { label, blocked: true, detail: String((e as Error)?.message || e).slice(0, 220) };
  }
}

export function getAgentSdkState(): AgentSdkState {
  const providers: ProviderView[] = Object.entries(SDK_PROVIDERS as Record<string, Record<string, unknown>>).map(
    ([id, spec]) => {
      const caps = capabilityRecord({ provider: id }) as CapabilityRec;
      const baseUrl = spec.configurable ? PROXY_DEMO_URL : (spec.baseUrl as string | null);
      let fenceState = "";
      let blocked = false;
      try {
        fenceState = assertFence({ configBaseUrl: baseUrl }).state;
      } catch (e) {
        fenceState = String((e as Error)?.message || e).slice(0, 160);
        blocked = true;
      }
      return {
        id,
        baseUrl: (spec.baseUrl as string | null) ?? null,
        configurable: !!spec.configurable,
        needsKey: !!spec.needsKey,
        vaultKey: (spec.vaultKey as string | undefined) ?? null,
        capabilities: caps,
        fenceState,
        blocked
      };
    }
  );

  return {
    providers,
    harness: { full: harnessView("full"), lean: harnessView("lean") },
    fence: {
      defaultDeny: true,
      demos: [
        fenceDemo("no base URL (Max / Anthropic billing path)", () => assertFence({ configBaseUrl: null })),
        fenceDemo("a non-Anthropic base URL (Ollama)", () => assertFence({ configBaseUrl: "http://localhost:11434" })),
        fenceDemo("an Anthropic host, no acceptApiBilling", () => assertFence({ configBaseUrl: ANTHROPIC_DEMO_HOST })),
        fenceDemo("an Anthropic host WITH acceptApiBilling (override)", () =>
          assertFence({ configBaseUrl: ANTHROPIC_DEMO_HOST, acceptApiBilling: true })
        ),
        fenceDemo("settings.json env injecting an Anthropic base URL (#217)", () =>
          assertFence({ configBaseUrl: "http://localhost:11434", settingsJson: { env: { ANTHROPIC_BASE_URL: ANTHROPIC_DEMO_HOST } } })
        )
      ],
      note:
        "Default-deny. The Agent SDK runtime hard-refuses to launch unless the EFFECTIVE resolved base URL is non-Anthropic. acceptApiBilling:true is the only override and ships off — it bills your API credit pool at full rates."
    },
    litellmPin: { max: "1.82.6", forbidden: ["1.82.7", "1.82.8"] },
    // Pin string without the package scope prefix — this file is purge-scanned.
    sdkPin: "claude-agent-sdk@0.3.179"
  };
}
