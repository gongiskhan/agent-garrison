import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
// Pure core, bundled into the browser (no node imports).
import {
  compileRouting,
  resolveRoute,
  ROLES,
  TASK_TYPES,
  TIERS
} from "../lib/routing-core.mjs";

type AnyCfg = any;

const DISC_OPTIONS: Record<string, string[]> = {
  review: ["none", "self-review", "review-by:default"],
  testing: ["none", "tests", "full-gates"],
  evidence: ["none", "text", "table", "gate-status", "video"],
  distribution: ["none", "link"]
};

const PINS = [
  { id: "pin-code-deep", prompt: "redesign the auth subsystem", taskType: "code", tier: "T2-deep", expect: "expert" },
  { id: "pin-code-trivial", prompt: "rename foo to bar", taskType: "code", tier: "T0-trivial", expect: "fast" },
  { id: "pin-image", prompt: "generate a logo", taskType: "code", tier: "T1-standard", matchedException: "ex-image", expect: "image" },
  { id: "pin-wrong", prompt: "deliberately wrong expectation", taskType: "research", tier: "T1-standard", expect: "expert" } // resolves to 'standard' → RED
];

function useRouting() {
  const [config, setConfig] = useState<AnyCfg | null>(null);
  const [baselineSha, setBaselineSha] = useState<string>("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "pending" | "conflict">("idle");
  const timer = useRef<any>(null);

  const load = async () => {
    const r = await fetch("/routing");
    const j = await r.json();
    setConfig(j.config);
    setBaselineSha(j.baselineSha);
    setSaveState("idle");
  };
  useEffect(() => {
    load();
  }, []);

  const save = async (next: AnyCfg) => {
    setSaveState("saving");
    const r = await fetch(`/routing?baseline=${encodeURIComponent(baselineSha)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: next })
    });
    if (r.status === 409) {
      setSaveState("conflict");
      await load();
      return;
    }
    const j = await r.json();
    setBaselineSha(j.baselineSha);
    // pending-restart: the runner reads routing.json only at spawn, so a saved
    // change is "pending" until the operative restarts.
    setSaveState("pending");
  };

  // debounce + flush
  const update = (next: AnyCfg) => {
    setConfig(next);
    setSaveState("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save(next), 600);
  };

  return { config, setConfig, update, baselineSha, saveState, reload: load };
}

function Header({ config, update, saveState }: any) {
  const active = config.activeProfile;
  const profileNames = Object.keys(config.profiles || {});
  const usesOllama = Object.values(config.profiles[active]?.roleMap || {}).some((tid: any) => {
    const t = (config.targets || []).find((x: any) => x.id === tid);
    return t?.provider === "ollama-local";
  });
  return (
    <header>
      <h1>Model Router</h1>
      <div className="profile-switch">
        <label htmlFor="profile">Profile</label>
        <select
          id="profile"
          data-testid="profile-select"
          value={active}
          onChange={(e) => update({ ...config, activeProfile: e.target.value })}
        >
          {profileNames.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
      {usesOllama && <span className="badge ollama" data-testid="ollama-badge">ollama-local</span>}
      <div className="spacer" />
      {saveState === "saving" && <span className="badge">saving…</span>}
      {saveState === "saved" && <span className="badge saved">saved</span>}
      {saveState === "pending" && (
        <span className="badge pending" data-testid="pending-restart">
          pending restart
        </span>
      )}
      {saveState === "conflict" && <span className="badge pending">reloaded (conflict)</span>}
    </header>
  );
}

function PolicyPane({ config, update }: any) {
  const active = config.activeProfile;
  const profile = config.profiles[active];
  const targets = config.targets || [];

  const setRoleMap = (role: string, targetId: string) => {
    const next = structuredClone(config);
    next.profiles[active].roleMap[role] = targetId;
    update(next);
  };
  const setCell = (tt: string, tier: string, role: string) => {
    const next = structuredClone(config);
    next.matrix.rows[tt] = next.matrix.rows[tt] || { cells: {} };
    next.matrix.rows[tt].cells = next.matrix.rows[tt].cells || {};
    if (role === "·") delete next.matrix.rows[tt].cells[tier];
    else next.matrix.rows[tt].cells[tier] = role;
    update(next);
  };
  const setDisc = (tier: string, field: string, value: string) => {
    const next = structuredClone(config);
    next.discipline[tier] = next.discipline[tier] || {};
    next.discipline[tier][field] = value;
    update(next);
  };

  return (
    <div className="pane">
      <div className="section">
        <h2>Role → target ({active})</h2>
        <table data-testid="rolemap">
          <tbody>
            {ROLES.map((role: string) => (
              <tr key={role}>
                <th style={{ width: 110 }}>{role}</th>
                <td>
                  <select
                    data-testid={`rolemap-${role}`}
                    value={profile.roleMap[role] || ""}
                    onChange={(e) => setRoleMap(role, e.target.value)}
                  >
                    {targets.map((t: any) => (
                      <option key={t.id} value={t.id}>
                        {t.id}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section">
        <h2>Matrix (task-type × tier → role)</h2>
        <table data-testid="matrix">
          <thead>
            <tr>
              <th>task-type</th>
              {TIERS.map((t: string) => (
                <th key={t}>{t}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TASK_TYPES.map((tt: string) => (
              <tr key={tt}>
                <th>{tt}</th>
                {TIERS.map((tier: string) => {
                  const cell = config.matrix?.rows?.[tt]?.cells?.[tier] ?? "·";
                  return (
                    <td key={tier}>
                      <select
                        data-testid={`cell-${tt}-${tier}`}
                        value={cell}
                        onChange={(e) => setCell(tt, tier, e.target.value)}
                      >
                        <option value="·">· (inherit)</option>
                        {ROLES.map((r: string) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section">
        <h2>Discipline (post-task duties by tier)</h2>
        {TIERS.map((tier: string) => {
          const d = config.discipline?.[tier] || {};
          return (
            <div className="card" key={tier}>
              <div className="disc-grid">
                <strong>{tier}</strong>
                {["review", "testing", "evidence", "distribution"].map((f) => (
                  <div key={f}>
                    <div className="h">{f}</div>
                    <select
                      data-testid={`disc-${tier}-${f}`}
                      value={d[f] || "none"}
                      onChange={(e) => setDisc(tier, f, e.target.value)}
                    >
                      {DISC_OPTIONS[f].map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="section">
        <h2>Exceptions (ordered — first match wins)</h2>
        {(config.exceptions || []).map((ex: any, i: number) => (
          <div className="card" key={ex.id}>
            <div className="row">
              <strong>{i + 1}.</strong>
              <code>{ex.id}</code>
              <span className="muted">WHEN {ex.when} →</span>
              <select
                data-testid={`exc-${ex.id}`}
                value={ex.role}
                onChange={(e) => {
                  const next = structuredClone(config);
                  next.exceptions[i].role = e.target.value;
                  update(next);
                }}
              >
                {ROLES.map((r: string) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ))}
      </div>

      <div className="section">
        <h2>Continuations (post-task, by output kind)</h2>
        {(config.continuations || []).map((c: any, i: number) => (
          <div className="card" key={c.id}>
            <div className="row">
              <span className="muted">WHEN produced a</span>
              <strong>{c.when}</strong>
              <span className="muted">→</span>
              <input
                type="text"
                data-testid={`cont-${c.id}`}
                value={(c.then || []).map((s: any) => `${s.verb}${s.arg ? `(${s.arg})` : ""}`).join(" → ")}
                onChange={(e) => {
                  const next = structuredClone(config);
                  next.continuations[i].then = e.target.value.split("→").map((seg: string) => {
                    const m = seg.trim().match(/^(\w+)(?:\((.*)\))?$/);
                    return m ? { verb: m[1], ...(m[2] ? { arg: m[2] } : {}) } : { verb: "other" };
                  });
                  update(next);
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SimulatorPane({ config }: any) {
  const [prompt, setPrompt] = useState("fix the failing login test");
  const [taskType, setTaskType] = useState("code");
  const [tier, setTier] = useState("T2-deep");
  const [profile, setProfile] = useState(config.activeProfile);
  const [trace, setTrace] = useState<any>(null);
  const [pinResults, setPinResults] = useState<Record<string, boolean>>({});

  const simulate = () => {
    const classification = { taskType, tier, matchedException: null } as any;
    const route = resolveRoute(config, profile, classification);
    setTrace({ classification, route });
  };

  const runPins = () => {
    const res: Record<string, boolean> = {};
    for (const pin of PINS) {
      const route = resolveRoute(config, profile, { taskType: pin.taskType, tier: pin.tier, matchedException: (pin as any).matchedException ?? null } as any);
      res[pin.id] = route.role === pin.expect;
    }
    setPinResults(res);
  };

  return (
    <div className="pane">
      <div className="section">
        <h2>Simulator (resolves the real routing path)</h2>
        <div className="sim-row">
          <input type="text" data-testid="sim-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="prompt" />
          <select data-testid="sim-tasktype" value={taskType} onChange={(e) => setTaskType(e.target.value)}>
            {TASK_TYPES.map((t: string) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <select data-testid="sim-tier" value={tier} onChange={(e) => setTier(e.target.value)}>
            {TIERS.map((t: string) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <select data-testid="sim-profile" value={profile} onChange={(e) => setProfile(e.target.value)}>
            {Object.keys(config.profiles).map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
          <button className="primary" data-testid="sim-run" onClick={simulate}>
            Simulate
          </button>
        </div>
        {trace && (
          <div className="trace" data-testid="sim-trace">
            taskType={trace.classification.taskType} tier={trace.classification.tier}
            <br />
            role={trace.route.role} via={trace.route.via} rule={trace.route.ruleId}
            <br />
            <span className="route-token">[route: {trace.route.targetId} | rule: {trace.route.ruleId} | profile: {trace.route.profile}]</span>
          </div>
        )}
      </div>

      <div className="section">
        <h2>Pinned regression prompts</h2>
        <button data-testid="run-pins" onClick={runPins}>
          Re-run pinned
        </button>
        <div style={{ marginTop: 10 }}>
          {PINS.map((pin) => {
            const r = pinResults[pin.id];
            const cls = r === undefined ? "gray" : r ? "green" : "red";
            return (
              <div className="pin" key={pin.id} data-testid={`pin-${pin.id}`}>
                <span className={`dot ${cls}`} />
                <code>{pin.id}</code>
                <span className="muted">expect role={pin.expect}</span>
                <span className="muted">— "{pin.prompt}"</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CompiledPane({ config }: any) {
  const [profile, setProfile] = useState(config.activeProfile);
  const compiled = useMemo(() => {
    try {
      return compileRouting(config, profile);
    } catch (e) {
      return `compile error: ${String(e)}`;
    }
  }, [config, profile]);
  return (
    <div className="pane">
      <div className="section">
        <div className="sim-row">
          <h2 style={{ margin: 0 }}>Compiled routing.md</h2>
          <select data-testid="compiled-profile" value={profile} onChange={(e) => setProfile(e.target.value)}>
            {Object.keys(config.profiles).map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </div>
        <pre className="compiled" data-testid="compiled-output">
          {compiled}
        </pre>
      </div>
    </div>
  );
}

function TelemetryPane() {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    fetch("/telemetry")
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData({ count: 0, recent: [], byTarget: {} }));
  }, []);
  if (!data) return <div className="pane muted">loading telemetry…</div>;
  return (
    <div className="pane">
      <div className="section">
        <h2>Decisions ({data.count})</h2>
        <table>
          <thead>
            <tr>
              <th>target</th>
              <th>hits</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(data.byTarget || {}).map(([t, n]: any) => (
              <tr key={t}>
                <td>{t}</td>
                <td>{n}</td>
              </tr>
            ))}
            {Object.keys(data.byTarget || {}).length === 0 && (
              <tr>
                <td colSpan={2} className="muted">
                  no decisions logged yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function App() {
  const { config, update, saveState } = useRouting();
  const [tab, setTab] = useState("policy");
  if (!config) return <div style={{ padding: 24 }}>loading…</div>;
  return (
    <div className="app">
      <Header config={config} update={update} saveState={saveState} />
      <div className="tabs">
        {["policy", "simulator", "compiled", "telemetry"].map((t) => (
          <div key={t} className={`tab ${tab === t ? "active" : ""}`} data-testid={`tab-${t}`} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </div>
        ))}
      </div>
      <main>
        {tab === "policy" && <PolicyPane config={config} update={update} />}
        {tab === "simulator" && <SimulatorPane config={config} />}
        {tab === "compiled" && <CompiledPane config={config} />}
        {tab === "telemetry" && <TelemetryPane />}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
