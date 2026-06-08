"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AutosaveStatus } from "@/hooks/useAutosave";
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

const STATUS_WORD: Record<AutosaveStatus, string> = {
  idle: "",
  saving: "saving…",
  saved: "saved",
  error: "save failed"
};

const DEBOUNCE_MS = 700;
const DRIFT_POLL_MS = 5000;

// No save button. Discrete controls (boolean / enum) autosave immediately; text,
// number and JSON controls debounce. The backend writeSettingsPatch merges only
// the changed keys onto a fresh read (never a blind overwrite) and refreshes the
// drift baseline, so each per-key save is echo-suppressed. A visibility-gated
// poll of /api/settings/drift surfaces external edits (Claude Code's /model,
// permission approvals) as a live banner while the page sits idle.
export function SettingsPanel() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [overrides, setOverrides] = useState<Record<string, unknown>>({});
  const [jsonText, setJsonText] = useState<Record<string, string>>({});
  const [jsonErr, setJsonErr] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [drift, setDrift] = useState(false);

  const pending = useRef<Record<string, unknown>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/settings");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setView(data as SettingsView);
      setOverrides({});
      setJsonText({});
      setJsonErr({});
      pending.current = {};
      setDrift(Boolean((data as SettingsView).drift?.changedExternally));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const patch = pending.current;
    if (Object.keys(patch).length === 0) return;
    pending.current = {};
    setStatus("saving");
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      // Refresh from the authoritative post-write view. Sticky overrides keep the
      // user's in-flight edits visible on top until an explicit Reload.
      setView(data as SettingsView);
      setDrift(Boolean((data as SettingsView).drift?.changedExternally));
      setStatus("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, []);

  // Flush any pending edit on unmount so navigating away never drops it.
  useEffect(() => () => void flush(), [flush]);

  const queue = useCallback(
    (key: string, value: unknown, immediate: boolean) => {
      pending.current = { ...pending.current, [key]: value };
      setOverrides((o) => ({ ...o, [key]: value }));
      setStatus("idle");
      if (immediate) {
        void flush();
        return;
      }
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), DEBOUNCE_MS);
    },
    [flush]
  );

  const setScalar = useCallback(
    (key: string, value: unknown, immediate: boolean) => queue(key, value, immediate),
    [queue]
  );

  const setJson = useCallback(
    (key: string, text: string) => {
      setJsonText((t) => ({ ...t, [key]: text }));
      if (text.trim() === "") {
        // empty means "remove this key"
        setJsonErr((e) => ({ ...e, [key]: "" }));
        queue(key, undefined, false);
        return;
      }
      try {
        const parsed = JSON.parse(text);
        setJsonErr((e) => ({ ...e, [key]: "" }));
        queue(key, parsed, false);
      } catch (err) {
        // Don't autosave a half-typed value: drop it from the pending patch and
        // surface the parse error. It re-queues once the JSON parses again.
        setJsonErr((e) => ({ ...e, [key]: err instanceof Error ? err.message : "invalid JSON" }));
        const { [key]: _drop, ...rest } = pending.current;
        void _drop;
        pending.current = rest;
      }
    },
    [queue]
  );

  // Visibility-gated drift poll — only while visible, not saving, and with no
  // pending edits (so it never races a debounced write).
  useEffect(() => {
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (status === "saving") return;
      if (Object.keys(pending.current).length > 0) return;
      void (async () => {
        try {
          const res = await fetch("/api/settings/drift");
          if (!res.ok) return;
          const d = await res.json();
          setDrift(Boolean(d.changedExternally));
        } catch {
          // ignore transient poll errors
        }
      })();
    }, DRIFT_POLL_MS);
    return () => clearInterval(id);
  }, [status]);

  const currentValue = useCallback(
    (k: KnownSettingView): unknown =>
      Object.prototype.hasOwnProperty.call(overrides, k.key) ? overrides[k.key] : k.value,
    [overrides]
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
            A merge-managed view of <code>~/.claude/settings.json</code>. Changes save automatically —
            Garrison writes only the key you touch, preserves bespoke/unknown keys untouched, and never
            blind-overwrites. Claude Code itself rewrites this file, so it is owned cooperatively, not
            exclusively.
          </p>
        </div>

        {error ? (
          <div className="banner alarm" data-testid="settings-error">
            <span className="glyph">!</span>
            <div><h5>Could not read or write settings</h5><p>{error}</p></div>
          </div>
        ) : null}

        {drift ? (
          <div className="banner alarm" data-testid="drift-banner">
            <span className="glyph">!</span>
            <div>
              <h5>Changed outside Garrison</h5>
              <p>
                <code>settings.json</code> differs from what Garrison last wrote (Claude Code edits it
                on /model, permission approvals, etc.).{" "}
                <button className="btn small ghost" data-testid="drift-reload" onClick={() => void load()}>
                  Reload from disk
                </button>{" "}
                to pull the current values before editing.
              </p>
            </div>
          </div>
        ) : null}

        {!view?.exists ? (
          <div className="banner" data-testid="missing-banner" style={{ border: "1px solid var(--rule)", padding: "12px 16px" }}>
            <p style={{ margin: 0, color: "var(--mute)", fontSize: 13 }}>
              No <code>settings.json</code> yet — changing any field creates it.
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
                  onScalar={(v, immediate) => setScalar(s.key, v, immediate)}
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
          <span
            data-testid="autosave-status"
            style={{
              fontSize: 12.5,
              color: status === "error" ? "var(--alarm)" : "var(--sage)",
              minWidth: 64
            }}
          >
            {STATUS_WORD[status]}
          </span>
          <button className="btn small ghost" onClick={() => void load()}>Reload</button>
          <span style={{ color: "var(--mute)", fontSize: 11.5 }}>Changes save automatically.</span>
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
  onScalar: (v: unknown, immediate: boolean) => void;
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
            onChange={(e) => onScalar(e.target.checked, true)}
          />
        ) : setting.control === "number" ? (
          <input
            className="text"
            type="number"
            data-testid={`setting-${setting.key}`}
            value={value === undefined || value === null ? "" : String(value)}
            onChange={(e) => onScalar(e.target.value === "" ? undefined : Number(e.target.value), false)}
            onBlur={(e) => onScalar(e.target.value === "" ? undefined : Number(e.target.value), true)}
          />
        ) : setting.control === "enum" ? (
          <select
            className="text"
            data-testid={`setting-${setting.key}`}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onScalar(e.target.value === "" ? undefined : e.target.value, true)}
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
            onChange={(e) => onScalar(e.target.value === "" ? undefined : e.target.value, false)}
            onBlur={(e) => onScalar(e.target.value === "" ? undefined : e.target.value, true)}
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
