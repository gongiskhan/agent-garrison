"use client";

import Link from "next/link";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { Play, Square } from "lucide-react";
import { useAppShell } from "@/components/chrome/AppShell";
import { PageSkeleton } from "@/components/chrome/PageSkeleton";
import { RunConsole } from "@/components/run/RunPanel";
import { SessionLogPanel } from "@/components/garrison/SessionLogPanel";
import { faculties } from "@/lib/faculties";
import type { BoardSummary } from "@/lib/board-summary";
import type { RunnerState } from "@/lib/types";
import styles from "./GarrisonHome.module.css";
import { resolveViewUrl } from "@/components/fitting-views/browser-view-url";
import type { Correction, CorrectionField, Verdict } from "@/lib/decision-verdicts";
import {
  fetchRouteOptions,
  postVerdict,
  verdictPayload,
  type FeedbackDecision,
  type RouteOptionsResponse
} from "@/lib/decision-feedback";
import { RouterFeedbackCard } from "./RouterFeedbackCard";
import { OutboxStrip } from "./OutboxStrip";

export function GarrisonHome() {
  const {
    composition,
    runnerState,
    vaultUnlocked,
    vaultKeySource,
    runAction,
    busy,
    error,
    refreshAll
  } = useAppShell();

  if (!composition) {
    if (error) {
      return (
        <main>
          <div className="page dash">
            <section className={styles.bootstrapFailure} role="alert">
              <span className={styles.eyebrow}>Command link unavailable</span>
              <h1>Garrison could not read the active composition.</h1>
              <p>{error}</p>
              <button className="btn primary" onClick={() => void refreshAll()}>
                Try the connection again
              </button>
            </section>
          </div>
        </main>
      );
    }
    return <PageSkeleton label="Loading Agent Garrison: reading the composition manifest" />;
  }

  const status = runnerState?.status ?? "idle";
  const isRunning = status === "running";
  const verifyResults = runnerState?.verifyResults ?? [];
  const verifyTotal = verifyResults.length;
  const verifyOk = verifyResults.filter((r) => r.ok).length;
  const stationed = Object.keys(composition.selections ?? {}).filter((k) => {
    const sel = composition.selections[k as keyof typeof composition.selections];
    return Array.isArray(sel) && sel.length > 0;
  }).length;

  const greeting = greetingForNow();
  const orchestratorMissing =
    !composition.selections.orchestrator || composition.selections.orchestrator.length === 0;

  return (
    <main>
      <div className="crumbs">
        <b>Garrison</b>
      </div>
      <div className="page dash">
        <section className={styles.commandDeck}>
          <div className={styles.commandCopy}>
            <div className={styles.eyebrow}>
              {formatNowStamp()}
            </div>
            <h1 className="font-display">
              {greeting}
            </h1>
            <p>
              {operativeSummary(status, verifyTotal, verifyOk)}
            </p>
          </div>
          <div className={styles.commandControls}>
            <div className={styles.commandReadout}>
              <span>operative state</span>
              <strong>{status}</strong>
              <small>
                {verifyTotal ? `${verifyOk}/${verifyTotal} verified` : "verification pending"}
              </small>
            </div>
            <div className={styles.commandActions}>
              <button data-testid="operative-run" className="btn primary" onClick={() => void runAction("up")} disabled={Boolean(busy)}>
                <span className="ic"><Play size={14} aria-hidden /></span>
                {isRunning ? "Restart operative" : "Run operative"}
              </button>
              {isRunning ? (
                <button className="btn danger" onClick={() => void runAction("down")} disabled={Boolean(busy)}>
                  <span className="ic"><Square size={13} aria-hidden /></span>Stop
                </button>
              ) : null}
              <button
                className="btn"
                title="Force apm install + setup hooks + verify even when the composition is unchanged"
                onClick={() => void runAction("up-full")}
                disabled={Boolean(busy)}
              >
                Full verify run
              </button>
            </div>
          </div>
        </section>

        {orchestratorMissing ? (
          <div className="banner alarm">
            <span className="glyph">!</span>
            <div>
              <h5>Orchestrator station is empty</h5>
              <p>
                The Operative needs a single governing Fitting to assemble its system prompt. Until one is
                stationed, the runner falls back to a stub orchestrator.
              </p>
              <div className="actions">
                <Link href="/compose/orchestrator">Open Orchestrator station →</Link>
              </div>
            </div>
          </div>
        ) : null}

        {/* Above the dossier on purpose: a cancel window is 60 seconds long, so
            it has to be the first thing on the page, not a panel below the
            fold. Renders nothing at all when nothing is parked. */}
        <OutboxStrip />

        <article className={styles.operativeDossier}>
          <div className={styles.dossierHead}>
            <div>
              <span className={styles.eyebrow}>Active composition</span>
              <h2 className="font-display">
                {composition.name}
              </h2>
              <div className={styles.manifestPath}>
                manifest · {composition.manifestPath}
              </div>
            </div>
            <span className={clsx("pill", isRunning && "live", statusToneClass(status))}>
              {isRunning ? <span className="dot" /> : null}
              {status}
            </span>
          </div>

          <div className="dash-stats">
            <Stat
              label="Status"
              value={status}
              tone={isRunning ? "ok" : "default"}
              sub={runnerState?.startedAt ? `since ${shortTime(runnerState.startedAt)}` : undefined}
            />
            <Stat
              label="Verify"
              value={verifyTotal ? `${verifyOk} / ${verifyTotal}` : "—"}
              tone={verifyTotal && verifyOk === verifyTotal ? "ok" : "default"}
              sub={verifyTotal ? "all hooks pass" : "not run"}
            />
            <Stat
              label="Faculties"
              value={`${stationed} / ${faculties.length}`}
              sub="stationed"
            />
            <Stat
              label="PID"
              value={runnerState?.pid ? String(runnerState.pid) : "—"}
              mono
              sub="claude code"
            />
          </div>
        </article>

        <div className={styles.intelligenceGrid}>
          <Panel title="Orders" tight feature>
            <Quick href="/muster" nm="Muster the composition" sm={`Station or replace Fittings across ${faculties.length} Faculties`} />
            <Quick href="/quarters" nm="Quarters" sm="Skills, hooks, MCPs, settings" />
            <Quick
              href="/vault"
              nm="Vault"
              sm={`Secrets sealed by ${vaultKeySource || "the OS keychain"}`}
            />
          </Panel>

          <Panel title="Readiness">
            <ReadyRow label="Faculties stationed" value={`${stationed} / ${faculties.length}`} />
            <ReadyRow
              label="Capability wiring"
              value={composition.capabilityIssues.length === 0 ? "resolved" : `${composition.capabilityIssues.length} issue${composition.capabilityIssues.length === 1 ? "" : "s"}`}
              tone={composition.capabilityIssues.length === 0 ? "ok" : "alarm"}
            />
            <ReadyRow
              label="Vault seal"
              value={vaultUnlocked ? "ready" : "sealed"}
              tone={vaultUnlocked ? "ok" : "default"}
            />
            <ReadyRow
              label="Verify hooks"
              value={verifyTotal ? `${verifyOk} / ${verifyTotal}` : "not run"}
              tone={verifyTotal && verifyOk === verifyTotal ? "ok" : "default"}
            />
          </Panel>

          <BoardPanel />
          <RouterPanel />

          {composition.derivedTasks ? (
            <Panel title={`Tasks · ${prettySource(composition.derivedTasks.source)}`}>
              <div className="font-mono" style={{ color: "var(--mute)", fontSize: 11.5, marginBottom: 8 }}>
                truth file · {composition.derivedTasks.truthFile}
              </div>
              <div style={{ fontSize: 13, color: "var(--mute)" }}>
                The stationed data source declares the truth file; the derived Tasks Faculty
                follows it automatically.
              </div>
            </Panel>
          ) : null}
        </div>

        <section className={styles.runtimeSection}>
          <div className={styles.runtimeHeading}>
            <span>Live field log</span>
            <small>runner · local ring buffer</small>
          </div>
          <RunConsole />
          <SessionLogPanel />
        </section>
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  tone,
  sub,
  mono
}: {
  label: string;
  value: string;
  tone?: "ok" | "default";
  sub?: string;
  mono?: boolean;
}) {
  return (
    <div className={styles.stat}>
      <div className={styles.statLabel}>
        {label}
      </div>
      <div
        className={clsx(
          styles.statValue,
          mono ? "font-mono" : "font-display",
          tone === "ok" && styles.statOk
        )}
      >
        {value}
      </div>
      {sub ? (
        <div className={styles.statSub}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

const ATTENTION_TITLES_SHOWN = 5;

// ── The router, and the one question worth asking about it ──────────────────
//
// The improver has been invisible for two concrete reasons: its review queue is
// an own-port view nobody visits, and its Probe asks questions by blocking a
// Claude Code Stop hook — so the only place it could ever speak was the raw
// terminal session this whole run exists to make unnecessary. Zero verdicts had
// ever been recorded.
//
// So the question comes to the page he already opens, and answering it is one
// tap. The panel also shows WHY the router is trusted or not: the bands, and the
// signals that produced them, because an autonomy level you cannot interrogate
// is just an assertion.
function RouterPanel() {
  const [tracks, setTracks] = useState<RouterTracks | null>(null);
  const [latest, setLatest] = useState<FeedbackDecision | null>(null);
  const [answered, setAnswered] = useState<Verdict | null>(null);
  const [failed, setFailed] = useState(false);
  const [options, setOptions] = useState<RouteOptionsResponse | null>(null);
  const [openField, setOpenField] = useState<CorrectionField | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [a, d] = await Promise.all([
          fetch("/api/orchestrator/autonomy").then((r) => (r.ok ? r.json() : null)),
          fetch("/api/orchestrator/decisions?limit=1").then((r) => (r.ok ? r.json() : null))
        ]);
        if (cancelled) return;
        if (a) setTracks(a as RouterTracks);
        const row = (d?.decisions ?? d?.rows ?? [])[0] ?? null;
        if (row) setLatest(row as FeedbackDecision);
      } catch {
        // Quiet on failure, like every other panel here: a dashboard should not
        // shout about a feed that simply is not there.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // The routing vocabulary costs a gateway round trip and almost every visit to
  // this page never opens a menu, so it is read on the first correction rather
  // than on the 60s poll.
  const openDimension = (field: CorrectionField) => {
    setOpenField((prev) => (prev === field ? null : field));
    if (!options) void fetchRouteOptions().then(setOptions);
  };

  const answer = async (verdict: Verdict, correction?: Correction) => {
    if (!latest?.id) return;
    setAnswered(verdict); // optimistic: the answer is recorded, the panel moves on
    setOpenField(null);
    setFailed(false);
    try {
      await postVerdict(verdictPayload(latest, verdict, correction));
    } catch {
      // Put the card back rather than leaving a "thanks" over a verdict that
      // never landed.
      setAnswered(null);
      setFailed(true);
    }
  };

  const asking = tracks?.asking ?? 0;
  const autonomous = tracks?.autonomous ?? 0;
  const total = tracks?.tracks?.length ?? 0;

  return (
    <Panel title="Router">
      {total === 0 ? (
        <p className={styles.panelNote}>
          No routing decisions judged yet. The router asks before acting until it has a
          track record.
        </p>
      ) : (
        <p className={styles.panelNote}>
          {autonomous} of {total} work shapes run unattended; {asking} still ask first.
        </p>
      )}

      {latest && !answered ? (
        <RouterFeedbackCard
          decision={latest}
          options={options}
          openField={openField}
          failed={failed}
          onOpenField={openDimension}
          onConfirm={() => void answer("right")}
          onWrong={() => void answer("wrong")}
          onCorrect={(field, value) => void answer("wrong", { [field]: value } as Correction)}
        />
      ) : null}
      {answered ? <p className={styles.panelNote}>Recorded. Thanks.</p> : null}

      <ul className={styles.routerBands}>
        {(tracks?.tracks ?? []).slice(0, 5).map((t) => (
          <li key={`${t.category}:${t.shape}`}>
            <span className={styles.routerShape}>
              {t.shape} <em>{t.category}</em>
            </span>
            <span className={styles.routerBand} data-band={t.band.band}>
              {t.band.band}
            </span>
            <span className={styles.routerObs}>{t.observations} obs</span>
          </li>
        ))}
      </ul>
      <Link className={styles.panelMore} href="/muster?section=decisions">
        Decisions log
      </Link>
    </Panel>
  );
}

interface RouterTracks {
  asking: number;
  autonomous: number;
  tracks: {
    category: string;
    shape: string;
    observations: number;
    signals: Record<string, number>;
    band: { band: string; confidence: number };
  }[];
}

function BoardPanel() {
  const [summary, setSummary] = useState<BoardSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    // A failed fetch used to wait the full poll interval before trying again,
    // and until it succeeded the panel rendered "Board idle" - a state
    // indistinguishable from a genuinely quiet board. So one slow first response
    // showed the reader a confidently wrong dashboard for thirty seconds. Retry
    // quickly instead, backing off to the steady cadence, so a transient failure
    // costs seconds rather than half a minute.
    let retryMs = 2_000;
    const schedule = (ms: number) => {
      if (cancelled) return;
      timer = window.setTimeout(() => void load(), ms);
    };
    const load = async () => {
      try {
        const res = await fetch("/api/board/summary");
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as BoardSummary;
        if (cancelled) return;
        setSummary(data);
        retryMs = 2_000;
        schedule(30_000);
      } catch {
        // Keep the last known state; the panel stays quiet on a fetch failure.
        schedule(retryMs);
        retryMs = Math.min(retryMs * 2, 30_000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  // Loading and fetch-failure render the idle state — a dashboard panel
  // should never show an error banner for a board that simply isn't there.
  const active = summary && !summary.idle ? summary : null;
  const allTitles = active?.needsAttentionCards ?? [];
  const shownTitles = allTitles.slice(0, ATTENTION_TITLES_SHOWN);
  const extraTitles = allTitles.length - shownTitles.length;
  // Resolve against the host the reader actually reached Garrison on. Linking
  // active.boardUrl verbatim sent a remote browser to its OWN 127.0.0.1 - a dead
  // link everywhere except on the box itself. "" means no route from here, so
  // callers fall through to an unlinked row rather than a broken one.
  const boardHref = resolveViewUrl({
    url: active?.boardUrl ?? null,
    tailnetUrl: active?.boardTailnetUrl ?? null
  });

  return (
    <Panel title="Board">
      <div data-testid="board-panel">
        {active ? (
          <>
            <ReadyRow
              label="Running"
              value={String(active.running)}
              tone={active.running > 0 ? "ok" : "default"}
            />
            <ReadyRow
              label="Needs attention"
              value={String(active.needsAttention)}
              tone={active.needsAttention > 0 ? "alarm" : "default"}
            />
            <ReadyRow label="Done" value={String(active.done)} />
            {shownTitles.length > 0 ? (
              <div style={{ marginTop: 10, borderTop: "1px solid var(--rule)", paddingTop: 8 }}>
                <div className="font-mono" style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--mute)", marginBottom: 4 }}>
                  Attention queue
                </div>
                {shownTitles.map((card) => {
                  const rowStyle = {
                    display: "flex",
                    alignItems: "baseline",
                    gap: 7,
                    fontSize: 12.5,
                    color: "var(--ink-2)",
                    textDecoration: "none",
                    padding: "3px 0",
                    minWidth: 0
                  } as const;
                  const titleStyle = {
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                    flex: 1
                  } as const;
                  const bullet = (
                    <span aria-hidden style={{ width: 6, height: 6, background: "var(--alarm)", flexShrink: 0, alignSelf: "center" }} />
                  );
                  return boardHref ? (
                    <a key={card.id} href={boardHref} target="_blank" rel="noreferrer" title={card.reason ?? card.title} style={rowStyle}>
                      {bullet}
                      <span style={titleStyle}>{card.title}</span>
                    </a>
                  ) : (
                    <span key={card.id} title={card.reason ?? card.title} style={rowStyle}>
                      {bullet}
                      <span style={titleStyle}>{card.title}</span>
                    </span>
                  );
                })}
                {extraTitles > 0 ? (
                  // The panel is one of several on a dashboard, so it stays
                  // capped rather than growing without bound - but the overflow
                  // must not be a dead end. It said "+3 more" and offered no way
                  // to see them; now it is the way. Unlinked only when no route
                  // to the board exists from where this page was opened.
                  boardHref ? (
                    <a
                      className="font-mono"
                      data-testid="board-attention-more"
                      href={boardHref}
                      target="_blank"
                      rel="noreferrer"
                      style={{ display: "inline-block", fontSize: 10.5, color: "var(--mute)", marginTop: 4 }}
                    >
                      +{extraTitles} more on the board
                    </a>
                  ) : (
                    <div className="font-mono" data-testid="board-attention-more" style={{ fontSize: 10.5, color: "var(--mute)", marginTop: 4 }}>
                      +{extraTitles} more
                    </div>
                  )
                ) : null}
              </div>
            ) : null}
          </>
        ) : (
          <div style={{ fontSize: 13, color: "var(--mute)" }}>
            Board idle. Nothing running, nothing needing attention.
            {summary && summary.done > 0 ? (
              <div className="font-mono" style={{ fontSize: 10.5, marginTop: 6 }}>
                {summary.done} done
              </div>
            ) : null}
          </div>
        )}
      </div>
    </Panel>
  );
}

function Panel({
  title,
  children,
  tight,
  feature
}: {
  title: string;
  children: React.ReactNode;
  tight?: boolean;
  feature?: boolean;
}) {
  return (
    <section
      className={clsx(
        styles.panel,
        tight && styles.panelTight,
        feature && styles.panelFeature
      )}
    >
      <h4 className={styles.panelTitle}>
        {title}
      </h4>
      {children}
    </section>
  );
}

function Quick({
  href,
  nm,
  sm,
  alarm
}: {
  href: string;
  nm: string;
  sm: string;
  alarm?: boolean;
}) {
  return (
    <Link
      href={href}
      className={styles.quick}
    >
      <div>
        <div className={styles.quickName}>{nm}</div>
        <div className={clsx(styles.quickSummary, alarm && styles.quickAlarm)}>
          {sm}
        </div>
      </div>
      <span className={styles.quickArrow}>
        →
      </span>
    </Link>
  );
}

function ReadyRow({
  label,
  value,
  tone
}: {
  label: string;
  value: string;
  tone?: "ok" | "alarm" | "default";
}) {
  return (
    <div className={styles.readyRow}>
      <span>{label}</span>
      <span
        className={clsx(
          styles.readyValue,
          tone === "ok" && styles.readyOk,
          tone === "alarm" && styles.readyAlarm
        )}
      >
        {value}
      </span>
    </div>
  );
}

function greetingForNow(): string {
  const h = new Date().getHours();
  if (h < 6) return "Late again, Gonçalo.";
  if (h < 12) return "Good morning, Gonçalo.";
  if (h < 18) return "Good afternoon, Gonçalo.";
  return "Good evening, Gonçalo.";
}

function formatNowStamp(): string {
  const d = new Date();
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${days[d.getDay()]} · ${d.getDate()} ${months[d.getMonth()]} · ${hh}:${mm}`;
}

function statusToneClass(status: RunnerState["status"] | string | undefined): string {
  if (status === "running") return "";
  if (status === "failed") return "alarm";
  if (status === "starting" || status === "verifying" || status === "stopping") return "warn";
  return "idle";
}

function prettySource(source: string): string {
  return source.charAt(0).toUpperCase() + source.slice(1);
}

function operativeSummary(status: string, verifyTotal: number, verifyOk: number): string {
  if (status === "running") {
    return verifyTotal && verifyOk === verifyTotal
      ? "One operative running. Verify clean. Heartbeat keeps the loop ticking."
      : "One operative running. Verify partial — see the run console below for hook-by-hook detail.";
  }
  if (status === "starting" || status === "verifying") {
    return "Bringing the operative up. APM install in progress, verify pending.";
  }
  if (status === "stopping") {
    return "Tearing down. Materialised .env will be wiped when this completes.";
  }
  if (status === "failed") {
    return "Last run ended in failure. See the run console below for the runtime log.";
  }
  return "Operative is idle. Press Run to install Fittings, verify, and start it.";
}
function shortTime(iso: string): string {
  try {
    return iso.split("T")[1]?.slice(0, 8).replace(/Z?$/, "Z") ?? iso;
  } catch {
    return iso;
  }
}
