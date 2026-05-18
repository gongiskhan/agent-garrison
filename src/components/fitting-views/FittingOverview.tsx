"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { isOwnPortFaculty, OWN_PORT_DEFAULTS } from "@/lib/faculties";
import { RUNTIME_FITTING_ID } from "@/lib/capabilities";
import { singletonCapabilityKinds } from "@/lib/types";
import { useToolDiscovery, type ToolWithHealth } from "@/components/tools/useToolDiscovery";
import type {
  CapabilityConsumption,
  Composition,
  LibraryEntry
} from "@/lib/types";

interface FittingOverviewProps {
  entry: LibraryEntry;
  composition: Composition | null;
  library: LibraryEntry[];
  compact?: boolean;
}

// Four-section read-only inspector for a Fitting:
//   1. How it works    — for_consumers (8 KB markdown) or summary fallback
//   2. Provides         — capability provisions (kind:name)
//   3. Consumes         — consumes + resolved wiring from capabilityGraph
//   4. Views            — declared ui.views[] + own-port note when applicable
// Reused inline-collapsed inside FittingCard on /compose/<faculty>, and
// full-width on /fitting/<id> as the canonical Fitting page header.
export function FittingOverview({ entry, composition, library, compact }: FittingOverviewProps) {
  const { entries: toolEntries, refresh } = useToolDiscovery();
  const ownPort = isOwnPortFaculty(entry.faculty);
  const tool = ownPort ? toolEntries.find((t) => t.fittingId === entry.id) ?? null : null;
  const defaultPort = OWN_PORT_DEFAULTS[entry.faculty];

  return (
    <div
      style={{
        display: "grid",
        gap: compact ? 14 : 22,
        padding: compact ? "12px 0 4px" : 0
      }}
    >
      <HowItWorks entry={entry} />
      <Provides entry={entry} />
      <Consumes entry={entry} composition={composition} library={library} />
      <Views
        entry={entry}
        ownPort={ownPort}
        tool={tool}
        defaultPort={defaultPort}
        refresh={refresh}
      />
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="font-mono"
      style={{
        fontSize: 10,
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        color: "var(--mute)",
        marginBottom: 6
      }}
    >
      {children}
    </div>
  );
}

function HowItWorks({ entry }: { entry: LibraryEntry }) {
  const body = entry.metadata.for_consumers?.trim() || entry.summary;
  return (
    <section>
      <SectionLabel>How it works</SectionLabel>
      <div
        style={{
          fontSize: 13,
          lineHeight: 1.6,
          color: "var(--ink)",
          background: "var(--paper-2)",
          border: "1px solid var(--rule)",
          padding: "12px 14px",
          whiteSpace: "pre-wrap"
        }}
      >
        {body}
      </div>
    </section>
  );
}

