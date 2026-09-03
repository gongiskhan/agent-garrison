// Preflight UI — one page: overall banner, seven collapsible check sections,
// each finding with its fix beside it, and the explicit (heavy) verify sweep.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

type Finding = {
  check: string;
  id: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  evidence?: string;
  fix?: string;
  action?: { id: string; params: Record<string, unknown>; command: string };
};

type FixEntry = { at: string; actionId: string; params: Record<string, unknown>; ok: boolean; detail?: string; error?: string; resolved?: boolean | null };

type Report = {
  findings: Finding[];
  summary: { overall: string; counts: { pass: number; warn: number; fail: number } };
  degraded: boolean;
  appUp: boolean;
  compositions?: string[];
  recentFixes?: FixEntry[];
  libraryDiff?: string | null;
  generatedAt: string;
};

const CHECK_TITLES: Record<string, string> = {
  "app-reachable": "Garrison app",
  "repo-root": "Repo root",
  "verify-results": "1 · Verify results (last up)",
  "verify-sweep": "1b · Live verify sweep",
  "library-crosscheck": "2 · Library registration",
  "port-collisions": "3 · Ports (both axes)",
  "serve-coverage": "4 · Tailscale serve coverage",
  "orphans": "5 · Orphan processes",
  "drift": "6 · Composition drift",
  "kind-vocabulary": "7 · Capability kinds"
};

const CHECK_ORDER = Object.keys(CHECK_TITLES);

function StatusPip({ status }: { status: string }) {
  return <span className={`pip pip-${status}`} title={status} />;
}

// Executes a finding's whitelisted fix action after an explicit confirm that
// shows exactly what will run. The refresh happens on the next poll (or the
// refresh button) so the row's outcome is visible immediately in place.
function FixButton({ f }: { f: Finding }) {
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const run = async () => {
    if (!f.action) return;
    if (!window.confirm(`Fix "${f.id}"?\n\nThis will run:\n${f.action.command}`)) return;
    setState("running");
    try {
      const res = await fetch("/api/fix", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId: f.action.id, params: f.action.params })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setState("done");
      setMessage(data.detail || "done");
    } catch (err) {
      setState("error");
      setMessage(String((err as Error).message || err));
    }
  };
  if (state === "done") return <div className="fix-result fix-ok">✓ {message} — refresh to re-check</div>;
  if (state === "error") return <div className="fix-result fix-err">✗ {message}</div>;
  return (
    <button className="fix-btn" onClick={run} disabled={state === "running"} title={f.action?.command}>
      {state === "running" ? "fixing…" : "Fix it"}
    </button>
  );
}

function FindingRow({ f }: { f: Finding }) {
  const [open, setOpen] = useState(false);
  // Ids in verify/drift checks are "composition:fitting" — render the
  // composition as a muted prefix badge so the FITTING reads as the subject
  // (a joined "default-2:basic-memory" looks like one odd name).
  const parts = f.id.includes(":") ? f.id.split(":") : null;
  return (
    <div className={`finding finding-${f.status}`}>
      <div className="finding-head">
        <StatusPip status={f.status} />
        {parts ? (
          <span className="finding-id">
            <span className="comp-badge">{parts[0]}</span>
            {parts.slice(1).join(":")}
          </span>
        ) : (
          <span className="finding-id">{f.id}</span>
        )}
        <span className="finding-detail">{f.detail}</span>
      </div>
      {f.fix && <div className="finding-fix">fix: {f.fix}</div>}
      {f.action && <FixButton f={f} />}
      {f.evidence && (
        <div>
          <button className="linkish" onClick={() => setOpen(!open)}>
            {open ? "hide evidence" : "show evidence"}
          </button>
          {open && <pre className="evidence">{f.evidence}</pre>}
        </div>
      )}
    </div>
  );
}

