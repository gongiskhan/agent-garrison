"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { isOwnPortFitting, ownPortDefaultPort } from "@/lib/faculties";
import { RUNTIME_FITTING_ID } from "@/lib/capabilities";
import { singletonCapabilityKinds } from "@/lib/types";
import { useFittingViewStatus, type FittingViewStatus } from "@/components/fitting-views/useFittingViewStatus";
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
  const { entries: viewStatuses, refresh } = useFittingViewStatus();
  const ownPort = isOwnPortFitting(entry);
  const view = ownPort ? viewStatuses.find((t) => t.fittingId === entry.id) ?? null : null;
  const defaultPort = ownPortDefaultPort(entry);

  return (
    <div
      style={{
        display: "grid",
        gap: compact ? 16 : 28,
        padding: compact ? "12px 0 4px" : 0
      }}
    >
      <HowItWorks entry={entry} />
      <Provides entry={entry} />
      <Consumes entry={entry} composition={composition} library={library} />
      <Views
        entry={entry}
        ownPort={ownPort}
        view={view}
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
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: 10,
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        color: "var(--brass)",
        marginBottom: 9
      }}
    >
      <span>{children}</span>
      <span style={{ height: 1, flex: 1, background: "var(--rule)" }} aria-hidden />
    </div>
  );
}

function EmptyDetail({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        border: "1px dashed var(--rule-2)",
        borderLeft: "3px solid var(--rule-2)",
        background: "var(--surface)",
        color: "var(--mute)",
        fontSize: 12.5,
        lineHeight: 1.6,
        padding: "11px 13px"
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
          lineHeight: 1.7,
          color: "var(--ink-mute)",
          background: "var(--surface)",
          borderTop: "1px solid var(--rule)",
          borderRight: "1px solid var(--rule)",
          borderBottom: "1px solid var(--rule)",
          borderLeft: "3px solid var(--brass)",
          padding: "14px 16px",
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
        <EmptyDetail>No capabilities declared.</EmptyDetail>
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
                flexWrap: "wrap",
                gap: 8,
                fontSize: 12.5,
                padding: "8px 11px",
                background: "var(--surface)",
                border: "1px solid var(--rule)",
                borderLeft: "2px solid var(--sage)"
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
        <EmptyDetail>
          This Fitting does not consume any capabilities from other Fittings.
        </EmptyDetail>
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
                padding: "10px 12px",
                background: "var(--surface)",
                border: "1px solid var(--rule)",
                borderLeft: `2px solid ${
                  composition !== null &&
                  providers.length === 0 &&
                  c.cardinality !== "optional-one" &&
                  c.cardinality !== "any"
                    ? "var(--alarm)"
                    : "var(--rule-2)"
                }`,
                display: "grid",
                gap: 6
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
  view,
  defaultPort,
  refresh
}: {
  entry: LibraryEntry;
  ownPort: boolean;
  view: FittingViewStatus | null;
  defaultPort: number | undefined;
  refresh: () => Promise<void>;
}) {
  const views = entry.metadata.ui?.views ?? [];
  if (views.length === 0 && !ownPort) {
    return (
      <section>
        <SectionLabel>Views</SectionLabel>
        <EmptyDetail>
          This Fitting ships no UI.
        </EmptyDetail>
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
              padding: "10px 12px",
              background: "var(--surface)",
              border: "1px solid var(--rule)",
              borderLeft: "2px solid var(--brass)",
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) auto",
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
          <OwnPortRow
            entry={entry}
            view={view}
            defaultPort={defaultPort}
            refresh={refresh}
          />
        ) : null}
      </ul>
    </section>
  );
}

function OwnPortRow({
  entry,
  view,
  defaultPort,
  refresh
}: {
  entry: LibraryEntry;
  view: FittingViewStatus | null;
  defaultPort: number | undefined;
  refresh: () => Promise<void>;
}) {
  const [logsOpen, setLogsOpen] = useState(false);
  return (
    <li
      style={{
        fontSize: 12.5,
        background: "var(--surface)",
        border: "1px solid var(--rule)",
        borderLeft: "2px solid var(--brass)"
      }}
    >
      <div
        style={{
          padding: "11px 12px",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))",
          gap: 12,
          alignItems: "center"
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background:
                  view?.healthy === true
                    ? "var(--sage)"
                    : view?.healthy === false
                      ? "var(--alarm)"
                      : "var(--rule-2)"
              }}
              aria-hidden
            />
            <b>Own-port UI</b>
            <span className="font-mono" style={{ fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--mute)" }}>
              {view?.healthy === true ? "live" : view?.healthy === false ? "unreachable" : "offline"}
            </span>
          </div>
          {defaultPort ? (
            <span style={{ display: "inline-block", color: "var(--mute)", marginTop: 3 }}>
              {" "}
              · default <code style={{ fontFamily: "var(--font-mono), monospace" }}>:{defaultPort}</code>
            </span>
          ) : null}
          {view?.url ? (
            <span style={{ display: "inline-block", color: "var(--mute)", marginTop: 3, maxWidth: "100%", overflowWrap: "anywhere" }}>
              {" "}
              · live at <code style={{ fontFamily: "var(--font-mono), monospace" }}>{view.url}</code>
            </span>
          ) : null}
        </div>
        <OwnPortControls
          entry={entry}
          view={view}
          refresh={refresh}
          logsOpen={logsOpen}
          onToggleLogs={() => setLogsOpen((v) => !v)}
        />
      </div>
      {logsOpen ? <LogPanel fittingId={entry.id} /> : null}
    </li>
  );
}

