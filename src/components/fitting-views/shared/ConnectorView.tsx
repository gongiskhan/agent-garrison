"use client";

import type { FittingViewProps } from "../registry";
import { ConfigForm } from "./ConfigForm";
import { EmptyNote, SectionLabel, cardStyle } from "./common";

// `garrison:connector` — a connector Fitting's view: how it authenticates,
// the Vault secrets it is scoped to, its action catalog and triggers, plus
// its composition config (autosaved).
export default function ConnectorView({ entry, config }: FittingViewProps) {
  const spec = entry.metadata.connector;
  const scope = entry.metadata.secret_scope ?? [];

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <section style={cardStyle}>
        <SectionLabel>Authentication</SectionLabel>
        {spec ? (
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.65 }}>
            Method:{" "}
            <code className="font-mono" style={{ fontSize: 12 }}>
              {spec.auth}
            </code>
            {scope.length > 0 ? (
              <>
                {" · sealed Vault secrets: "}
                {scope.map((name, i) => (
                  <span key={name}>
                    {i > 0 ? ", " : ""}
                    <code className="font-mono" style={{ fontSize: 12 }}>
                      {name}
                    </code>
                  </span>
                ))}
                <span style={{ color: "var(--mute)" }}> (manage them in the Vault)</span>
              </>
            ) : (
              <span style={{ color: "var(--mute)" }}> · no Vault secrets declared</span>
            )}
          </p>
        ) : (
          <EmptyNote>This Fitting declares no connector block.</EmptyNote>
        )}
      </section>

      {spec && spec.actions.length > 0 ? (
        <section style={cardStyle}>
          <SectionLabel>Actions · {spec.actions.length}</SectionLabel>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 7 }}>
            {spec.actions.map((action) => (
              <li key={action.name} style={{ fontSize: 12.5, lineHeight: 1.55 }}>
                <code className="font-mono" style={{ fontSize: 12 }}>
                  {action.name}
                </code>
                {action.mutates ? (
                  <span
                    className="font-mono"
                    style={{
                      marginLeft: 7,
                      fontSize: 9.5,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      color: "var(--alarm)"
                    }}
                  >
                    writes
                  </span>
                ) : null}
                {action.args && action.args.length > 0 ? (
                  <span className="font-mono" style={{ marginLeft: 7, fontSize: 11, color: "var(--mute)" }}>
                    ({action.args.join(", ")})
                  </span>
                ) : null}
                {action.description ? (
                  <div style={{ color: "var(--mute)", fontSize: 12 }}>{action.description}</div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {spec && spec.triggers && spec.triggers.length > 0 ? (
        <section style={cardStyle}>
          <SectionLabel>Triggers</SectionLabel>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
            {spec.triggers.map((trigger, index) => (
              <li key={index} style={{ fontSize: 12.5 }}>
                <code className="font-mono" style={{ fontSize: 12 }}>
                  {trigger.type}
                </code>
                {trigger.event ? ` · ${trigger.event}` : ""}
                {trigger.cron ? (
                  <span className="font-mono" style={{ fontSize: 11.5 }}>{` · ${trigger.cron}`}</span>
                ) : null}
                {trigger.description ? (
                  <span style={{ color: "var(--mute)" }}> — {trigger.description}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ConfigForm entry={entry} config={config} />
    </div>
  );
}