function Section({ check, findings }: { check: string; findings: Finding[] }) {
  const worst = findings.reduce<string>(
    (acc, f) => (f.status === "fail" || acc === "fail" ? "fail" : f.status === "warn" || acc === "warn" ? "warn" : "pass"),
    "pass"
  );
  const [open, setOpen] = useState(worst !== "pass");
  useEffect(() => setOpen(worst !== "pass"), [worst]);
  return (
    <section className="check">
      <header className="check-head" onClick={() => setOpen(!open)}>
        <StatusPip status={worst} />
        <h2>{CHECK_TITLES[check] || check}</h2>
        <span className="count">{findings.length}</span>
        <span className="chev">{open ? "▾" : "▸"}</span>
      </header>
      {open && findings.map((f, i) => <FindingRow key={`${f.id}:${i}`} f={f} />)}
    </section>
  );
}

// The persistent trace of what the doctor DID. A fixed row disappears from
// the checks on refresh — that means the detector re-measured and passes —
// but the action itself stays visible and auditable here.
function ResolvedBadge({ resolved }: { resolved?: boolean | null }) {
  if (resolved === true) return <span className="res-badge res-ok">resolved ✓ re-checked</span>;
  if (resolved === false) return <span className="res-badge res-bad">NOT resolved — re-check failed</span>;
  return null;
}

function FixJournal({ entries, libraryDiff, onChanged }: { entries: FixEntry[]; libraryDiff?: string | null; onChanged: () => void }) {
  const [open, setOpen] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [commitMsg, setCommitMsg] = useState<string | null>(null);

  const commitLibrary = async () => {
    if (!window.confirm("Commit the pending data/library.json changes?\n\nRuns: git add data/library.json && git commit (scoped to that file; never pushes)")) return;
    setCommitting(true);
    setCommitMsg(null);
    try {
      const res = await fetch("/api/fix", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId: "git-commit-library", params: {} })
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
      <header className="check-head" onClick={() => setOpen(!open)}>
        <span className="pip pip-pass" />
        <h2>Recent fixes (what the doctor did)</h2>
        <span className="count">{entries.length}</span>
        <span className="chev">{open ? "▾" : "▸"}</span>
      </header>
      {open && (
        <>
          {libraryDiff && (
            <div className="finding pending-commit">
              <div className="finding-head">
                <span className="pip pip-warn" />
                <span className="finding-id">uncommitted</span>
                <span className="finding-detail">library.json changes waiting for review: <code>{libraryDiff}</code></span>
              </div>
              <button className="fix-btn" onClick={commitLibrary} disabled={committing}>
                {committing ? "committing…" : "Commit library.json"}
              </button>
              {commitMsg && <div className="finding-fix">{commitMsg}</div>}
            </div>
          )}
          {entries.map((e, i) => (
            <div key={i} className="finding">
              <div className="finding-head">
                <span className={`pip pip-${e.ok ? "pass" : "fail"}`} />
                <span className="finding-id">{e.actionId}</span>
                <span className="finding-detail">{e.ok ? e.detail : `FAILED: ${e.error}`}</span>
                <ResolvedBadge resolved={e.resolved} />
              </div>
              <div className="finding-fix">
                {new Date(e.at).toLocaleString()} · params: {JSON.stringify(e.params)}
              </div>
            </div>
          ))}
        </>
      )}
    </section>
  );
}

