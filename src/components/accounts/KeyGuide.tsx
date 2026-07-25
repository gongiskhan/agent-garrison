"use client";

// KeyGuide — "where do I get this key?", answered next to the field that asks.
//
// Every provider hides its key page somewhere different (and, for OpenAI and
// Anthropic, behind a console that is NOT the consumer product people know), so
// a bare password box is a dead end. Links open in a new tab; they are external
// https URLs, so the tailnet rule about machine-local URLs does not apply.

import { COMMON_CUSTOM_PROVIDERS, PLATFORM_SPECS, type AccountPlatform } from "./shared";

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      style={{ textDecoration: "underline", wordBreak: "break-word" }}
    >
      {children}
      {/* Text marker, not an emoji: renders identically everywhere. */}
      <span aria-hidden style={{ opacity: 0.55, fontSize: "0.85em" }}> [↗]</span>
    </a>
  );
}

export function KeyGuide({ platform }: { platform: AccountPlatform }) {
  const guide = PLATFORM_SPECS[platform].apiKeyGuide;
  if (!guide) return null;
  const custom = platform === "custom";
  return (
    <div
      data-testid={`key-guide-${platform}`}
      style={{
        border: "1px solid var(--rule)",
        borderLeft: "3px solid var(--brass, var(--warn))",
        background: "var(--paper-2, #f7f3ea)",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontSize: 12
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 12 }}>Where to get one</strong>
        {!custom ? <ExternalLink href={guide.url}>{guide.urlLabel}</ExternalLink> : null}
      </div>
      {/* listStyle is set explicitly: the global reset strips markers, and these
          steps are genuinely ordered. */}
      <ol
        style={{
          margin: 0,
          paddingLeft: 18,
          listStyle: "decimal outside",
          display: "flex",
          flexDirection: "column",
          gap: 3
        }}
      >
        {guide.steps.map((step) => (
          <li key={step} style={{ lineHeight: 1.45 }}>
            {step}
          </li>
        ))}
      </ol>
      {custom ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 2 }}>
          <span className="hint" style={{ fontSize: 11 }}>
            Common providers - each is OpenAI-compatible and reads one env var:
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px" }}>
            {COMMON_CUSTOM_PROVIDERS.map((provider) => (
              <span key={provider.envKey} style={{ fontSize: 11.5 }}>
                <ExternalLink href={provider.url}>{provider.name}</ExternalLink>
                <span className="font-mono hint" style={{ fontSize: 10.5 }}>
                  {" "}
                  {provider.envKey}
                </span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {guide.extra ? (
        <div style={{ fontSize: 11.5 }}>
          <ExternalLink href={guide.extra.url}>{guide.extra.label}</ExternalLink>
        </div>
      ) : null}
      {guide.note ? (
        <span className="hint" style={{ fontSize: 11, lineHeight: 1.45 }}>
          {guide.note}
        </span>
      ) : null}
    </div>
  );
}

/** The compact "get a key" link for a section header / empty state. */
export function KeyGuideLink({ platform }: { platform: AccountPlatform }) {
  const guide = PLATFORM_SPECS[platform].apiKeyGuide;
  if (!guide) return null;
  return (
    <span className="hint" style={{ fontSize: 11.5 }}>
      <ExternalLink href={guide.url}>{guide.urlLabel}</ExternalLink>
    </span>
  );
}
