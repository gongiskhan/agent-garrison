"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { Panel } from "@/components/garrison/Panel";
import { lastSeenAge, nodeStateLabel, type NodeState } from "@/lib/mesh/staleness";
import { nodeHealth, type MeshNodeRow } from "@/lib/mesh/node-row";
import styles from "./MeshPanel.module.css";

// The mesh roster. Polls /api/mesh/nodes — the app proxies the state service so
// the browser never holds a mesh token.
//
// Two variants of one component: the full page at /mesh, and `compact` on the
// Garrison dashboard. A fork would drift.

const POLL_MS = 10_000;

interface Degraded {
  since: string | null;
  detail: string;
}

const STATE_TONE: Record<NodeState, string> = {
  ready: styles.pillReady,
  busy: styles.pillBusy,
  degraded: styles.pillDegraded,
  offline: styles.pillOffline
};

export function MeshPanel({ compact }: { compact?: boolean } = {}) {
  const [nodes, setNodes] = useState<MeshNodeRow[] | null>(null);
  const [degraded, setDegraded] = useState<Degraded | null>(null);
  // Re-render on a timer even when the roster payload has not changed: a node
  // that stops beating goes stale by the CLOCK, not by a new response, and a
  // frozen "3s ago" next to a READY pill is the exact lie this page exists to
  // prevent.
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/mesh/nodes", { cache: "no-store" });
      const body = await res.json();
      setNow(Date.now());
      if (res.ok) {
        setNodes(Array.isArray(body.nodes) ? body.nodes : []);
        setDegraded(null);
        return;
      }
      // The authority is unreachable. Drop the roster rather than keep showing
      // it: a stale roster invites acting on a node that left the mesh.
      setNodes(null);
      setDegraded({
        since: typeof body?.since === "string" ? body.since : null,
        detail:
          body?.error === "state-unavailable"
            ? "The state service is unreachable, so the mesh roster cannot be read."
            : `The mesh roster could not be read: ${body?.detail || body?.error || res.status}`
      });
    } catch (err) {
      setNodes(null);
      setDegraded({ since: null, detail: `The mesh roster could not be read: ${err instanceof Error ? err.message : String(err)}` });
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void load();
    }, POLL_MS);
    // A hidden tab stops polling, so its ages are arbitrarily old on return.
    // Reload immediately instead of showing a minute-old roster.
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    const tickAges = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(tickAges);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  if (compact) {
    return (
      <Panel title="Mesh">
        <div data-testid="mesh-panel-compact">
          {degraded ? (
            <div className={styles.compactNote}>State service unreachable — roster unknown.</div>
          ) : nodes === null ? (
            <div className={styles.compactNote}>Reading the mesh roster…</div>
          ) : nodes.length === 0 ? (
            <div className={styles.compactNote}>No nodes enrolled.</div>
          ) : (
            <ul className={styles.compactList}>
              {nodes.map((node) => (
                <li key={node.id} className={styles.compactRow}>
                  <AccentDot color={node.accentColor} />
                  <span className={styles.compactName}>
                    {node.name}
                    {node.isSelf ? <span className={styles.selfTag}>this node</span> : null}
                  </span>
                  <StatePill state={node.state} />
                </li>
              ))}
            </ul>
          )}
          <Link className={styles.compactMore} href="/mesh">
            Open the mesh
          </Link>
        </div>
      </Panel>
    );
  }

  return (
    <main>
      <div className="crumbs">
        <b>Mesh</b>
      </div>
      <div className="page">
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>Nodes</span>
            <h1>Mesh</h1>
          </div>
          <p>
            Every Garrison node in this mesh, its composition, and how long ago it last spoke. A node
            is offline after 45 seconds without a beat — three missed beats, not a guess.
          </p>
        </header>

        {degraded ? (
          <div className="banner alarm" data-testid="mesh-degraded" role="alert">
            <span className="glyph">!</span>
            <div>
              <h5>The mesh roster is unavailable</h5>
              <p>{degraded.detail}</p>
              {degraded.since ? (
                <p className="font-mono" style={{ fontSize: 11.5 }}>
                  degraded since {degraded.since}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        {nodes === null ? (
          // Never render a bare header while the first response is in flight:
          // an empty page is indistinguishable from a broken one, and the
          // degraded banner above only appears once a request has FAILED.
          degraded ? null : <p className={styles.empty}>Reading the mesh roster…</p>
        ) : nodes.length === 0 ? (
          <p className={styles.empty}>No nodes are enrolled in this mesh yet.</p>
        ) : (
          <ul className={styles.roster} data-testid="mesh-roster">
            {nodes.map((node) => (
              <NodeCard key={node.id} node={node} now={now} />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function NodeCard({ node, now }: { node: MeshNodeRow; now: number }) {
  const health = nodeHealth(node);
  const git = health.git ?? null;
  const views = health.views ?? null;
  const composition = health.composition ?? null;

  return (
    <li className={styles.card} data-testid="mesh-node" data-node={node.id} data-state={node.state}>
      <div className={styles.cardHead}>
        <AccentDot color={node.accentColor} large />
        <div className={styles.cardTitle}>
          <h2>{node.name}</h2>
          <div className={styles.cardSub}>
            {node.isSelf ? <span className={styles.selfTag}>this node</span> : null}
            {node.registered ? null : <span className={styles.warnTag}>not enrolled</span>}
            <span className="font-mono">{node.platform || "unknown platform"}</span>
          </div>
        </div>
        <StatePill state={node.state} />
      </div>

      {/* An offline node's composition, branch and view counts are whatever it
          last managed to report — possibly hours ago. Saying so is the whole
          difference between a roster and a rumour. */}
      {node.state === "offline" ? (
        <p className={styles.staleNote}>
          {node.lastSeenAt
            ? `Last report, ${lastSeenAge(node.lastSeenAt, now)}. Everything below is that report, not this node now.`
            : "This node has never reported. Nothing below is known."}
        </p>
      ) : null}

      <dl className={styles.facts}>
        <Fact label="Composition">
          {node.activeComposition ? (
            <>
              <span className="font-mono">{node.activeComposition}</span>
              {composition ? <span className={styles.factNote}> · {composition.status}</span> : null}
            </>
          ) : (
            <span className={styles.factNote}>none</span>
          )}
        </Fact>
        <Fact label="Schema">
          <span className="font-mono">{node.schemaVersion === null ? "unknown" : `v${node.schemaVersion}`}</span>
          {node.status === "behind" ? <span className={styles.factWarn}> · writes refused</span> : null}
        </Fact>
        <Fact label="Last seen">
          <span className="font-mono">{lastSeenAge(node.lastSeenAt, now)}</span>
        </Fact>
        <Fact label="Branch">
          {git?.branch ? (
            <>
              <span className="font-mono">{git.branch}</span>
              {git.dirty > 0 ? <span className={styles.factWarn}> · {git.dirty} dirty</span> : null}
              {git.ahead > 0 || git.behind > 0 ? (
                <span className={styles.factNote}> · +{git.ahead} -{git.behind}</span>
              ) : null}
            </>
          ) : (
            <span className={styles.factNote}>unknown</span>
          )}
        </Fact>
        <Fact label="Views">
          {views ? (
            // A short view count is usually WHY a node reads DEGRADED, so it is
            // toned to match rather than left as a number to cross-reference.
            <span className={clsx("font-mono", views.healthy < views.total && styles.factWarn)}>
              {views.healthy} / {views.total}
            </span>
          ) : (
            <span className={styles.factNote}>unknown</span>
          )}
        </Fact>
        <Fact label="Build">
          <span className="font-mono">{node.clientVersion || "unknown"}</span>
        </Fact>
      </dl>

      {node.tailnetHost ? (
        // A cross-origin NAVIGATION, not an embed: each node is its own HTTPS
        // origin on the tailnet, so opening it in a tab is the one thing that
        // needs no host allowance.
        <a className={styles.open} href={`https://${node.tailnetHost}`} target="_blank" rel="noreferrer">
          Open {node.name}
          <span aria-hidden> →</span>
        </a>
      ) : (
        <span className={styles.openMissing}>No tailnet host recorded — this node cannot be opened from here.</span>
      )}
    </li>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function StatePill({ state }: { state: NodeState }) {
  return (
    <span className={clsx(styles.pill, STATE_TONE[state])} data-testid="mesh-state-pill">
      {nodeStateLabel(state)}
    </span>
  );
}

function AccentDot({ color, large }: { color: string; large?: boolean }) {
  return (
    <span
      className={clsx(styles.dot, large && styles.dotLarge)}
      style={{ background: color }}
      aria-hidden
    />
  );
}
