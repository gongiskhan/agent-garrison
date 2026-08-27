"use client";

// Mesh git controls - present on EVERY node (app-level, not fitting-level),
// because the machine most in need of converging is the one whose
// composition is down. Two verbs, both state-mediated:
//   Pull mesh -> this node   (peers commit+push, this node fetches + merges)
//   Push this node -> mesh   (commit+push here, one merge card per peer)

import { useCallback, useEffect, useState } from "react";
import styles from "./MeshGitPanel.module.css";

interface PullNodeRow {
  node: string;
  status: string;
  merge?: string;
  sha?: string | null;
  detail?: string | null;
}

interface ActionResult {
  kind: "pull" | "push";
  project: string;
  summary: string;
  rows: { label: string; value: string }[];
  error?: string;
}

export function MeshGitPanel() {
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState("garrison");
  const [busy, setBusy] = useState<"pull" | "push" | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);

  useEffect(() => {
    fetch("/api/mesh/git/projects")
      .then((r) => r.json())
      .then((d) => setProjects(d.projects ?? []))
      .catch(() => setProjects(["garrison"]));
  }, []);

  const run = useCallback(
    async (kind: "pull" | "push") => {
      setBusy(kind);
      setResult(null);
      try {
        const res = await fetch(`/api/mesh/git/${kind}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project })
        });
        const body = await res.json();
        if (!res.ok) {
          setResult({ kind, project, summary: "failed", rows: [], error: body?.detail ?? body?.error ?? `HTTP ${res.status}` });
          return;
        }
        if (kind === "pull") {
          const rows = (body.nodes ?? []).map((n: PullNodeRow) => ({
            label: n.node,
            value: `${n.status}${n.merge ? ` / ${n.merge}` : ""}${n.sha ? ` @ ${String(n.sha).slice(0, 8)}` : ""}${n.detail ? ` - ${n.detail}` : ""}`
          }));
          setResult({ kind, project, summary: `${body.note ?? ""} (via ${body.via})`, rows });
        } else {
          const rows = [
            { label: "this node", value: `${body.self?.result ?? "?"}${body.self?.branch ? ` on ${body.self.branch}` : ""}${body.self?.sha ? ` @ ${String(body.self.sha).slice(0, 8)}` : ""}` },
            ...(body.cards ?? []).map((c: { node: string; cardId: string }) => ({
              label: c.node,
              value: `merge card filed (${c.cardId.slice(0, 10)}...)`
            }))
          ];
          setResult({ kind, project, summary: "pushed to the mesh; merge cards filed per peer", rows });
        }
      } catch (err) {
        setResult({ kind, project, summary: "failed", rows: [], error: err instanceof Error ? err.message : String(err) });
      } finally {
        setBusy(null);
      }
    },
    [project]
  );

  return (
    <section className={styles.panel} aria-label="Mesh git">
      <header className={styles.head}>
        <h2>Converge</h2>
        <p>Move a project between this node and the rest of the mesh - through git, never by copy.</p>
      </header>
      <div className={styles.controls}>
        <select value={project} onChange={(e) => setProject(e.target.value)} disabled={busy !== null}>
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button onClick={() => run("pull")} disabled={busy !== null}>
          {busy === "pull" ? "Pulling from the mesh..." : "Pull mesh into this node"}
        </button>
        <button onClick={() => run("push")} disabled={busy !== null}>
          {busy === "push" ? "Pushing to the mesh..." : "Push this node to the mesh"}
        </button>
      </div>
      {busy === "pull" ? <p className={styles.note}>Peers are committing and pushing (up to two minutes); then this node fetches and merges.</p> : null}
      {result ? (
        <div className={styles.result}>
          <p className={result.error ? styles.error : styles.summary}>
            {result.kind === "pull" ? "Pull" : "Push"} {result.project}: {result.error ?? result.summary}
          </p>
          <ul>
            {result.rows.map((r) => (
              <li key={r.label}>
                <span className={styles.nodeName}>{r.label}</span> {r.value}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
