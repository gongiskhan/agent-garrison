import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useState } from "react";

type Entity = {
  pid: number;
  ppid: number;
  etime: string;
  pcpu: number;
  pmem: number;
  stat: string;
  start: string;
  command: string;
  commandLine: string;
  cwd: string | null;
  env: Record<string, string>;
  ports: {
    listening: Array<{ port: number; address: string }>;
    connections: Array<{ state: string; peer: string }>;
  };
  tracked: boolean;
  spawnSite: string | null;
  description: string | null;
  spawnedAt: string | null;
  hasLogs: boolean;
  status: "alive" | "exiting" | "dead";
  diedAt?: string;
};

type Snapshot = { kind: "snapshot"; entities: Entity[] };

function StatusDot({ status, stat }: { status: Entity["status"]; stat: string }) {
  const first = stat?.[0] ?? "?";
  let color = "var(--muted)";
  let label = "unknown";
  if (status === "dead") { color = "var(--danger)"; label = "dead"; }
  else if (status === "exiting") { color = "var(--warning)"; label = "exiting"; }
  else if (first === "R") { color = "var(--success)"; label = "running"; }
  else if (first === "S") { color = "var(--info)"; label = "sleeping"; }
  else if (first === "T") { color = "var(--warning)"; label = "stopped"; }
  else if (first === "Z") { color = "var(--danger)"; label = "zombie"; }
  return (
    <span className="status-dot" title={label}>
      <span className="dot" style={{ background: color }} />
      <span className="status-label">{label}</span>
    </span>
  );
}

function shortCommand(e: Entity): string {
  if (e.description) return e.description;
  const cmd = e.commandLine || e.command;
  return cmd.length > 64 ? cmd.slice(0, 64) + "…" : cmd;
}

function ProcessCard({ entity, onOpen }: { entity: Entity; onOpen: (pid: number) => void }) {
  const ports = entity.ports.listening.map((p) => p.port);
  return (
    <div
      className={"card" + (entity.status === "dead" ? " card-dead" : "")}
      onClick={() => onOpen(entity.pid)}
      role="button"
      tabIndex={0}
    >
      <div className="card-row">
        <StatusDot status={entity.status} stat={entity.stat} />
        <span className="pid">PID {entity.pid}</span>
        <span className="uptime mono">{entity.etime}</span>
      </div>
      <div className="card-label mono">{shortCommand(entity)}</div>
      <div className="card-row card-meta">
        <span className="mono">CPU {entity.pcpu.toFixed(1)}%</span>
        <span className="mono">MEM {entity.pmem.toFixed(1)}%</span>
        {ports.length > 0 && (
          <span className="ports">
            ports:{" "}
            {ports.map((p, i) => (
              <a
                key={`${i}-${p}`}
                href={`http://localhost:${p}`}
                className="mono"
                onClick={(ev) => ev.stopPropagation()}
                target="_blank"
                rel="noreferrer"
              >
                {p}
              </a>
            ))}
          </span>
        )}
        {entity.spawnSite && <span className="tag">{entity.spawnSite}</span>}
        {entity.tracked && <span className="tag tag-tracked">tracked</span>}
      </div>
    </div>
  );
}

function LogViewer({ pid, stream }: { pid: number; stream: "stdout" | "stderr" | "combined" }) {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    setLines([]);
    const es = new EventSource(`/api/entities/${pid}/logs?stream=${stream}&tail=1`);
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        setLines((prev) => {
          const next = prev.concat(`${data.source}: ${data.line}`);
          return next.slice(-1000);
        });
      } catch {}
    };
    es.onerror = () => {};
    return () => es.close();
  }, [pid, stream]);

  return (
    <pre className="logs mono">
      {lines.length === 0 ? "(no logs yet — process may not have written through the spawn helper)" : lines.join("\n")}
    </pre>
  );
}

function ProcessTree({ entities, focusPid, onOpen }: { entities: Entity[]; focusPid: number; onOpen: (pid: number) => void }) {
  const byParent = new Map<number, Entity[]>();
  for (const e of entities) {
    if (!byParent.has(e.ppid)) byParent.set(e.ppid, []);
    byParent.get(e.ppid)!.push(e);
  }
  function renderNode(pid: number, depth: number): React.ReactNode {
    const e = entities.find((x) => x.pid === pid);
    if (!e) return null;
    const children = byParent.get(pid) ?? [];
    return (
      <div key={pid} className="tree-node" style={{ marginLeft: depth * 14 }}>
        <button
          className={"tree-button mono" + (pid === focusPid ? " tree-button-active" : "")}
          onClick={() => onOpen(pid)}
        >
          PID {pid} · {shortCommand(e)}
        </button>
        {children.map((c) => renderNode(c.pid, depth + 1))}
      </div>
    );
  }
  // Find the focus entity's root ancestor among visible entities for context.
  const focus = entities.find((e) => e.pid === focusPid);
  const rootPid = focus ? (entities.find((e) => e.pid === focus.ppid) ? focus.ppid : focus.pid) : focusPid;
  return <div className="tree">{renderNode(rootPid, 0)}</div>;
}

