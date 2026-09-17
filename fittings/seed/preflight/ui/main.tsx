// Preflight UI — one page: a dark topbar with the language toggle, the verdict
// banner, the headline naming WHAT is broken, collapsible check sections with
// each finding's fix beside it, the explicit (heavy) verify sweep, and the
// journal of what the doctor did.
//
// Chrome strings come from lib/i18n.mjs and flip client-side; diagnostic prose
// arrives from the server already rendered in the requested language, so a
// language flip is a refetch, never a client-side retranslation.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
// @ts-ignore — the fitting's standalone module deliberately has no TS dependency.
import { DEFAULT_LANG, LOCALE, fmtDateTime, fmtTime, normaliseLang, t as translate } from "../lib/i18n.mjs";

type Lang = "en" | "pt";

type Finding = {
  check: string;
  id: string;
  status: "info" | "pass" | "warn" | "fail";
  detail: string;
  evidence?: string;
  fix?: string;
  action?: { id: string; params: Record<string, unknown>; command: string };
  age?: "new" | "ongoing" | "regressed";
  previousStatus?: string;
};

type FixEntry = { at: string; actionId: string; params: Record<string, unknown>; ok: boolean; detail?: string; error?: string; resolved?: boolean | null };

type Report = {
  findings: Finding[];
  summary: { overall: string; counts: { info?: number; pass: number; warn: number; fail: number } };
  degraded: boolean;
  appUp: boolean;
  lang?: string;
  compositions?: string[];
  sweepableCompositions?: string[];
  activeComposition?: string | null;
  fileCards?: boolean;
  resolved?: { key: string; lastStatus: string; lastSeenAt: string }[];
  recentFixes?: FixEntry[];
  libraryDiff?: string | null;
  libraryDiffHash?: string | null;
  generatedAt: string;
};

const CHECK_ORDER = [
  "app-reachable", "repo-root", "manifest-parse", "verify-results", "verify-sweep", "library-crosscheck",
  "port-collisions", "serve-coverage", "orphans", "drift", "kind-vocabulary", "hook-cwd", "config-projection", "ledger"
];

// The per-browser preference. The server's `language` config is only the
// default a fresh browser adopts; once the operator has flipped, this wins.
// No cookie: the page is a static SPA that already sends ?lang= on the API
// call, so a cookie would be a second source of truth for the same fact.
const LANG_KEY = "preflight.lang";
function readStoredLang(): Lang | null {
  try {
    const raw = window.localStorage.getItem(LANG_KEY);
    return raw ? (normaliseLang(raw) as Lang) : null;
  } catch { return null; }
}
function storeLang(lang: Lang) {
  try { window.localStorage.setItem(LANG_KEY, lang); } catch { /* private mode: the flip still applies this session */ }
}

type T = (key: string, vars?: Record<string, unknown>) => string;

function StatusPip({ status, t }: { status: string; t: T }) {
  return <span className={`pip pip-${status}`} title={t(`status.${status}`)} />;
}

