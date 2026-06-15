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
  status: "pending" | "applied" | "rejected";
  evidence?: { bytes: number; sha: string; targetFile: string };
};
type RuleState = { autonomy: "manual" | "auto"; streak: number; accepted: number; rejected: number; reverted: number };
type Queue = { queue: Proposal[]; autonomy: Record<string, RuleState>; promotionThreshold: number };

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
  return (
    <div className="card" data-testid={`proposal-${p.id}`}>
      <div className="row">
        <div className="claim">{p.claim}</div>
        <span className={`badge ${p.status}`} data-testid={`status-${p.id}`}>
          {p.status}
        </span>
      </div>
      <div className="meta">
        rule <strong>{p.rule}</strong> · target <strong>{p.targetClass}</strong> · {p.decision}
      </div>
      <button onClick={() => setOpen((o) => !o)} data-testid={`toggle-diff-${p.id}`}>
        {open ? "Hide diff" : "Show diff"}
      </button>
      {open && <DiffView diff={p.diff} />}
      {p.evidence && (
        <div className="evidence" data-testid={`evidence-${p.id}`}>
          applied → {p.evidence.targetFile} · {p.evidence.bytes} bytes · {p.evidence.sha.slice(0, 19)}…
        </div>
      )}
      <div className="actions" style={{ marginTop: 12 }}>
        <button className="primary" disabled={!pending} onClick={() => onApply(p.id)} data-testid={`approve-${p.id}`}>
          Approve
        </button>
        <button className="danger" disabled={!pending} onClick={() => onReject(p.id)} data-testid={`reject-${p.id}`}>
          Reject
        </button>
      </div>
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
      await postJSON(`/api/proposals/${encodeURIComponent(id)}/reject`);
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

function App() {
  const [data, setData] = useState<Queue | null>(null);
  const [tab, setTab] = useState("queue");
  const refresh = useCallback(async () => setData(await getJSON("/api/queue")), []);
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
        {["queue", "autonomy"].map((t) => (
          <div key={t} className={`tab ${tab === t ? "active" : ""}`} data-testid={`tab-${t}`} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </div>
        ))}
      </div>
      <main>
        {tab === "queue" && <QueuePane data={data} refresh={refresh} />}
        {tab === "autonomy" && <AutonomyPane data={data} refresh={refresh} />}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
