"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  SettingsView,
  KnownSettingView,
  SettingGroup
} from "@/lib/settings";

const GROUP_ORDER: { id: SettingGroup; label: string }[] = [
  { id: "model", label: "Model & reasoning" },
  { id: "behavior", label: "Behavior" },
  { id: "appearance", label: "Appearance" },
  { id: "permissions", label: "Permissions" },
  { id: "env", label: "Environment" },
  { id: "cleanup", label: "Cleanup" },
  { id: "advanced", label: "Advanced" }
];

export function SettingsPanel() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [patch, setPatch] = useState<Record<string, unknown>>({});
  const [jsonText, setJsonText] = useState<Record<string, string>>({});
  const [jsonErr, setJsonErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/settings");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setView(data as SettingsView);
      setPatch({});
      setJsonText({});
      setJsonErr({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setScalar = useCallback((key: string, value: unknown) => {
    setSaved(false);
    setPatch((p) => ({ ...p, [key]: value }));
  }, []);

  const setJson = useCallback((key: string, text: string) => {
    setSaved(false);
    setJsonText((t) => ({ ...t, [key]: text }));
    if (text.trim() === "") {
      // empty means "remove this key"
      setPatch((p) => ({ ...p, [key]: undefined }));
      setJsonErr((e) => ({ ...e, [key]: "" }));
      return;
    }
    try {
      const parsed = JSON.parse(text);
      setPatch((p) => ({ ...p, [key]: parsed }));
      setJsonErr((e) => ({ ...e, [key]: "" }));
    } catch (err) {
      setJsonErr((e) => ({ ...e, [key]: err instanceof Error ? err.message : "invalid JSON" }));
    }
  }, []);

  const dirty = Object.keys(patch).length > 0;
  const hasJsonErr = Object.values(jsonErr).some((m) => m && m.length > 0);

  const save = useCallback(async () => {
    if (!dirty || hasJsonErr) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setView(data as SettingsView);
      setPatch({});
      setJsonText({});
      setJsonErr({});
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [dirty, hasJsonErr, patch]);

  const currentValue = useCallback(
    (k: KnownSettingView): unknown => (k.key in patch ? patch[k.key] : k.value),
    [patch]
  );

  const grouped = useMemo(() => {
    const map = new Map<SettingGroup, KnownSettingView[]>();
    for (const s of view?.known ?? []) {
      const arr = map.get(s.group) ?? [];
      arr.push(s);
      map.set(s.group, arr);
    }
    return map;
  }, [view]);

  if (!view && !error) {
    return (
      <main>
        <div className="crumbs"><b>Settings</b></div>
        <div className="page"><p className="ld">Loading ~/.claude/settings.json…</p></div>
      </main>
    );
  }

  return (
    <main>
      <div className="crumbs"><b>Settings</b></div>
      <div className="page">
        <div className="head">
          <h1>Settings</h1>
          <p className="ld">
            A merge-managed view of <code>~/.claude/settings.json</code>. Garrison reads it fresh,
            writes only the keys you change, preserves bespoke/unknown keys untouched, and never
            blind-overwrites — Claude Code itself rewrites this file, so it is owned cooperatively,
            not exclusively.
          </p>
        </div>

        {error ? (
          <div className="banner alarm" data-testid="settings-error">
            <span className="glyph">!</span>
            <div><h5>Could not read or write settings</h5><p>{error}</p></div>
          </div>
        ) : null}

        {view?.drift.changedExternally ? (
          <div className="banner alarm" data-testid="drift-banner">
            <span className="glyph">!</span>
            <div>
              <h5>Changed outside Garrison</h5>
              <p>
                <code>settings.json</code> differs from what Garrison last wrote (Claude Code edits it
                on /model, permission approvals, etc.). The values below are the current on-disk state;
                saving reconciles the baseline.
              </p>
            </div>
          </div>
        ) : null}

        {!view?.exists ? (
          <div className="banner" data-testid="missing-banner" style={{ border: "1px solid var(--rule)", padding: "12px 16px" }}>
            <p style={{ margin: 0, color: "var(--mute)", fontSize: 13 }}>
              No <code>settings.json</code> yet — saving any field creates it.
            </p>
          </div>
        ) : null}

        {GROUP_ORDER.map(({ id, label }) => {
          const items = grouped.get(id);
          if (!items || items.length === 0) return null;
          return (
            <section
              key={id}
              style={{ border: "1px solid var(--rule)", background: "white", margin: "0 0 18px" }}
            >
              <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--rule)" }}>
                <h3 className="font-display" style={{ fontWeight: 600, fontSize: 16, margin: 0 }}>{label}</h3>
                {id === "permissions" ? (
                  <p style={{ margin: "4px 0 0", color: "var(--mute)", fontSize: 11.5 }}>
                    {view?.permissionsScopeNote}
                  </p>
                ) : null}
              </div>
              {items.map((s) => (
                <SettingRow
                  key={s.key}
                  setting={s}
                  value={currentValue(s)}
                  jsonText={jsonText[s.key]}
                  jsonErr={jsonErr[s.key]}
                  onScalar={(v) => setScalar(s.key, v)}
                  onJson={(t) => setJson(s.key, t)}
                />
              ))}
            </section>
          );
        })}

        <section style={{ border: "1px solid var(--rule)", background: "white", margin: "0 0 18px" }} data-testid="advanced-section">
          <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--rule)" }}>
            <h3 className="font-display" style={{ fontWeight: 600, fontSize: 16, margin: 0 }}>
              Advanced — unmanaged keys · {view?.unknown.length ?? 0}
            </h3>
            <p style={{ margin: "4px 0 0", color: "var(--mute)", fontSize: 11.5 }}>
              Keys not in Garrison&apos;s documented map (bespoke / experimental). Shown as raw JSON and
              round-tripped untouched. Clear a field to remove that key.
            </p>
          </div>
          {(view?.unknown ?? []).length === 0 ? (
            <div style={{ padding: 20, color: "var(--mute)", fontSize: 13, textAlign: "center" }}>
              No unmanaged keys.
            </div>
          ) : (
            (view?.unknown ?? []).map((u) => (
              <div
                key={u.key}
                data-testid={`unknown-${u.key}`}
                style={{ padding: "11px 18px", borderBottom: "1px solid var(--rule)" }}
              >
                <label className="font-mono" style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>{u.key}</label>
                <textarea
                  className="text"
                  data-testid={`setting-${u.key}`}
                  style={{ fontFamily: "var(--font-mono), monospace", fontSize: 12, width: "100%", minHeight: 52, marginTop: 6 }}
                  value={jsonText[u.key] ?? JSON.stringify(u.value, null, 2)}
                  onChange={(e) => setJson(u.key, e.target.value)}
                />
                {jsonErr[u.key] ? (
                  <p style={{ margin: "4px 0 0", color: "var(--alarm)", fontSize: 11 }}>{jsonErr[u.key]}</p>
                ) : null}
              </div>
            ))
          )}
        </section>

        <HooksSection view={view} />

        <div
          style={{
            position: "sticky",
            bottom: 0,
            background: "var(--paper)",
            borderTop: "1px solid var(--rule)",
            padding: "12px 0",
            display: "flex",
            gap: 12,
            alignItems: "center"
          }}
        >
          <button
            className="btn primary"
            data-testid="settings-save"
            disabled={!dirty || hasJsonErr || busy}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save changes"}
          </button>
          <button className="btn small ghost" disabled={busy} onClick={() => void load()}>Reload</button>
          {saved ? <span style={{ color: "var(--sage)", fontSize: 12.5 }} data-testid="saved-flag">Saved.</span> : null}
          {dirty ? <span style={{ color: "var(--mute)", fontSize: 12 }}>{Object.keys(patch).length} change(s) pending</span> : null}
          {hasJsonErr ? <span style={{ color: "var(--alarm)", fontSize: 12 }}>Fix JSON errors to save</span> : null}
        </div>
      </div>
    </main>
  );
}

function SettingRow({
  setting,
  value,
  jsonText,
  jsonErr,
  onScalar,
  onJson
}: {
  setting: KnownSettingView;
  value: unknown;
  jsonText: string | undefined;
  jsonErr: string | undefined;
  onScalar: (v: unknown) => void;
  onJson: (t: string) => void;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(200px, 280px) 1fr", gap: 16, alignItems: "start", padding: "12px 18px", borderBottom: "1px solid var(--rule)" }}>
      <div>
        <label className="font-display" style={{ fontWeight: 600, fontSize: 13.5, display: "block" }}>{setting.label}</label>
        <code style={{ fontSize: 11, color: "var(--mute)" }}>{setting.key}</code>
        <p style={{ margin: "3px 0 0", color: "var(--mute)", fontSize: 11.5 }}>{setting.doc}</p>
      </div>
      <div>
        {setting.control === "boolean" ? (
          <input
            type="checkbox"
            data-testid={`setting-${setting.key}`}
            checked={value === true}
            onChange={(e) => onScalar(e.target.checked)}
          />
        ) : setting.control === "number" ? (
          <input
            className="text"
            type="number"
            data-testid={`setting-${setting.key}`}
            value={value === undefined || value === null ? "" : String(value)}
            onChange={(e) => onScalar(e.target.value === "" ? undefined : Number(e.target.value))}
          />
        ) : setting.control === "enum" ? (
          <select
            className="text"
            data-testid={`setting-${setting.key}`}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onScalar(e.target.value === "" ? undefined : e.target.value)}
          >
            <option value="">(unset)</option>
            {(setting.enumValues ?? []).map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        ) : setting.control === "json" ? (
          <>
            <textarea
              className="text"
              data-testid={`setting-${setting.key}`}
              style={{ fontFamily: "var(--font-mono), monospace", fontSize: 12, width: "100%", minHeight: 64 }}
              value={jsonText ?? (value === undefined ? "" : JSON.stringify(value, null, 2))}
              onChange={(e) => onJson(e.target.value)}
            />
            {jsonErr ? <p style={{ margin: "4px 0 0", color: "var(--alarm)", fontSize: 11 }}>{jsonErr}</p> : null}
          </>
        ) : (
          <input
            className="text"
            type="text"
            data-testid={`setting-${setting.key}`}
            value={typeof value === "string" ? value : value === undefined ? "" : String(value)}
            onChange={(e) => onScalar(e.target.value === "" ? undefined : e.target.value)}
          />
        )}
      </div>
    </div>
  );
}

function HooksSection({ view }: { view: SettingsView | null }) {
  const hooks = view?.hooks ?? [];
  return (
    <section style={{ border: "1px solid var(--rule)", background: "white", margin: "0 0 18px" }} data-testid="hooks-section">
      <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--rule)" }}>
        <h3 className="font-display" style={{ fontWeight: 600, fontSize: 16, margin: 0 }}>Hooks · {hooks.length}</h3>
        <p style={{ margin: "4px 0 0", color: "var(--mute)", fontSize: 11.5 }}>
          Read-only. Garrison-owned groups are labelled by their owning fitting; add/remove is managed
          through fitting install/uninstall, not here. Hand-authored groups are shown and never touched.
        </p>
      </div>
      {hooks.length === 0 ? (
        <div style={{ padding: 20, color: "var(--mute)", fontSize: 13, textAlign: "center" }}>No hooks configured.</div>
      ) : (
        hooks.map((h, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "160px 160px 1fr", gap: 12, padding: "10px 18px", borderBottom: "1px solid var(--rule)", alignItems: "center" }}>
            <span className="font-mono" style={{ fontSize: 12, fontWeight: 600 }}>{h.event}</span>
            <span className="pill" style={{ fontSize: 10.5, justifySelf: "start" }}>{h.owner}</span>
            <code style={{ fontSize: 11, color: "var(--mute)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {h.commands[0] ?? h.matcher ?? ""}
            </code>
          </div>
        ))
      )}
    </section>
  );
}