// Executes a finding's whitelisted fix action after an explicit confirm that
// shows exactly what will run. The refresh happens on the next poll (or the
// refresh button) so the row's outcome is visible immediately in place.
function FixButton({ f, t, lang, onSweep }: { f: Finding; t: T; lang: Lang; onSweep?: (compositionId: string) => void }) {
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const run = async () => {
    if (!f.action) return;
    // The sweep is not a fixers.mjs action — route it to the sweep flow,
    // which owns the heavy-op confirm and the busy-guard.
    if (f.action.id === "verify-sweep") {
      onSweep?.(String(f.action.params.compositionId));
      return;
    }
    if (!window.confirm(t("fix.confirm", { id: f.id, command: f.action.command }))) return;
    setState("running");
    try {
      const res = await fetch(`/api/fix?lang=${lang}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId: f.action.id, params: f.action.params })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setState("done");
      setMessage(data.detail || "ok");
    } catch (err) {
      setState("error");
      setMessage(String((err as Error).message || err));
    }
  };
  if (state === "done") return <div className="fix-result fix-ok">✓ {t("fix.done", { message })}</div>;
  if (state === "error") return <div className="fix-result fix-err">✗ {message}<br /><button className="fix-btn" onClick={run}>{t("fix.retry")}</button></div>;
  return (
    <button className="fix-btn" onClick={run} disabled={state === "running"} title={f.action?.command}>
      {state === "running" ? t("fix.running") : t("fix.button")}
    </button>
  );
}

// Offered only on failures that carry no mechanical repair, so it never
// competes with a "Fix it" that would actually solve the problem.
function FileCardButton({ f, t }: { f: Finding; t: T }) {
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const run = async () => {
    if (!window.confirm(t("card.confirm", { check: f.check, id: f.id }))) return;
    setState("running");
    try {
      const res = await fetch("/api/fix", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId: "file-card", params: { check: f.check, id: f.id } })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setState("done");
      setMessage(data.detail || "ok");
    } catch (err) {
      setState("error");
      setMessage(String((err as Error).message || err));
    }
  };
  if (state === "done") return <div className="fix-result fix-ok">✓ {message}</div>;
  if (state === "error") return <div className="fix-result fix-err">✗ {message}</div>;
  return <button className="fix-btn" onClick={run} disabled={state === "running"}>{state === "running" ? t("card.running") : t("card.button")}</button>;
}

function FindingRow({ f, t, lang, onSweep, fileCards }: { f: Finding; t: T; lang: Lang; onSweep?: (compositionId: string) => void; fileCards?: boolean }) {
  const [open, setOpen] = useState(false);
  // Ids in verify/drift checks are "composition:fitting" — render the
  // composition as a muted prefix badge so the FITTING reads as the subject
  // (a joined "default-2:basic-memory" looks like one odd name).
  const parts = f.id.includes(":") ? f.id.split(":") : null;
  return (
    <div className={`finding finding-${f.status}`}>
      <div className="finding-head">
        <StatusPip status={f.status} t={t} />
        {parts ? (
          <span className="finding-id">
            <span className="comp-badge">{parts[0]}</span>
            {parts.slice(1).join(":")}
          </span>
        ) : (
          <span className="finding-id">{f.id}</span>
        )}
        {f.age === "new" && <span className="age-chip age-new">{t("age.new")}</span>}
        {f.age === "regressed" && <span className="age-chip age-regressed">{t("age.regressed", { status: f.previousStatus })}</span>}
        <span className="finding-detail">{f.detail}</span>
      </div>
      {f.fix && <div className="finding-fix">{t("fix.label")} {f.fix}</div>}
      {f.action && <FixButton f={f} t={t} lang={lang} onSweep={onSweep} />}
      {!f.action && f.status === "fail" && fileCards && <FileCardButton f={f} t={t} />}
      {f.evidence && (
        <div>
          <button className="linkish" onClick={() => setOpen(!open)}>
            {open ? t("evidence.hide") : t("evidence.show")}
          </button>
          {open && <pre className="evidence">{f.evidence}</pre>}
        </div>
      )}
    </div>
  );
}

function Section({ check, findings, t, lang, onSweep, fileCards }: { check: string; findings: Finding[]; t: T; lang: Lang; onSweep?: (compositionId: string) => void; fileCards?: boolean }) {
  // info ranks BELOW pass: a section holding only informational rows is not a
  // green success, it is "checked, nothing to do" — and it stays collapsed.
  const RANK: Record<string, number> = { info: 0, pass: 1, warn: 2, fail: 3 };
  const worst = findings.reduce<string>((acc, f) => (RANK[f.status] > RANK[acc] ? f.status : acc), "info");
  const [open, setOpen] = useState(RANK[worst] > 1);
  useEffect(() => setOpen(RANK[worst] > 1), [worst]);
  const title = t(`check.${check}`);
  return (
    <section className="check">
      <header className={`check-head${open ? " open" : ""}`} onClick={() => setOpen(!open)}>
        <StatusPip status={worst} t={t} />
        <h2>{title === `check.${check}` ? check : title}</h2>
        <span className="count">{t("section.rows", { n: findings.length })}</span>
        <span className="chev">{open ? "▾" : "▸"}</span>
      </header>
      {open && findings.map((f, i) => <FindingRow key={`${f.id}:${i}`} f={f} t={t} lang={lang} onSweep={onSweep} fileCards={fileCards} />)}
    </section>
  );
}

// The persistent trace of what the doctor DID. A fixed row disappears from
// the checks on refresh — that means the detector re-measured and passes —
// but the action itself stays visible and auditable here.
function ResolvedBadge({ resolved, t }: { resolved?: boolean | null; t: T }) {
  if (resolved === true) return <span className="res-badge res-ok">{t("res.ok")}</span>;
  if (resolved === false) return <span className="res-badge res-bad">{t("res.bad")}</span>;
  return null;
}

function FixJournal({ entries, libraryDiff, libraryDiffHash, t, lang, onChanged }: { entries: FixEntry[]; libraryDiff?: string | null; libraryDiffHash?: string | null; t: T; lang: Lang; onChanged: () => void }) {
  const [open, setOpen] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [commitMsg, setCommitMsg] = useState<string | null>(null);

  const commitLibrary = async () => {
    if (!libraryDiffHash) return;
    if (!window.confirm(t("journal.commitConfirm"))) return;
    setCommitting(true);
    setCommitMsg(null);
    try {
      const res = await fetch("/api/fix", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId: "git-commit-library", params: { diffHash: libraryDiffHash } })
      });
      const data = await res.json();
      setCommitMsg(data.ok ? `✓ ${data.detail}` : `✗ ${data.error}`);
      if (data.ok) onChanged();
    } catch (err) {
      setCommitMsg(`✗ ${String(err)}`);
    } finally {
      setCommitting(false);
    }
  };

  return (
    <section className="check journal">
      <header className={`check-head${open ? " open" : ""}`} onClick={() => setOpen(!open)}>
        <span className="pip pip-pass" />
        <h2>{t("journal.title")}</h2>
        <span className="count">{t("section.rows", { n: entries.length })}</span>
        <span className="chev">{open ? "▾" : "▸"}</span>
      </header>
      {open && (
        <>
          {libraryDiff && (
            <div className="finding pending-commit">
              <div className="finding-head">
                <span className="pip pip-warn" />
                <span className="finding-id">{t("journal.uncommitted")}</span>
                <span className="finding-detail">{t("journal.review")}</span>
              </div>
              <pre className="evidence">{libraryDiff}</pre>
              <button className="fix-btn" onClick={commitLibrary} disabled={committing || !libraryDiffHash}>
                {committing ? t("journal.committing") : t("journal.commit")}
              </button>
              {commitMsg && <div className="finding-fix">{commitMsg}</div>}
            </div>
          )}
          {entries.map((e, i) => (
            <div key={i} className="finding">
              <div className="finding-head">
                <span className={`pip pip-${e.ok ? "pass" : "fail"}`} />
                <span className="finding-id">{e.actionId}</span>
                <span className="finding-detail">{e.ok ? e.detail : t("journal.failed", { error: e.error })}</span>
                <ResolvedBadge resolved={e.resolved} t={t} />
              </div>
              <div className="finding-fix">
                {fmtDateTime(lang, e.at)} · {t("journal.params")} {JSON.stringify(e.params)}
              </div>
            </div>
          ))}
        </>
      )}
    </section>
  );
}

function TopBar({ t, lang, onLang, onRefresh, busy }: { t: T; lang: Lang; onLang: (l: Lang) => void; onRefresh: () => void; busy: boolean }) {
  return (
    <div className="topbar">
      <div className="topbar-inner">
        <div>
          <h1>{t("app.title")}</h1>
          <p className="sub">{t("app.subtitle")}</p>
        </div>
        <div className="topbar-actions">
          <div className="lang-toggle" role="group" aria-label="language" title={t("lang.title")}>
            <button aria-pressed={lang === "en"} onClick={() => onLang("en")} disabled={busy}>{t("lang.en")}</button>
            <button aria-pressed={lang === "pt"} onClick={() => onLang("pt")} disabled={busy}>{t("lang.pt")}</button>
          </div>
          <button onClick={onRefresh} disabled={busy}>{busy ? t("refresh.busy") : t("refresh")}</button>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [sweep, setSweep] = useState<{ compositionId: string; findings: Finding[] } | null>(null);
  const [comp, setComp] = useState<string>("");
  const [fittingFilter, setFittingFilter] = useState<string | null>(null);
  // null until either the stored preference or the server's default is known;
  // the chrome renders in English for that first instant, never the wrong
  // language for a whole report.
  const [lang, setLang] = useState<Lang | null>(() => readStoredLang());
  const inflight = useRef<AbortController | null>(null);

  const uiLang: Lang = lang ?? (DEFAULT_LANG as Lang);
  const t = useCallback<T>((key, vars) => translate(uiLang, key, vars), [uiLang]);

  useEffect(() => { document.documentElement.lang = LOCALE[uiLang]; }, [uiLang]);

  const refresh = useCallback(async () => {
    // A flip aborts the outstanding fetch: an English report must never land
    // after the Portuguese one and stick.
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    try {
      const res = await fetch(`/api/report${lang ? `?lang=${lang}` : ""}`, { signal: ctrl.signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      if (!Array.isArray(data?.findings) || !data?.summary?.counts || typeof data.summary.overall !== "string") {
        throw new Error("Preflight returned an invalid report");
      }
      if (ctrl.signal.aborted) return;
      setReport(data);
      setError(null);
      // First load with no stored preference: adopt the node's configured
      // default, which the server echoes beside the findings it rendered in it.
      if (!lang && typeof data.lang === "string") setLang(normaliseLang(data.lang) as Lang);
      // Never default to compositions[0]: that is whatever sorts first, and it
      // left the heavy-sweep button armed on a composition nobody uses. The
      // ACTIVE composition is the one the operator means; when it is running
      // (and so not sweepable) a disabled button is the correct answer.
      if (!comp && data.compositions?.length) {
        const preferred =
          (data.activeComposition && data.compositions.includes(data.activeComposition) && data.activeComposition) ||
          data.sweepableCompositions?.[0] ||
          data.compositions[0];
        setComp(preferred);
      }
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setError(String(err));
    }
  }, [comp, lang]);

  useEffect(() => {
    refresh();
    const id = setInterval(() => {
      if (!sweeping) refresh();
    }, 30000);
    return () => clearInterval(id);
  }, [refresh, sweeping]);

  const flipLang = useCallback((next: Lang) => {
    if (next === lang) return;
    storeLang(next);
    // Sweep rows were rendered server-side in the old language and cannot be
    // retranslated here; the toggle is disabled WHILE sweeping, so only a
    // finished sweep is ever dropped — and it is one button press away.
    setSweep(null);
    setLang(next);
  }, [lang]);

  const runSweep = useCallback(async (target?: string) => {
    const id = target ?? comp;
    if (!id) return;
    if (!report?.sweepableCompositions?.includes(id)) {
      setSweep({ compositionId: id, findings: [{ check: "verify-sweep", id, status: "warn", detail: t("sweep.needsStopped") }] });
      return;
    }
    if (target) setComp(target);
    if (!window.confirm(t("sweep.confirm", { id }))) return;
    setSweeping(true);
    setSweep(null);
    try {
      const res = await fetch(`/api/verify-sweep?lang=${uiLang}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ compositionId: id })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setSweep({ compositionId: id, findings: data.findings });
    } catch (err) {
      setSweep({ compositionId: id, findings: [{ check: "verify-sweep", id, status: "fail", detail: String(err) }] });
    } finally {
      setSweeping(false);
    }
  }, [comp, report?.sweepableCompositions, t, uiLang]);

  const grouped = useMemo(() => {
    const all = [...(report?.findings ?? []), ...(sweep?.findings ?? [])];
    const map = new Map<string, Finding[]>();
    for (const f of all) {
      if (!map.has(f.check)) map.set(f.check, []);
      map.get(f.check)!.push(f);
    }
    return [...map.entries()].sort(
      (a, b) => (CHECK_ORDER.indexOf(a[0]) + 99) % 99 - (CHECK_ORDER.indexOf(b[0]) + 99) % 99
    );
  }, [report, sweep]);

  const topbar = <TopBar t={t} lang={uiLang} onLang={flipLang} onRefresh={refresh} busy={sweeping} />;

  if (error) {
    return (
      <>
        {topbar}
        <main>
          <div className="banner banner-fail">
            <strong>{t("overall.fail")}</strong>
            <span>{t("error.load", { error })}</span>
            <button onClick={refresh}>{t("error.retry")}</button>
          </div>
        </main>
      </>
    );
  }
  if (!report) {
    return (
      <>
        {topbar}
        <main>
          <div className="banner banner-info">
            <span className="counts">{t("loading")}</span>
            <span className="loading-note">{t("loading.note")}</span>
          </div>
          <section className="check"><div className="finding"><div className="skeleton-row w60" /><div className="skeleton-row w40" /></div></section>
          <section className="check"><div className="finding"><div className="skeleton-row w60" /><div className="skeleton-row w40" /></div></section>
        </main>
      </>
    );
  }

  const { overall, counts } = report.summary;

  // The headline must answer "WHAT is broken", not just "how many rows are
  // red" — a failing fitting, a missing registry entry and a port collision
  // are different problems and a bare total conflates them.
  const allFindings = [...report.findings, ...(sweep?.findings ?? [])];
  const failingFittings = [...new Set(
    allFindings
      .filter((f) => (f.check === "verify-results" || f.check === "verify-sweep") && f.status === "fail")
      .map((f) => f.id.split(":").pop() as string)
  )];
  const failsByCheck = new Map<string, number>();
  for (const f of allFindings) {
    if (f.status === "fail" && f.check !== "verify-results" && f.check !== "verify-sweep") {
      failsByCheck.set(f.check, (failsByCheck.get(f.check) ?? 0) + 1);
    }
  }

  return (
    <>
      {topbar}
      <main>
        <div className={`banner banner-${overall}`}>
          <strong>{t(`overall.${overall}`)}</strong>
          <span className="counts">{t("counts", { pass: counts.pass, warn: counts.warn, fail: counts.fail })}</span>
          {!!counts.info && <span className="chip chip-info">{t("info.chip", { n: counts.info })}</span>}
          {report.activeComposition && <span className="chip">{t("active.chip", { id: report.activeComposition })}</span>}
          {report.degraded && <span className="chip">{t("degraded.chip")}</span>}
          <span className="ts">{t("generated.at", { time: fmtTime(uiLang, report.generatedAt) })}</span>
        </div>

        {!!report.resolved?.length && (
          <div className="headline">
            <span className="headline-fittings ok">{t("resolved.since")}</span>
            <span className="headline-other">{report.resolved.map((r) => r.key).join(" · ")}</span>
          </div>
        )}

        {(failingFittings.length > 0 || failsByCheck.size > 0) && (
          <div className="headline">
            {failingFittings.length > 0 ? (
              <span className="headline-fittings">
                {t("headline.failing", { n: failingFittings.length })}{" "}
                {failingFittings.map((id) => (
                  <button
                    key={id}
                    className={`fitting-chip${fittingFilter === id ? " active" : ""}`}
                    title={t("chip.title", { id })}
                    onClick={() => setFittingFilter(fittingFilter === id ? null : id)}
                  >
                    {id}
                  </button>
                ))}
              </span>
            ) : (
              <span className="headline-fittings ok">{t("headline.none")}</span>
            )}
            {failsByCheck.size > 0 && (
              <span className="headline-other">
                {t("headline.other")}{" "}
                {[...failsByCheck].map(([check, n]) => {
                  const label = t(`other.${check}`);
                  return `${n} ${label === `other.${check}` ? check : label}`;
                }).join(" · ")}
              </span>
            )}
          </div>
        )}

        {fittingFilter && (
          <div className="filter-view">
            <div className="filter-head">
              <strong>{t("filter.about")} <code>{fittingFilter}</code></strong>
              <button className="linkish" onClick={() => setFittingFilter(null)}>{t("filter.showAll")}</button>
            </div>
            {allFindings
              .filter((f) => f.id.includes(fittingFilter) || f.detail.includes(fittingFilter) || (f.fix ?? "").includes(fittingFilter))
              .map((f, i) => (
                <div key={`flt:${i}`}>
                  <div className="filter-check-label">{t(`check.${f.check}`) === `check.${f.check}` ? f.check : t(`check.${f.check}`)}</div>
                  <FindingRow f={f} t={t} lang={uiLang} onSweep={runSweep} fileCards={report.fileCards} />
                </div>
              ))}
          </div>
        )}

        <div className="sweep-bar">
          <label>
            {t("sweep.label")}
            <select value={comp} onChange={(e) => setComp(e.target.value)} disabled={sweeping}>
              {(report.compositions ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <button onClick={() => runSweep()} disabled={sweeping || !report.appUp || !report.sweepableCompositions?.includes(comp)}
            title={report.appUp ? t("sweep.title.stop") : t("sweep.title.appDown")}>
            {sweeping ? t("sweep.running") : t("sweep.run")}
          </button>
          <span className="sweep-note">{t("sweep.note")}</span>
        </div>

        {!fittingFilter && grouped.map(([check, findings]) => <Section key={check} check={check} findings={findings} t={t} lang={uiLang} onSweep={runSweep} fileCards={report.fileCards} />)}

        {((report.recentFixes?.length ?? 0) > 0 || report.libraryDiff) && (
          <FixJournal entries={report.recentFixes ?? []} libraryDiff={report.libraryDiff} libraryDiffHash={report.libraryDiffHash} t={t} lang={uiLang} onChanged={refresh} />
        )}
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
