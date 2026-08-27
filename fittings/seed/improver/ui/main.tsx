import React, { useEffect, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";

// Improver review-queue view (BRIEF U3). Card idiom borrowed from the Model
// Router view. Pending proposals show claim + diff + gate status with
// Approve/Reject; the Autonomy tab shows per-rule mode + track record + a
// promotion approve when a streak is suggested. All actions go through the
// own-port API (no direct writes).

type Proposal = {
  id: string;
  rule: string;
  targetClass: string;
  claim: string;
  diff?: string;
  decision?: string;
  status: "pending" | "applied" | "rejected" | "reapply-failed" | "retired";
  evidence?: { bytes: number; sha: string; targetFile: string } | { files: string[]; misses?: Record<string, number> };
  reapplyFailureReason?: string;
  // shadcn/improve pattern 1 — file:line evidence + a confidence grade.
  citations?: Array<{ file: string; line: number; snippet?: string }>;
  confidence?: "high" | "medium" | "low";
  rejectionReason?: string;
  // `false` = this finding is real but has no mechanical edit (the split variant
  // of an escalation proposal). Approve must not offer to do something else.
  appliable?: boolean;
};
type RuleState = { autonomy: "manual" | "auto"; streak: number; accepted: number; rejected: number; reverted: number };
type Queue = { queue: Proposal[]; autonomy: Record<string, RuleState>; promotionThreshold: number };

// One raw record off the shared feedback queue, as /api/signals renders it.
type Signal = {
  key: string;
  id: string | null;
  provenance: string;
  area: string | null;
  question: string | null;
  answer: string | null;
  at: string | null;
  sessionId: string | null;
  cardId: string | null;
  decisionId: string | null;
  deliveredVia: string | null;
  classification: { kind: string | null; tier: string | null; plan: string | null } | null;
  dimensions: { original?: Record<string, unknown>; applied?: Record<string, unknown> } | null;
  feedsRule: { category: string | null; group: string | null; minSignal: number };
  feedsTracks: Array<{ category: string; shape: string; signal: string }>;
  contributes: boolean;
  tombstoned: boolean;
  tombstonedAt: string | null;
  tombstoneReason: string | null;
  lineNumber: number;
};
type PendingProbe = {
  id: string | null;
  sessionId: string | null;
  mode: string;
  askedAt: string | null;
  target: string | null;
  deliveredVia: { relay?: boolean; channels?: string[]; reachable?: boolean; reason?: string } | null;
  questions: Array<{ question: string; options?: string[]; area?: string }>;
};
type Signals = {
  queueFile: string;
  signals: Signal[];
  counts: { total: number; live: number; deleted: number; tombstones: number; shown: number };
  pendingProbes: PendingProbe[];
  probeSkips: string[];
};

type EcosystemUpdateEntry = {
  at: string;
  skipped?: string;
  outdatedLog?: string;
  installResult?: { ok: boolean; code: number | null; depCountBefore: number | null; depCountAfter: number | null; stderr?: string };
};
type ReapplySweepEntry = { at: string; checked: number; restored: number; failed: Array<{ id: string; reason: string }> };
type EcosystemStatus = { ecosystemUpdate: EcosystemUpdateEntry | null; reapplySweep: ReapplySweepEntry | null };

async function getJSON(p: string) {
  const r = await fetch(p);
  return r.json();
}
async function postJSON(p: string, body?: any) {
  const r = await fetch(p, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}
async function putJSON(p: string, body: any) {
  const r = await fetch(p, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
async function deleteJSON(p: string, body?: any) {
  const r = await fetch(p, {
    method: "DELETE",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

function DiffView({ diff }: { diff?: string }) {
  if (!diff) return null;
  return (
    <pre className="diff" data-testid="diff">
      {diff.split("\n").map((line, i) => (
        <div key={i} className={line.startsWith("+") ? "add" : undefined}>
          {line}
        </div>
      ))}
    </pre>
  );
}

function ProposalCard({ p, onApply, onReject }: { p: Proposal; onApply: (id: string) => void; onReject: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const pending = p.status === "pending";
  // A reapply-failed entry isn't pending (it already went through Approve
  // once), but dismissing it is the same safe, generic transition as
  // rejecting a pending one - no reapply logic involved - so let a reviewer
  // clear it from the queue instead of leaving it permanently stuck with no
  // available action.
  const canReject = pending || p.status === "reapply-failed";
  // A manual-only proposal is evidence, not an action. Showing a live Approve
  // would either lie about what it does or apply the fallback markdown-append,
  // which is not what the claim describes.
  const manualOnly = p.appliable === false;
  return (
    <div className="card" data-testid={`proposal-${p.id}`}>
      <div className="row">
        <div className="claim">{p.claim}</div>
        <span className={`badge ${p.status}`} data-testid={`status-${p.id}`}>
          {p.status}
        </span>
      </div>
      <div className="meta">
        rule <strong>{p.rule}</strong> · target <strong>{p.targetClass}</strong>
        {p.confidence && (
          <>
            {" "}· confidence <strong data-testid={`confidence-${p.id}`}>{p.confidence}</strong>
          </>
        )}
        {" "}· {p.decision}
      </div>
      {p.citations && p.citations.length > 0 && (
        <div className="evidence" data-testid={`citations-${p.id}`}>
          evidence:{" "}
          {p.citations.map((c, i) => (
            <code key={i}>
              {c.file}:{c.line}
              {i < p.citations!.length - 1 ? ", " : ""}
            </code>
          ))}
        </div>
      )}
      <button onClick={() => setOpen((o) => !o)} data-testid={`toggle-diff-${p.id}`}>
        {open ? "Hide diff" : "Show diff"}
      </button>
      {open && <DiffView diff={p.diff} />}
      {p.evidence && "files" in p.evidence && (() => {
        // The batch shapes (e.g. coordination-predict-batch) name every
        // qualifying path here — the claim only previews the first 5, and a
        // reviewer approving/rejecting the whole batch must see all of them,
        // not just the preview.
        const { files, misses } = p.evidence;
        return (
          <div className="evidence" data-testid={`evidence-files-${p.id}`}>
            {files.length} path{files.length === 1 ? "" : "s"}:{" "}
            {files.map((f, i) => (
              <code key={f}>
                {f}
                {misses?.[f] !== undefined ? ` (${misses[f]})` : ""}
                {i < files.length - 1 ? ", " : ""}
              </code>
            ))}
          </div>
        );
      })()}
      {p.evidence && "targetFile" in p.evidence && (
        <div className="evidence" data-testid={`evidence-${p.id}`}>
          applied → {p.evidence.targetFile} · {p.evidence.bytes} bytes
          {/* The flow-apply path reports the shell's new baselineSha here; a
              future apply path may report none, and a missing sha must not blank
              the whole card. */}
          {p.evidence.sha ? ` · ${p.evidence.sha.slice(0, 19)}…` : ""}
        </div>
      )}
      {manualOnly && (
        <div className="evidence" data-testid={`manual-only-${p.id}`}>
          manual — this one has no mechanical edit; it names what to change and a human makes the call.
        </div>
      )}
      {p.status === "reapply-failed" && p.reapplyFailureReason && (
        <div className="evidence" data-testid={`reapply-failure-${p.id}`}>
          reapply sweep could not restore this after an ecosystem update: {p.reapplyFailureReason}
        </div>
      )}
      <div className="actions" style={{ marginTop: 12 }}>
        <button className="primary" disabled={!pending || manualOnly} onClick={() => onApply(p.id)} data-testid={`approve-${p.id}`}>
          Approve
        </button>
        <button className="danger" disabled={!canReject} onClick={() => onReject(p.id)} data-testid={`reject-${p.id}`}>
          Reject
        </button>
      </div>
    </div>
  );
}

// ── Signals ─────────────────────────────────────────────────────────────────
// The raw evidence the Improver reasons from. It exists because a proposal you
// cannot trace is a proposal you cannot correct: before this pane the only way
// to undo a wrong inference was to hand-edit a JSONL. Each row states what was
// said, what it currently feeds, and therefore what deleting it undoes.

function fmtWhen(iso: string | null): string {
  if (!iso) return "unknown time";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function dimensionPairs(dims: Signal["dimensions"]): string {
  if (!dims) return "";
  const side = (label: string, o?: Record<string, unknown>) => {
    if (!o) return null;
    const parts = Object.entries(o)
      .filter(([, v]) => typeof v === "string" || typeof v === "number")
      .map(([k, v]) => `${k}=${v}`);
    return parts.length ? `${label} ${parts.join(", ")}` : null;
  };
  return [side("was", dims.original), side("should have been", dims.applied)].filter(Boolean).join(" · ");
}

function SignalRow({ s, onDelete }: { s: Signal; onDelete: (s: Signal) => void }) {
  const feeds: string[] = [];
  if (s.feedsRule.category) {
    feeds.push(`feedback rule → ${s.feedsRule.category} (group "${s.feedsRule.group}", ${s.feedsRule.minSignal} needed to propose)`);
  }
  for (const t of s.feedsTracks) feeds.push(`${t.category} track "${t.shape}" → ${t.signal}`);
  return (
    <div className="card" data-testid={`signal-${s.key}`} style={s.tombstoned ? { opacity: 0.55 } : undefined}>
      <div className="row">
        <div className="claim">{s.answer ?? "(no answer)"}</div>
        <span className={`badge ${s.tombstoned ? "rejected" : s.contributes ? "applied" : "skipped"}`} data-testid={`signal-status-${s.key}`}>
          {s.tombstoned ? "deleted" : s.contributes ? "counted" : "inert"}
        </span>
      </div>
      <div className="meta">
        {s.provenance} · {fmtWhen(s.at)}
        {s.area ? ` · ${s.area}` : ""}
        {s.deliveredVia ? ` · via ${s.deliveredVia}` : ""}
      </div>
      {s.question && <div className="evidence">asked: {s.question}</div>}
      {dimensionPairs(s.dimensions) && <div className="evidence">{dimensionPairs(s.dimensions)}</div>}
      {s.classification?.kind && (
        <div className="evidence">
          classified as {s.classification.kind}
          {s.classification.tier ? ` (${s.classification.tier})` : ""}
        </div>
      )}
      <div className="evidence" data-testid={`signal-feeds-${s.key}`}>
        {feeds.length ? `feeds: ${feeds.join(" · ")}` : "feeds nothing — an approving or unrecognised answer proposes no change"}
      </div>
      {s.tombstoned ? (
        <div className="evidence">
          deleted {fmtWhen(s.tombstonedAt)}
          {s.tombstoneReason ? ` — ${s.tombstoneReason}` : ""}
        </div>
      ) : (
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="danger" onClick={() => onDelete(s)} data-testid={`delete-${s.key}`}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

function SignalsPane({ data, refresh }: { data: Signals | null; refresh: () => void }) {
  const onDelete = useCallback(
    async (s: Signal) => {
      const what = s.contributes ? "This record currently feeds the Improver." : "This record feeds nothing today.";
      const reason =
        typeof window !== "undefined"
          ? window.prompt(`${what}\n\nDeleting it appends a tombstone — the line stays on disk, but nothing counts it again.\n\nWhy delete it?`)
          : null;
      if (reason === null) return; // cancelled
      await deleteJSON(`/api/signals/${encodeURIComponent(s.key)}`, { reason });
      refresh();
    },
    [refresh]
  );
  if (!data) return <div className="empty">loading…</div>;
  return (
    <div data-testid="signals-pane">
      {data.pendingProbes.length > 0 && (
        <>
          <div className="sub" style={{ margin: "0 0 8px" }}>Questions still waiting for an answer</div>
          {data.pendingProbes.map((p) => {
            const channels = p.deliveredVia?.channels ?? [];
            return (
              <div className="card" key={p.id ?? p.sessionId} data-testid={`pending-${p.id}`}>
                <div className="row">
                  <div className="claim">{p.questions[0]?.question ?? "(no question)"}</div>
                  <span className={`badge ${channels.length ? "pending" : "reapply-failed"}`}>
                    {channels.length ? `sent to ${channels.length}` : "terminal only"}
                  </span>
                </div>
                <div className="meta">
                  {p.mode} · asked {fmtWhen(p.askedAt)} · session {p.sessionId ?? "?"}
                </div>
                {p.questions[0]?.options && <div className="evidence">options: {p.questions[0].options.join(" · ")}</div>}
                <div className="evidence">
                  {channels.length
                    ? `delivered to ${channels.join(", ")}`
                    : "delivered only through the Stop-hook relay — nobody sees this unless that terminal is open"}
                  {p.deliveredVia && p.deliveredVia.reachable === false && p.deliveredVia.reason ? ` · ${p.deliveredVia.reason}` : ""}
                </div>
              </div>
            );
          })}
        </>
      )}

      <div className="sub" style={{ margin: "16px 0 8px" }}>
        Raw signals — {data.counts.live} live, {data.counts.deleted} deleted, showing {data.counts.shown} newest
      </div>
      {data.signals.length === 0 && (
        <div className="empty">Nothing on the feedback queue yet. Verdicts, overrides and probe answers land here.</div>
      )}
      {data.signals.map((s) => (
        <SignalRow key={s.key} s={s} onDelete={onDelete} />
      ))}

      {data.probeSkips.length > 0 && (
        <>
          <div className="sub" style={{ margin: "16px 0 8px" }}>Probe skips — times the Probe declined to ask</div>
          <pre className="diff" data-testid="probe-skips">
            {data.probeSkips.join("\n")}
          </pre>
        </>
      )}
    </div>
  );
}

function QueuePane({ data, refresh }: { data: Queue; refresh: () => void }) {
  const onApply = useCallback(
    async (id: string) => {
      await postJSON(`/api/proposals/${encodeURIComponent(id)}/apply`);
      refresh();
    },
    [refresh]
  );
  const onReject = useCallback(
    async (id: string) => {
      // shadcn/improve pattern 3 — capture WHY, so the finding is recorded in
      // the rejection ledger and does not reappear next run.
      const reason = typeof window !== "undefined" ? window.prompt("Reason for rejecting (recorded so it won't come back):") : null;
      if (reason === null) return; // cancelled — do not reject
      await postJSON(`/api/proposals/${encodeURIComponent(id)}/reject`, { reason });
      refresh();
    },
    [refresh]
  );
  const pending = data.queue.filter((p) => p.status === "pending");
  const resolved = data.queue.filter((p) => p.status !== "pending");
  return (
    <div data-testid="queue-pane">
      {data.queue.length === 0 && <div className="empty">No proposals yet. Run the Improver to populate the queue.</div>}
      {pending.map((p) => (
        <ProposalCard key={p.id} p={p} onApply={onApply} onReject={onReject} />
      ))}
      {resolved.length > 0 && <div className="sub" style={{ margin: "16px 0 8px" }}>Resolved</div>}
      {resolved.map((p) => (
        <ProposalCard key={p.id} p={p} onApply={onApply} onReject={onReject} />
      ))}
    </div>
  );
}

function AutonomyPane({ data, refresh }: { data: Queue; refresh: () => void }) {
  const rules = Object.keys(data.autonomy);
  const setMode = async (rule: string, mode: "manual" | "auto") => {
    await putJSON("/api/autonomy", { rule, mode });
    refresh();
  };
  const promote = async (rule: string) => {
    await postJSON("/api/autonomy/promote", { rule });
    refresh();
  };
  return (
    <div data-testid="autonomy-pane">
      {rules.length === 0 && <div className="empty">No rules have a track record yet.</div>}
      {rules.map((rule) => {
        const s = data.autonomy[rule];
        const suggested = s.autonomy === "manual" && s.streak >= data.promotionThreshold;
        return (
          <div className="autonomy-row" key={rule} data-testid={`autonomy-${rule}`}>
            <div>
              <div className="claim">
                {rule} <span className={`badge ${s.autonomy === "auto" ? "auto" : "pending"}`}>{s.autonomy}</span>
              </div>
              <div className="track">
                accepted {s.accepted} · rejected {s.rejected} · streak {s.streak}/{data.promotionThreshold}
              </div>
            </div>
            <div className="actions">
              {suggested && (
                <button className="primary" onClick={() => promote(rule)} data-testid={`promote-${rule}`}>
                  Approve promotion
                </button>
              )}
              <button
                onClick={() => setMode(rule, s.autonomy === "auto" ? "manual" : "auto")}
                data-testid={`toggle-${rule}`}
              >
                Set {s.autonomy === "auto" ? "manual" : "auto"}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EcosystemPane({ status }: { status: EcosystemStatus | null }) {
  if (!status) return <div className="empty">loading…</div>;
  const { ecosystemUpdate: eco, reapplySweep: sweep } = status;
  // Defensive: the log is a plain JSON file, not schema-validated - a future
  // bug or manual edit producing a structurally incomplete entry must degrade
  // gracefully here, not crash the whole panel.
  const failedList = Array.isArray(sweep?.failed) ? sweep.failed : [];
  return (
    <div data-testid="ecosystem-pane">
      <div className="card" data-testid="ecosystem-update-card">
        <div className="row">
          <div className="claim">Ecosystem update</div>
          {eco && (
            <span className={`badge ${eco.skipped ? "skipped" : eco.installResult?.ok ? "applied" : "rejected"}`}>
              {eco.skipped ? "skipped" : eco.installResult?.ok ? "ok" : "failed"}
            </span>
          )}
        </div>
        {!eco && <div className="meta">No run recorded yet - runs automatically on the nightly cron, or click "Run Improver now".</div>}
        {eco && (
          <div className="meta">
            last run {eco.at}
            {eco.skipped ? (
              <> · skipped: {eco.skipped}</>
            ) : (
              <>
                {" "}
                · apm install {eco.installResult?.ok ? "ok" : `failed (code ${eco.installResult?.code ?? "?"})`} · deps{" "}
                {eco.installResult?.depCountBefore ?? "?"} → {eco.installResult?.depCountAfter ?? "?"}
              </>
            )}
          </div>
        )}
      </div>
      <div className="card" data-testid="reapply-sweep-card">
        <div className="row">
          <div className="claim">Reapply sweep</div>
          {sweep && (
            <span className={`badge ${failedList.length > 0 ? "reapply-failed" : "applied"}`}>
              {failedList.length > 0 ? `${failedList.length} failed` : "clean"}
            </span>
          )}
        </div>
        {!sweep && <div className="meta">No run recorded yet.</div>}
        {sweep && (
          <div className="meta">
            last run {sweep.at} · checked {sweep.checked ?? "?"} · restored {sweep.restored ?? "?"} · failed {failedList.length}
          </div>
        )}
      </div>
    </div>
  );
}

function App() {
  const [data, setData] = useState<Queue | null>(null);
  const [ecosystem, setEcosystem] = useState<EcosystemStatus | null>(null);
  const [signals, setSignals] = useState<Signals | null>(null);
  const [tab, setTab] = useState("queue");
  const refresh = useCallback(async () => {
    setData(await getJSON("/api/queue"));
    setEcosystem(await getJSON("/api/ecosystem-status"));
    setSignals(await getJSON("/api/signals"));
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const runNow = async () => {
    await postJSON("/api/run-now");
    refresh();
  };
  if (!data) return <div style={{ padding: 24 }}>loading…</div>;
  const pendingCount = data.queue.filter((p) => p.status === "pending").length;
  return (
    <div className="app">
      <header>
        <div>
          <h1>Improver — Review Queue</h1>
          <div className="sub">{pendingCount} pending · {data.queue.length} total</div>
        </div>
        <button className="primary" onClick={runNow} data-testid="btn-run-now">
          Run Improver now
        </button>
      </header>
      <div className="tabs">
        {["queue", "signals", "autonomy", "ecosystem"].map((t) => (
          <div key={t} className={`tab ${tab === t ? "active" : ""}`} data-testid={`tab-${t}`} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </div>
        ))}
      </div>
      <main>
        {tab === "queue" && <QueuePane data={data} refresh={refresh} />}
        {tab === "signals" && <SignalsPane data={signals} refresh={refresh} />}
        {tab === "autonomy" && <AutonomyPane data={data} refresh={refresh} />}
        {tab === "ecosystem" && <EcosystemPane status={ecosystem} />}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
