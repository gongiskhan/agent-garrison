"use client";

import { useEffect, useState } from "react";
import type { AgentSdkState } from "@/lib/agentsdk-state";

const card: React.CSSProperties = {
  border: "1px solid var(--rule)",
  background: "var(--surface, #fff)",
  padding: "14px 16px",
  borderRadius: 6
};
const h3: React.CSSProperties = { fontWeight: 600, fontSize: 14, margin: "0 0 10px" };
const mute: React.CSSProperties = { color: "var(--mute)", fontSize: 12.5, lineHeight: 1.6 };

function Flag({ on, yes = "yes", no = "no" }: { on: boolean; yes?: string; no?: string }) {
  return (
    <span
      className="pill"
      style={{ fontSize: 10, padding: "1px 7px", border: "1px solid var(--rule)", borderRadius: 999, color: on ? "var(--ok, #1a7f37)" : "var(--mute)" }}
    >
      {on ? yes : no}
    </span>
  );
}

function caps(c: AgentSdkState["providers"][number]["capabilities"]) {
  const on = (Object.entries(c) as [string, unknown][])
    .filter(([k, v]) => v === true && k !== "provider")
    .map(([k]) => k);
  return on.length ? on.join(", ") : "—";
}

export function AgentSDKPanel() {
  const [state, setState] = useState<AgentSdkState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/quarters/agentsdk")
      .then((r) => r.json())
      .then((d) => {
        if (!active) return;
        if (d?.error) setError(String(d.error));
        else setState(d as AgentSdkState);
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      active = false;
    };
  }, []);

  return (
    <main>
      <div className="crumbs">
        <b>Quarters</b> · AgentSDK
      </div>
      <div className="page">
        <div className="head">
          <h1>AgentSDK Runtime</h1>
          <p className="ld">
            The Claude Agent SDK runtime — reachable ONLY via a non-Anthropic base URL (Ollama / Z.ai / DeepSeek /
            MiniMax / LLM proxy). Shows the provider table + capability records, THE FENCE state (default-deny Anthropic
            billing), and THE HARNESS state (which preset, whether CLAUDE.md loads, whether skills mount). Max-plan Claude
            stays on the Claude Code PTY runtime.
          </p>
        </div>

        {error ? (
          <div className="banner alarm" data-testid="agentsdk-error">
            <div>
              <h5>Could not read runtime state</h5>
              <p>{error}</p>
            </div>
          </div>
        ) : null}

        {state ? (
          <div style={{ display: "grid", gap: 16 }} data-testid="agentsdk-panel">
            {/* THE FENCE */}
            <section style={card} data-testid="fence-state">
              <h3 style={h3}>THE FENCE — default-deny Anthropic billing</h3>
              <p style={{ ...mute, marginTop: 0 }}>{state.fence.note}</p>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, marginTop: 8 }}>
                <tbody>
                  {state.fence.demos.map((d) => (
                    <tr key={d.label} style={{ borderTop: "1px solid var(--rule)" }}>
                      <td style={{ padding: "6px 8px 6px 0" }}>{d.label}</td>
                      <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                        <Flag on={d.blocked} yes="BLOCKED" no="allowed" />
                      </td>
                      <td style={{ padding: "6px 0", color: "var(--mute)" }}>{d.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            {/* THE HARNESS */}
            <section style={card} data-testid="harness-state">
              <h3 style={h3}>THE HARNESS — per-target promptMode</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
                {(["full", "lean"] as const).map((mode) => {
                  const h = state.harness[mode];
                  return (
                    <div key={mode} style={{ border: "1px solid var(--rule)", borderRadius: 6, padding: "10px 12px" }}>
                      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
                        promptMode: <code>{mode}</code>
                      </div>
                      <div style={mute}>
                        <div>preset: {h.preset ? <code>{h.preset}</code> : <em>none (minimal string)</em>}</div>
                        <div>settingSources: <code>[{h.settingSources.join(", ")}]</code></div>
                        <div>CLAUDE.md loaded: <Flag on={h.claudeMdLoaded} /></div>
                        <div>skills mounted: <Flag on={h.skillsMounted} /></div>
                        <div>loads user settings (#217 risk): <Flag on={h.loadsUserSettings} yes="YES" no="no" /></div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Providers + capability records */}
            <section style={card} data-testid="providers-table">
              <h3 style={h3}>Providers — base URL · Vault key · capability record</h3>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--mute)" }}>
                    <th style={{ padding: "4px 8px 4px 0" }}>provider</th>
                    <th style={{ padding: "4px 8px" }}>base URL</th>
                    <th style={{ padding: "4px 8px" }}>vault key</th>
                    <th style={{ padding: "4px 8px" }}>serves</th>
                    <th style={{ padding: "4px 8px" }}>effort</th>
                    <th style={{ padding: "4px 8px" }}>fence</th>
                  </tr>
                </thead>
                <tbody>
                  {state.providers.map((p) => (
                    <tr key={p.id} style={{ borderTop: "1px solid var(--rule)" }}>
                      <td style={{ padding: "6px 8px 6px 0" }}><code>{p.id}</code></td>
                      <td style={{ padding: "6px 8px", color: "var(--mute)" }}>
                        {p.configurable ? <em>configurable</em> : p.baseUrl}
                      </td>
                      <td style={{ padding: "6px 8px", color: "var(--mute)" }}>{p.vaultKey ?? "—"}</td>
                      <td style={{ padding: "6px 8px", color: "var(--mute)" }}>{caps(p.capabilities)}</td>
                      <td style={{ padding: "6px 8px" }}>{p.capabilities.effort}</td>
                      <td style={{ padding: "6px 8px" }}>
                        <Flag on={!p.blocked} yes="non-anthropic" no="blocked" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ ...mute, marginTop: 10 }}>
                DeepSeek serves text + tool use only (no image / document / web-search / MCP) — the orchestrator refuses to
                route an unsupported block at a target that cannot serve it.
              </p>
            </section>

            {/* Pins */}
            <section style={card} data-testid="version-pins">
              <h3 style={h3}>Version pins</h3>
              <div style={mute}>
                <div>SDK: <code>{state.sdkPin}</code> (bundled CLI pinned transitively)</div>
                <div>
                  LiteLLM proxy: pin <code>&le; {state.litellmPin.max}</code>; FORBIDDEN{" "}
                  <code>{state.litellmPin.forbidden.join(", ")}</code> (TeamPCP supply-chain compromise)
                </div>
              </div>
            </section>
          </div>
        ) : !error ? (
          <p className="ld">Loading…</p>
        ) : null}
      </div>
    </main>
  );
}