function App() {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [sweep, setSweep] = useState<{ compositionId: string; findings: Finding[] } | null>(null);
  const [comp, setComp] = useState<string>("");
  const [fittingFilter, setFittingFilter] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/report");
      const data = (await res.json()) as Report;
      setReport(data);
      setError(null);
      if (!comp && data.compositions?.length) setComp(data.compositions[0]);
    } catch (err) {
      setError(String(err));
    }
  }, [comp]);

  useEffect(() => {
    refresh();
    const id = setInterval(() => {
      if (!sweeping) refresh();
    }, 30000);
    return () => clearInterval(id);
  }, [refresh, sweeping]);

  const runSweep = useCallback(async () => {
    if (!comp) return;
    if (!window.confirm(
      `Run the FULL verify sweep for "${comp}"?\n\nThis is heavy: it flips the runner status, may run apm install, and runs every setup + verify hook. It is the same code path up() uses.`
    )) return;
    setSweeping(true);
    setSweep(null);
    try {
      const res = await fetch("/api/verify-sweep", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ compositionId: comp })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setSweep({ compositionId: comp, findings: data.findings });
    } catch (err) {
      setSweep({ compositionId: comp, findings: [{ check: "verify-sweep", id: comp, status: "fail", detail: String(err) }] });
    } finally {
      setSweeping(false);
    }
  }, [comp]);

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

  if (error) return <div className="banner banner-fail">preflight backend unreachable: {error}</div>;
  if (!report) return <div className="banner">loading…</div>;

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
  const OTHER_LABELS: Record<string, string> = {
    "library-crosscheck": "registry",
    "port-collisions": "port",
    "serve-coverage": "serve",
    "orphans": "orphan",
    "drift": "drift",
    "kind-vocabulary": "kind",
    "repo-root": "setup"
  };

  return (
    <main>
      <div className={`banner banner-${overall}`}>
        <strong>{overall.toUpperCase()}</strong>
        <span>{counts.pass} pass · {counts.warn} warn · {counts.fail} fail</span>
        {report.degraded && <span className="chip">degraded — app down</span>}
        <span className="ts">{new Date(report.generatedAt).toLocaleTimeString()}</span>
        <button onClick={refresh} disabled={sweeping}>refresh</button>
      </div>

      {(failingFittings.length > 0 || failsByCheck.size > 0) && (
        <div className="headline">
          {failingFittings.length > 0 ? (
            <span className="headline-fittings">
              {failingFittings.length} fitting{failingFittings.length > 1 ? "s" : ""} failing verify:{" "}
              {failingFittings.map((id) => (
                <button
                  key={id}
                  className={`fitting-chip${fittingFilter === id ? " active" : ""}`}
                  title={`show every finding that mentions ${id}`}
                  onClick={() => setFittingFilter(fittingFilter === id ? null : id)}
                >
                  {id}
                </button>
              ))}
            </span>
          ) : (
            <span className="headline-fittings ok">no fitting is failing verify</span>
          )}
          {failsByCheck.size > 0 && (
            <span className="headline-other">
              other issues:{" "}
              {[...failsByCheck].map(([check, n]) => `${n} ${OTHER_LABELS[check] ?? check}`).join(" · ")}
            </span>
          )}
        </div>
      )}

      {fittingFilter && (
        <div className="filter-view">
          <div className="filter-head">
            <strong>everything about <code>{fittingFilter}</code></strong>
            <button className="linkish" onClick={() => setFittingFilter(null)}>show all checks</button>
          </div>
          {allFindings
            .filter((f) => f.id.includes(fittingFilter) || f.detail.includes(fittingFilter) || (f.fix ?? "").includes(fittingFilter))
            .map((f, i) => (
              <div key={`flt:${i}`}>
                <div className="filter-check-label">{CHECK_TITLES[f.check] || f.check}</div>
                <FindingRow f={f} />
              </div>
            ))}
        </div>
      )}

      <div className="sweep-bar">
        <label>
          Verify sweep:
          <select value={comp} onChange={(e) => setComp(e.target.value)} disabled={sweeping}>
            {(report.compositions ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <button onClick={runSweep} disabled={sweeping || !report.appUp || !comp}
          title={report.appUp ? "Runs every verify hook via the app — heavy" : "Needs the Garrison app up"}>
          {sweeping ? "sweeping… (can take minutes)" : "Run full verify sweep"}
        </button>
        <span className="sweep-note">runs EVERY fitting's verify and reports all failures — up() stops at the first</span>
      </div>

      {!fittingFilter && grouped.map(([check, findings]) => <Section key={check} check={check} findings={findings} />)}

      {((report.recentFixes?.length ?? 0) > 0 || report.libraryDiff) && (
        <FixJournal entries={report.recentFixes ?? []} libraryDiff={report.libraryDiff} onChanged={refresh} />
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
