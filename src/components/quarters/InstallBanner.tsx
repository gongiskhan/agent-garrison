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

// Machine-level Install gate control for Garrison's management of ~/.claude.
// Until Install runs, Garrison refuses every write to the user's Claude Code
// config (reads still work — Quarters can SHOW it). Install first snapshots the
// pristine config as the restore baseline, then enables management.
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
            ? "Installed. Garrison now manages ~/.claude; your prior config was backed up."
            : action === "disable"
              ? "Management disabled. Garrison will not write to ~/.claude."
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
            Your <code>~/.claude</code> config is untouched — Garrison refuses every write until you
            install it here. Installing snapshots your current config first (a restore point), then
            merges Garrison&apos;s pieces in without overwriting your settings.
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
        managing ~/.claude
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
        title="Stop Garrison writing to ~/.claude. Nothing is removed or restored (full Uninstall is separate)."
      >
        {busy === "disable" ? "Disabling…" : "Disable"}
      </button>
    </div>
  );
}
