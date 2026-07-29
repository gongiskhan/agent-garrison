"use client";

import { useState } from "react";
import type { FittingViewProps } from "../registry";
import { ConfigForm } from "./ConfigForm";
import { EmptyNote, SectionLabel, cardStyle, fetchJson } from "./common";

interface RuntimeCheck {
  label: string;
  ok: boolean;
  detail?: string;
}

interface RuntimeTestResult {
  fittingId: string;
  ok: boolean;
  checks: RuntimeCheck[];
  note: string;
}

// `garrison:runtime` — a runtime engine Fitting's view: engine identity, its
// composition config (autosaved), the native login hint, and a live Test probe
// (the same check the Muster Runtimes tab runs).
export default function RuntimeView({ entry, config }: FittingViewProps) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<RuntimeTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const engines = (entry.metadata.provides ?? [])
    .filter((p) => p.kind === "runtime")
    .map((p) => p.name)
    .filter(Boolean);
  const login = entry.metadata.login;

  async function runTest() {
    setTesting(true);
    setTestError(null);
    try {
      const data = await fetchJson<{ test?: RuntimeTestResult } & RuntimeTestResult>(
        "/api/muster/standing/runtime",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "test", fittingId: entry.id })
        }
      );
      setResult((data.test ?? data) as RuntimeTestResult);
    } catch (err) {
      setTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <section style={cardStyle}>
        <SectionLabel>Engine</SectionLabel>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {engines.length > 0 ? (
            engines.map((name) => (
              <code
                key={name}
                className="font-mono"
                style={{
                  fontSize: 12.5,
                  padding: "3px 9px",
                  border: "1px solid var(--rule)",
                  background: "white"
                }}
              >
                {name}
              </code>
            ))
          ) : (
            <span style={{ fontSize: 12.5, color: "var(--mute)" }}>
              No engine identity declared (helper runtime).
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="btn small primary active:translate-y-px"
            onClick={() => void runTest()}
            disabled={testing}
          >
            {testing ? "Testing…" : "Test runtime"}
          </button>
        </div>
        {login ? (
          <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--mute)", lineHeight: 1.6 }}>
            Login:{" "}
            <code className="font-mono" style={{ fontSize: 11.5 }}>
              {login.command}
            </code>
            {login.storage_hint ? ` · ${login.storage_hint}` : ""}
          </p>
        ) : null}
        {testError ? (
          <p role="alert" style={{ margin: "10px 0 0", fontSize: 12.5, color: "var(--alarm)" }}>
            {testError}
          </p>
        ) : null}
        {result ? (
          <div style={{ marginTop: 12, display: "grid", gap: 5 }}>
            {result.checks.map((check) => (
              <div
                key={check.label}
                style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12.5 }}
              >
                <span
                  className="font-mono"
                  style={{ fontWeight: 700, color: check.ok ? "var(--sage)" : "var(--alarm)" }}
                >
                  {check.ok ? "•" : "!"}
                </span>
                <span>{check.label}</span>
                {check.detail ? (
                  <span className="font-mono" style={{ fontSize: 11, color: "var(--mute)" }}>
                    {check.detail}
                  </span>
                ) : null}
              </div>
            ))}
            {result.note ? (
              <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--mute)", lineHeight: 1.6 }}>
                {result.note}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      <ConfigForm entry={entry} config={config} />

      {entry.metadata.summary ? (
        <section>
          <SectionLabel>About</SectionLabel>
          <EmptyNote>{entry.metadata.summary}</EmptyNote>
        </section>
      ) : null}
    </div>
  );
}