function Drilldown({
  entity,
  entities,
  onClose,
  onOpen
}: {
  entity: Entity;
  entities: Entity[];
  onClose: () => void;
  onOpen: (pid: number) => void;
}) {
  const [showEnv, setShowEnv] = useState(false);
  const [logStream, setLogStream] = useState<"stdout" | "stderr" | "combined">("stdout");

  return (
    <aside className="drilldown">
      <header className="drilldown-header">
        <div>
          <StatusDot status={entity.status} stat={entity.stat} />
          <h2 className="mono">PID {entity.pid}</h2>
        </div>
        <button className="close-btn" onClick={onClose} aria-label="close">close</button>
      </header>

      <section>
        <h3>command</h3>
        <pre className="mono">{entity.commandLine}</pre>
      </section>

      <section className="kv">
        <div><span className="k">cwd</span><span className="v mono">{entity.cwd ?? "(unknown)"}</span></div>
        <div><span className="k">parent</span><span className="v mono">{entity.ppid}</span></div>
        <div><span className="k">started</span><span className="v mono">{entity.spawnedAt ?? entity.start}</span></div>
        <div><span className="k">uptime</span><span className="v mono">{entity.etime}</span></div>
        <div><span className="k">cpu</span><span className="v mono">{entity.pcpu.toFixed(1)}%</span></div>
        <div><span className="k">mem</span><span className="v mono">{entity.pmem.toFixed(1)}%</span></div>
        {entity.spawnSite && <div><span className="k">spawn-site</span><span className="v mono">{entity.spawnSite}</span></div>}
      </section>

      <section>
        <h3>ports (listening)</h3>
        {entity.ports.listening.length === 0 ? (
          <div className="empty">none</div>
        ) : (
          <ul className="port-list">
            {entity.ports.listening.map((p, i) => (
              <li key={i}>
                <a href={`http://localhost:${p.port}`} target="_blank" rel="noreferrer" className="mono">
                  http://localhost:{p.port}
                </a>
                <span className="muted mono"> · {p.address}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3>network connections</h3>
        {entity.ports.connections.length === 0 ? (
          <div className="empty">none</div>
        ) : (
          <ul className="conn-list">
            {entity.ports.connections.slice(0, 25).map((c, i) => (
              <li key={i} className="mono">
                <span className="tag">{c.state}</span> {c.peer}
              </li>
            ))}
            {entity.ports.connections.length > 25 && (
              <li className="muted">+{entity.ports.connections.length - 25} more…</li>
            )}
          </ul>
        )}
      </section>

      <section>
        <h3>process tree</h3>
        <ProcessTree entities={entities} focusPid={entity.pid} onOpen={onOpen} />
      </section>

      <section>
        <h3>env</h3>
        <button className="link-btn" onClick={() => setShowEnv((v) => !v)}>
          {showEnv ? "hide" : "show"} ({Object.keys(entity.env).length} keys)
        </button>
        {showEnv && (
          <pre className="env mono">
            {Object.entries(entity.env)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => `${k}=${v}`)
              .join("\n")}
          </pre>
        )}
      </section>

      <section>
        <h3>logs</h3>
        <div className="log-tabs">
          {(["stdout", "stderr", "combined"] as const).map((s) => (
            <button
              key={s}
              className={"tab" + (s === logStream ? " tab-active" : "")}
              onClick={() => setLogStream(s)}
            >
              {s}
            </button>
          ))}
        </div>
        <LogViewer pid={entity.pid} stream={logStream} />
      </section>
    </aside>
  );
}

function App() {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [openPid, setOpenPid] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/entities/stream");
    es.onmessage = (ev) => {
      try {
        const data: Snapshot = JSON.parse(ev.data);
        if (data.kind === "snapshot") {
          setEntities(data.entities);
          setError(null);
        }
      } catch (e) {
        setError("failed to parse snapshot");
      }
    };
    es.onerror = () => setError("disconnected from monitor");
    return () => es.close();
  }, []);

  const open = useMemo(() => entities.find((e) => e.pid === openPid) ?? null, [entities, openPid]);

  const live = entities.filter((e) => e.status !== "dead");
  const dead = entities.filter((e) => e.status === "dead");

  return (
    <div className={"app" + (open ? " app-drilldown" : "")}>
      <header className="app-header">
        <h1>Garrison Monitor</h1>
        <span className="muted mono">{live.length} live · {dead.length} exited</span>
        {error && <span className="error">{error}</span>}
      </header>

      <main className="grid">
        {entities.length === 0 ? (
          <div className="empty-state">No entities yet. The Monitor watches descendants of the Garrison runtime — spawn something through the runner to see it here.</div>
        ) : (
          [...live, ...dead].map((e) => (
            <ProcessCard key={e.pid} entity={e} onOpen={setOpenPid} />
          ))
        )}
      </main>

      {open && (
        <Drilldown
          entity={open}
          entities={entities}
          onClose={() => setOpenPid(null)}
          onOpen={setOpenPid}
        />
      )}
    </div>
  );
}

const rootEl = document.getElementById("root")!;
createRoot(rootEl).render(<App />);
