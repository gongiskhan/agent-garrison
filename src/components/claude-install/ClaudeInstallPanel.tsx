"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppShell } from "@/components/chrome/AppShell";

interface InstalledFitting {
  fittingId: string;
  source: string;
  adopted: boolean;
  installedAt: string;
  artifacts: { target: string }[];
}
interface DriftReport { fittingId: string; target: string; file: string; state: string }
interface Inventory { installed: InstalledFitting[]; drift: DriftReport[] }

export function ClaudeInstallPanel() {
  const { library } = useAppShell();
  const [inv, setInv] = useState<Inventory | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [collision, setCollision] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/claude-install");
      const data = await r.json();
      if (r.ok) setInv({ installed: data.installed ?? [], drift: data.drift ?? [] });
      else setMsg(data.error ?? "could not read inventory");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const installedIds = useMemo(() => new Set((inv?.installed ?? []).map((i) => i.fittingId)), [inv]);
  const skillFittings = useMemo(
    () => library.filter((e) => e.metadata.component_shape === "skill"),
    [library]
  );
  const driftByFitting = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of inv?.drift ?? []) m.set(d.fittingId, (m.get(d.fittingId) ?? 0) + 1);
    return m;
  }, [inv]);

  const act = useCallback(
    async (fittingId: string, action: "install" | "adopt" | "uninstall") => {
      setBusy(`${action}:${fittingId}`);
      setMsg(null);
      try {
        const r = await fetch("/api/claude-install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fittingId, action })
        });
        const data = await r.json();
        if (data.installed) setInv({ installed: data.installed, drift: data.drift ?? [] });
        const result = data.result;
        if (result && result.ok === false) {
          if (result.code === "unowned-collision") {
            setCollision((c) => ({ ...c, [fittingId]: true }));
            setMsg(`${fittingId}: already exists in ~/.claude (unmanaged) — Adopt it to manage.`);
          } else {
            setMsg(`${fittingId}: ${result.code}`);
          }
        } else {
          setCollision((c) => ({ ...c, [fittingId]: false }));
          setMsg(`${fittingId}: ${action} ok`);
        }
      } catch (e) {
        setMsg(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    []
  );

  const installed = inv?.installed ?? [];

  return (
    <section
      data-testid="claude-install-section"
      style={{ border: "1px solid var(--rule)", background: "white", marginBottom: 18 }}
    >
      <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--rule)" }}>
        <h3 className="font-display" style={{ fontWeight: 600, fontSize: 16, margin: 0 }}>
          Installed in <code>~/.claude</code> · {installed.length}
        </h3>
        <p style={{ margin: "4px 0 0", color: "var(--mute)", fontSize: 11.5 }}>
          Garrison installs skill Fittings into your Claude Code install and tracks exactly what it
          owns. It never clobbers hand-authored files; if a skill already exists on disk, Adopt it to
          bring it under management. {msg ? <b data-testid="claude-install-msg" style={{ color: "var(--ink)" }}> · {msg}</b> : null}
        </p>
      </div>

      {installed.length === 0 ? (
        <div style={{ padding: 16, color: "var(--mute)", fontSize: 12.5 }}>Nothing managed yet.</div>
      ) : (
        installed.map((i) => {
          const drift = driftByFitting.get(i.fittingId) ?? 0;
          return (
            <div
              key={i.fittingId}
              data-testid={`installed-row-${i.fittingId}`}
              style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 12, alignItems: "center", padding: "9px 18px", borderBottom: "1px solid var(--rule)" }}
            >
              <span>
                <code style={{ fontSize: 12 }}>{i.fittingId}</code>
                <span style={{ color: "var(--mute)", fontSize: 11, marginLeft: 8 }}>
                  {i.artifacts.length} artifact(s) · {i.adopted ? "adopted" : "installed"}
                </span>
              </span>
              {drift > 0 ? (
                <span className="pill" data-testid={`drift-${i.fittingId}`} style={{ fontSize: 10.5, color: "var(--brass)" }}>
                  {drift} drifted
                </span>
              ) : (
                <span className="pill" style={{ fontSize: 10.5, color: "var(--sage)" }}>clean</span>
              )}
              <button
                className="btn small ghost"
                data-testid={`uninstall-${i.fittingId}`}
                disabled={busy !== null}
                onClick={() => void act(i.fittingId, "uninstall")}
              >
                Uninstall
              </button>
            </div>
          );
        })
      )}

      <div style={{ padding: "10px 18px", borderTop: "1px solid var(--rule)", background: "var(--paper)" }}>
        <span className="font-display" style={{ fontSize: 12.5, fontWeight: 600 }}>Skill Fittings</span>
      </div>
      {skillFittings.length === 0 ? (
        <div style={{ padding: 16, color: "var(--mute)", fontSize: 12.5 }}>No skill Fittings in the library.</div>
      ) : (
        skillFittings.map((e) => {
          const isInstalled = installedIds.has(e.id);
          const collided = collision[e.id];
          return (
            <div
              key={e.id}
              data-testid={`skill-row-${e.id}`}
              style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "center", padding: "9px 18px", borderBottom: "1px solid var(--rule)" }}
            >
              <span>
                <b style={{ fontSize: 13 }}>{e.name}</b>
                <code style={{ fontSize: 11, color: "var(--mute)", marginLeft: 8 }}>{e.id}</code>
              </span>
              <span style={{ display: "flex", gap: 8 }}>
                {isInstalled ? (
                  <span className="pill" style={{ fontSize: 10.5, color: "var(--sage)" }}>managed</span>
                ) : collided ? (
                  <button className="btn small primary" data-testid={`adopt-${e.id}`} disabled={busy !== null} onClick={() => void act(e.id, "adopt")}>
                    Adopt
                  </button>
                ) : (
                  <button className="btn small ghost" data-testid={`install-${e.id}`} disabled={busy !== null} onClick={() => void act(e.id, "install")}>
                    Install
                  </button>
                )}
              </span>
            </div>
          );
        })
      )}
    </section>
  );
}
