"use client";

import { useState } from "react";
import { ownPortDefaultPort } from "@/lib/faculties";
import { useFittingViewStatus } from "./useFittingViewStatus";
import { resolveViewUrl } from "./browser-view-url";
import { LogPanel, OwnPortControls } from "./FittingOverview";
import type { LibraryEntry } from "@/lib/types";

// The /fitting/<id> surface for an own-port Fitting: its UI lives on its own
// port (embedded at /embed/<id> when live), so this page is the status +
// controls + logs strip — not a config page. Fittings start and stop with the
// composition; the controls here are for recovery and code reloads.
export function OwnPortStatusPanel({ entry }: { entry: LibraryEntry }) {
  const { entries: viewStatuses, refresh } = useFittingViewStatus(5000);
  const view = viewStatuses.find((t) => t.fittingId === entry.id) ?? null;
  const defaultPort = ownPortDefaultPort(entry);
  const [logsOpen, setLogsOpen] = useState(false);
  const reachable = view && view.healthy === true ? resolveViewUrl(view) : null;

  return (
    <section
      style={{
        background: "var(--surface)",
        border: "1px solid var(--rule)",
        borderLeft: "2px solid var(--brass)"
      }}
    >
      <div
        style={{
          padding: "13px 15px",
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
            <b style={{ fontSize: 13 }}>Own-port UI</b>
            <span
              className="font-mono"
              style={{
                fontSize: 9.5,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--mute)"
              }}
            >
              {view?.healthy === true ? "live" : view?.healthy === false ? "unreachable" : "offline"}
            </span>
          </div>
          <p style={{ margin: "5px 0 0", fontSize: 12, lineHeight: 1.6, color: "var(--mute)" }}>
            Starts and stops with the composition.
            {defaultPort ? (
              <>
                {" · default "}
                <code style={{ fontFamily: "var(--font-mono), monospace" }}>:{defaultPort}</code>
              </>
            ) : null}
            {reachable ? (
              <>
                {" · live at "}
                <code
                  style={{
                    fontFamily: "var(--font-mono), monospace",
                    overflowWrap: "anywhere"
                  }}
                >
                  {reachable}
                </code>
              </>
            ) : null}
          </p>
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
    </section>
  );
}