function OwnPortControls({
  entry,
  view,
  refresh,
  logsOpen,
  onToggleLogs
}: {
  entry: LibraryEntry;
  view: FittingViewStatus | null;
  refresh: () => Promise<void>;
  logsOpen: boolean;
  onToggleLogs: () => void;
}) {
  const [busy, setBusy] = useState<"start" | "stop" | "restart" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function callAction(action: "start" | "stop" | "restart") {
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

  const healthy = view?.healthy === true && view.url;

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap", gap: 6 }}>
      {error ? (
        <span
          style={{ maxWidth: 180, fontSize: 11, color: "var(--alarm)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={error}
          role="alert"
        >
          Action failed
        </span>
      ) : null}
      <button
        type="button"
        className="btn small ghost active:translate-y-px"
        onClick={onToggleLogs}
        aria-pressed={logsOpen}
      >
        {logsOpen ? "Hide logs" : "Logs"}
      </button>
      {healthy ? (
        <>
          <Link
            href={`/embed/${entry.id}`}
            className="btn small primary active:translate-y-px"
            style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}
            title={`Open ${entry.name} embedded (${view.url})`}
          >
            Open <ExternalLink size={12} aria-hidden />
          </Link>
          <button
            type="button"
            className="btn small ghost active:translate-y-px"
            onClick={() => void callAction("restart")}
            disabled={busy !== null}
            title="Stop and start — reloads the Fitting's code (use after editing it)"
          >
            {busy === "restart" ? "Restarting…" : "Restart"}
          </button>
          <button
            type="button"
            className="btn small ghost active:translate-y-px"
            onClick={() => void callAction("stop")}
            disabled={busy !== null}
          >
            {busy === "stop" ? "Stopping…" : "Stop"}
          </button>
        </>
      ) : (
        <>
          <span style={{ fontSize: 11, color: "var(--mute)" }}>
            {view?.healthy === false ? "unreachable" : "not running"}
          </span>
          <button
            type="button"
            className="btn small primary active:translate-y-px"
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

// Polls /api/fittings/<id>/logs every 1.5s while mounted. Auto-scrolls to
// the bottom only when the user is already pinned there, so they can scroll
// up to read without being yanked back.
function LogPanel({ fittingId }: { fittingId: string }) {
  const [content, setContent] = useState<string>("");
  const [exists, setExists] = useState<boolean>(true);
  const [truncated, setTruncated] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const preRef = useRef<HTMLPreElement | null>(null);
  const pinnedToBottomRef = useRef(true);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      try {
        const res = await fetch(`/api/fittings/${fittingId}/logs`, { cache: "no-store" });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error((data && data.error) || `HTTP ${res.status}`);
        }
        const data = (await res.json()) as {
          content: string;
          exists: boolean;
          truncated: boolean;
        };
        if (cancelled) return;
        setContent(data.content);
        setExists(data.exists);
        setTruncated(data.truncated);
        setError(null);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }

    void tick();
    const handle = setInterval(() => void tick(), 1500);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [fittingId]);

  useEffect(() => {
    const el = preRef.current;
    if (!el) return;
    if (pinnedToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [content]);

  function onScroll(e: React.UIEvent<HTMLPreElement>) {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedToBottomRef.current = distanceFromBottom < 12;
  }

  return (
    <div style={{ borderTop: "1px solid var(--rule)", background: "var(--surface-strong)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          fontSize: 11,
          color: "var(--mute)",
          borderBottom: "1px solid var(--rule)",
          background: "var(--surface-strong)"
        }}
      >
        <span style={{ fontFamily: "var(--font-mono), monospace" }}>
          ~/.garrison/ui-fittings/{fittingId}.log
        </span>
        <span style={{ flex: 1 }} />
        {truncated ? <span>tail only</span> : null}
        {!exists ? <span>no log yet — start the view to populate</span> : null}
        {loading ? <span role="status">loading…</span> : null}
        {error ? <span style={{ color: "var(--alarm)" }} role="alert">{error}</span> : null}
      </div>
      <pre
        ref={preRef}
        onScroll={onScroll}
        style={{
          margin: 0,
          padding: "10px 12px",
          fontFamily: "var(--font-mono), monospace",
          fontSize: 11.5,
          lineHeight: 1.5,
          color: "var(--paper-2)",
          background: "var(--ink)",
          maxHeight: 280,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          // Dark pane: flip the global scrollbar thumb to the faint paper
          // variant so the bar stays visible on the ink background.
          ["--sb-thumb" as string]: "rgba(242, 234, 217, 0.14)",
          ["--sb-thumb-hover" as string]: "rgba(242, 234, 217, 0.3)"
        }}
      >
        {loading ? "Loading log…" : content || "(no output captured yet)"}
      </pre>
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
        padding: "2px 7px",
        background: "var(--surface-strong)"
      }}
    >
      {label}
    </span>
  );
}

function sameConsumption(a: CapabilityConsumption, b: CapabilityConsumption): boolean {
  return a.kind === b.kind && (a.name ?? null) === (b.name ?? null) && (a.cardinality ?? "one") === (b.cardinality ?? "one");
}