function Provides({ entry }: { entry: LibraryEntry }) {
  const provides = entry.metadata.provides;
  if (provides.length === 0) {
    return (
      <section>
        <SectionLabel>Provides</SectionLabel>
        <div style={{ fontSize: 12.5, color: "var(--mute)" }}>None.</div>
      </section>
    );
  }
  return (
    <section>
      <SectionLabel>Provides</SectionLabel>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
        {provides.map((p, i) => {
          const singleton = (singletonCapabilityKinds as readonly string[]).includes(p.kind);
          return (
            <li
              key={`${p.kind}:${p.name}:${i}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12.5,
                padding: "6px 10px",
                background: "white",
                border: "1px solid var(--rule)"
              }}
            >
              <code style={{ fontFamily: "var(--font-mono), monospace" }}>
                {p.kind}
                {p.name ? `:${p.name}` : ""}
              </code>
              {singleton ? <CapabilityBadge label="singleton" /> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Consumes({
  entry,
  composition,
  library
}: {
  entry: LibraryEntry;
  composition: Composition | null;
  library: LibraryEntry[];
}) {
  const consumes = entry.metadata.consumes;
  if (consumes.length === 0) {
    return (
      <section>
        <SectionLabel>Consumes</SectionLabel>
        <div style={{ fontSize: 12.5, color: "var(--mute)" }}>
          This Fitting does not consume any capabilities from other Fittings.
        </div>
      </section>
    );
  }
  // Look up wiring from the composition's capability graph for this Fitting.
  const wiring = composition?.capabilityGraph.consumers.filter(
    (c) => c.fittingId === entry.id
  ) ?? [];
  const libraryById = new Map(library.map((e) => [e.id, e]));

  return (
    <section>
      <SectionLabel>Consumes</SectionLabel>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
        {consumes.map((c, i) => {
          const matched = wiring.find((w) => sameConsumption(w.consumption, c));
          const providers = matched?.providers ?? [];
          return (
            <li
              key={`${c.kind}:${c.name ?? ""}:${i}`}
              style={{
                fontSize: 12.5,
                padding: "8px 10px",
                background: "white",
                border: "1px solid var(--rule)",
                display: "grid",
                gap: 4
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <code style={{ fontFamily: "var(--font-mono), monospace" }}>
                  {c.kind}
                  {c.name ? `:${c.name}` : ""}
                </code>
                <CapabilityBadge label={c.cardinality ?? "one"} />
              </div>
              <div style={{ fontSize: 11.5, color: "var(--mute)" }}>
                {composition === null ? (
                  "Wiring unavailable — no composition loaded."
                ) : providers.length === 0 ? (
                  <span style={{ color: c.cardinality === "optional-one" || c.cardinality === "any" ? "var(--mute)" : "var(--alarm)" }}>
                    {c.cardinality === "optional-one" || c.cardinality === "any"
                      ? "No provider stationed (optional)."
                      : "No provider stationed — required."}
                  </span>
                ) : (
                  <>
                    → provided by{" "}
                    {providers.map((p, idx) => {
                      const name =
                        p.fittingId === RUNTIME_FITTING_ID
                          ? "Garrison runtime"
                          : libraryById.get(p.fittingId)?.name ?? p.fittingId;
                      return (
                        <span key={`${p.fittingId}-${idx}`}>
                          {idx > 0 ? ", " : ""}
                          <b style={{ color: "var(--ink)" }}>{name}</b>
                        </span>
                      );
                    })}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Views({
  entry,
  ownPort,
  tool,
  defaultPort,
  refresh
}: {
  entry: LibraryEntry;
  ownPort: boolean;
  tool: ToolWithHealth | null;
  defaultPort: number | undefined;
  refresh: () => Promise<void>;
}) {
  const views = entry.metadata.ui?.views ?? [];
  if (views.length === 0 && !ownPort) {
    return (
      <section>
        <SectionLabel>Views</SectionLabel>
        <div style={{ fontSize: 12.5, color: "var(--mute)" }}>
          This Fitting ships no UI.
        </div>
      </section>
    );
  }
  return (
    <section>
      <SectionLabel>Views</SectionLabel>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
        {views.map((v) => (
          <li
            key={v.id}
            style={{
              fontSize: 12.5,
              padding: "8px 10px",
              background: "white",
              border: "1px solid var(--rule)",
              display: "grid",
              gridTemplateColumns: "1fr auto",
              gap: 8,
              alignItems: "center"
            }}
          >
            <div>
              <code style={{ fontFamily: "var(--font-mono), monospace", fontSize: 12 }}>
                {v.id}
              </code>{" "}
              <span style={{ color: "var(--mute)" }}>· route {v.route}</span>
            </div>
            <CapabilityBadge label={v.placement} />
          </li>
        ))}
        {ownPort ? (
          <li
            style={{
              fontSize: 12.5,
              padding: "8px 10px",
              background: "white",
              border: "1px solid var(--rule)",
              display: "grid",
              gridTemplateColumns: "1fr auto",
              gap: 8,
              alignItems: "center"
            }}
          >
            <div>
              <b>Own-port UI</b>
              {defaultPort ? (
                <span style={{ color: "var(--mute)" }}>
                  {" "}
                  · default <code style={{ fontFamily: "var(--font-mono), monospace" }}>:{defaultPort}</code>
                </span>
              ) : null}
              {tool?.url ? (
                <span style={{ color: "var(--mute)" }}>
                  {" "}
                  · live at <code style={{ fontFamily: "var(--font-mono), monospace" }}>{tool.url}</code>
                </span>
              ) : null}
            </div>
            <OwnPortControls entry={entry} tool={tool} refresh={refresh} />
          </li>
        ) : null}
      </ul>
    </section>
  );
}

function OwnPortControls({
  entry,
  tool,
  refresh
}: {
  entry: LibraryEntry;
  tool: ToolWithHealth | null;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function callAction(action: "start" | "stop") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/fittings/${entry.id}/${action}`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error((data && data.error) || `HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      // Give the spawned child a beat to write its discovery JSON, then refresh.
      setTimeout(() => void refresh(), 600);
    }
  }

  const healthy = tool?.healthy === true && tool.url;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {error ? (
        <span style={{ fontSize: 11, color: "var(--alarm)" }} title={error}>
          error
        </span>
      ) : null}
      {healthy ? (
        <>
          <a
            href={tool.url}
            target="_blank"
            rel="noopener noreferrer"
            className="btn small primary"
            style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            Open <ExternalLink size={12} aria-hidden />
          </a>
          <button
            type="button"
            className="btn small ghost"
            onClick={() => void callAction("stop")}
            disabled={busy !== null}
          >
            {busy === "stop" ? "Stopping…" : "Stop"}
          </button>
        </>
      ) : (
        <>
          <span style={{ fontSize: 11, color: "var(--mute)" }}>
            {tool?.healthy === false ? "unreachable" : "not running"}
          </span>
          <button
            type="button"
            className="btn small primary"
            onClick={() => void callAction("start")}
            disabled={busy !== null}
          >
            {busy === "start" ? "Starting…" : "Start"}
          </button>
        </>
      )}
    </div>
  );
}

function CapabilityBadge({ label }: { label: string }) {
  return (
    <span
      className="font-mono"
      style={{
        fontSize: 9.5,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: "var(--mute)",
        border: "1px solid var(--rule)",
        padding: "2px 6px",
        background: "var(--paper)"
      }}
    >
      {label}
    </span>
  );
}

function sameConsumption(a: CapabilityConsumption, b: CapabilityConsumption): boolean {
  return a.kind === b.kind && (a.name ?? null) === (b.name ?? null) && (a.cardinality ?? "one") === (b.cardinality ?? "one");
}
