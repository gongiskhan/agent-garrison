"use client";

import { useCallback, useEffect, useState } from "react";

interface InstallStatus {
  installed: boolean;
  installedAt: string | null;
  disabledAt: string | null;
  grandfathered: boolean;
  backupDir: string | null;
  hasEvidence: boolean;
}

type Action = "install" | "disable" | "backup";

function fmt(ts: string | null): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

// Existing install controls remain here until install moves to Mesh.
// The managed config is now the Garrison home.
export function InstallBanner() {
  const [status, setStatus] = useState<InstallStatus | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/install");
      const data = await r.json();
      if (r.ok) setStatus(data as InstallStatus);
      else setMsg(data.error ?? "could not read install status");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(async (action: Action) => {
    setBusy(action);
    setMsg(null);
    try {
      const r = await fetch("/api/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action })
      });
      const data = await r.json();
      if (r.ok) {
        setStatus(data as InstallStatus);
        setMsg(
          action === "install"
            ? "Installed. Garrison manages its own home; your prior config was backed up."
            : action === "disable"
              ? "Management disabled. Garrison will not update its runtime config."
              : "Backed up current config."
        );
      } else {
        setMsg(data.error ?? `${action} failed`);
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, []);

  if (!status) return null;

  // Not installed: a prominent call to action. Garrison is touching nothing.
  if (!status.installed) {
    return (
      <div
        className="banner warn"
        data-testid="install-banner"
        data-installed="false"
        style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}
      >
        <span className="glyph">!</span>
        <div style={{ flex: 1 }}>
          <h5 style={{ margin: 0 }}>Garrison is not managing this machine</h5>
          <p style={{ margin: "4px 0 0" }}>
            Garrison keeps its runtime config in the Garrison home. Installing takes a backup of
            your Claude Code config first; only fittings marked Shared are installed there.
            {msg ? <b style={{ marginLeft: 6 }} data-testid="install-msg">{msg}</b> : null}
          </p>
        </div>
        <button
          className="btn primary"
          data-testid="install-button"
          disabled={busy !== null}
          onClick={() => void act("install")}
        >
          {busy === "install" ? "Installing…" : "Install Garrison"}
        </button>
      </div>
    );
  }

  // Installed: a compact status strip with the disable / backup affordances.
  return (
    <div
      className="banner"
      data-testid="install-banner"
      data-installed="true"
      data-grandfathered={status.grandfathered ? "true" : "false"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        marginBottom: 14,
        border: "1px solid var(--rule)",
        background: "var(--paper)",
        padding: "10px 14px",
        fontSize: 12.5
      }}
    >
      <span className="pill verified" style={{ fontSize: 10.5 }}>
        Garrison home
      </span>
      <div style={{ flex: 1, minWidth: 0, color: "var(--mute)" }}>
        {status.grandfathered ? (
          <>
            Adopted an existing Garrison install{status.installedAt ? ` (${fmt(status.installedAt)})` : ""} —{" "}
            <b>no pre-install backup</b> was captured. Take one now to enable a clean restore later.
          </>
        ) : (
          <>
            Installed {fmt(status.installedAt)}
            {status.backupDir ? (
              <>
                {" "}· restore point at{" "}
                <code style={{ overflowWrap: "anywhere", whiteSpace: "normal" }}>{status.backupDir}</code>
              </>
            ) : null}
          </>
        )}
        {msg ? <b style={{ marginLeft: 6, color: "var(--ink)" }} data-testid="install-msg">{msg}</b> : null}
      </div>
      {status.grandfathered ? (
        <button
          className="btn small ghost"
          data-testid="backup-button"
          disabled={busy !== null}
          onClick={() => void act("backup")}
        >
          {busy === "backup" ? "Backing up…" : "Back up current config"}
        </button>
      ) : null}
      <button
        className="btn small ghost"
        data-testid="disable-button"
        disabled={busy !== null}
        onClick={() => void act("disable")}
        title="Stop Garrison updating its runtime config. Shared fittings stay installed until unshared."
      >
        {busy === "disable" ? "Disabling…" : "Disable"}
      </button>
    </div>
  );
}
