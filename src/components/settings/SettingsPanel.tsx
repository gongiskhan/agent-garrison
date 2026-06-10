"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { AutosaveStatus } from "@/hooks/useAutosave";
// Value import from the PURE catalog module only — @/lib/settings is the
// server-side IO module (node:fs) and may contribute nothing but types to the
// client bundle.
import { GROUP_ORDER, type SettingGroupId, type FieldDesc } from "@/lib/settings-catalog";
import type { SettingsView, KnownSettingView } from "@/lib/settings";
import { EditorShell } from "./editors/EditorShell";
import { JsonEditor } from "./editors/JsonEditor";

const STATUS_WORD: Record<AutosaveStatus, string> = {
  idle: "",
  saving: "saving…",
  saved: "saved",
  error: "save failed"
};

const DEBOUNCE_MS = 700;
const DRIFT_POLL_MS = 5000;
const NO_SUGGESTIONS = { skills: [] as string[], mcpServers: [] as string[] };

// No save button. Discrete controls (boolean / enum / row add+remove) autosave
// immediately; text, number and JSON controls debounce and flush on blur. The
// backend writeSettingsPatch merges only the changed top-level keys onto a
// fresh read (never a blind overwrite) and refreshes the drift baseline, so
// each per-key save is echo-suppressed. A visibility-gated poll of
// /api/settings/drift surfaces external edits (Claude Code's /model,
// permission approvals) as a live banner while the page sits idle.
//
// Every key of the official settings.json schema renders a per-type editor
// (catalog: src/lib/settings-catalog.ts, schema-synced by test). Keys the
// catalog does not know — bespoke/experimental — round-trip untouched through
// the Advanced passthrough below.
export function SettingsPanel() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [overrides, setOverrides] = useState<Record<string, unknown>>({});
  const [invalid, setInvalidMsgs] = useState<Record<string, string | null>>({});
  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [drift, setDrift] = useState(false);
  const [query, setQuery] = useState("");
  const [activeGroup, setActiveGroup] = useState<SettingGroupId>("model");
  const [enterpriseOpen, setEnterpriseOpen] = useState(false);

  const pending = useRef<Record<string, unknown>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sectionRefs = useRef(new Map<string, HTMLElement>());

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/settings");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setView(data as SettingsView);
      setOverrides({});
      setInvalidMsgs({});
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
    const all = pending.current;
    if (Object.keys(all).length === 0) return;
    pending.current = {};
    setStatus("saving");
    setError(null);
    try {
      // JSON.stringify drops undefined values, so deletions travel as an
      // explicit `remove` list — otherwise "unset" would silently no-op.
      const patch: Record<string, unknown> = {};
      const remove: string[] = [];
      for (const [key, value] of Object.entries(all)) {
        if (value === undefined) remove.push(key);
        else patch[key] = value;
      }
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch, remove })
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

  // "Reload from disk" (drift banner): pull current disk values AND advance the
  // baseline so the banner clears. A plain GET reload re-reads but leaves the
  // baseline stale, so the banner never went away — this hits the dedicated
  // reload endpoint that refreshes last-seen.
  const reloadFromDisk = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/settings/reload", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setView(data as SettingsView);
      setOverrides({});
      setInvalidMsgs({});
      pending.current = {};
      setDrift(Boolean((data as SettingsView).drift?.changedExternally));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

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

  // Structured editors propagate their in-progress value (so the form stays
  // visible) and then mark it invalid — which pulls it OUT of the patch queue
  // until it is complete again. Invalid input is shown, never written.
  const setStructured = useCallback(
    (key: string, value: unknown, opts?: { immediate?: boolean }) => queue(key, value, opts?.immediate ?? false),
    [queue]
  );

  const setInvalid = useCallback((key: string, msg: string | null) => {
    setInvalidMsgs((m) => (m[key] === msg ? m : { ...m, [key]: msg }));
    if (msg) {
      const { [key]: _drop, ...rest } = pending.current;
      void _drop;
      pending.current = rest;
    }
  }, []);

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
    const map = new Map<SettingGroupId, KnownSettingView[]>();
    for (const s of view?.known ?? []) {
      const arr = map.get(s.group) ?? [];
      arr.push(s);
      map.set(s.group, arr);
    }
    return map;
  }, [view]);

  // Search haystack per key: key + label + doc + nested field keys/labels/docs
  // + enum values, lowercased once.
  const haystacks = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of view?.known ?? []) {
      const parts: string[] = [s.key, s.label, s.doc];
      if (s.enumValues) parts.push(...s.enumValues);
      const walk = (fields?: FieldDesc[]) => {
        for (const f of fields ?? []) {
          parts.push(f.key, f.label, f.doc ?? "");
          if (f.enumValues) parts.push(...f.enumValues);
          walk(f.fields);
        }
      };
      walk(s.fields);
      map.set(s.key, parts.join(" ").toLowerCase());
    }
    return map;
  }, [view]);

  const q = query.trim().toLowerCase();
  const matches = useCallback(
    (s: KnownSettingView) => q === "" || (haystacks.get(s.key) ?? "").includes(q),
    [q, haystacks]
  );

  const visibleByGroup = useMemo(() => {
    const map = new Map<SettingGroupId, KnownSettingView[]>();
    for (const { id } of GROUP_ORDER) {
      const items = (grouped.get(id) ?? []).filter(matches);
      if (items.length > 0) map.set(id, items);
    }
    return map;
  }, [grouped, matches]);

  const matchCount = useMemo(
    () => [...visibleByGroup.values()].reduce((n, items) => n + items.length, 0),
    [visibleByGroup]
  );

  // Scroll spy for the group nav: the active group is the last section whose
  // top has crossed the viewport threshold. rAF-throttled.
  useEffect(() => {
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        let active: SettingGroupId | null = null;
        for (const { id } of GROUP_ORDER) {
          const el = sectionRefs.current.get(id);
          if (!el) continue;
          if (active === null) active = id; // topmost visible section is the fallback
          if (el.getBoundingClientRect().top <= 140) active = id;
        }
        if (active) setActiveGroup(active);
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, [visibleByGroup]);

  const jumpTo = (id: SettingGroupId) => {
    if (id === "enterprise") setEnterpriseOpen(true);
    sectionRefs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveGroup(id);
  };

  if (!view && !error) {
    return (
      <main>
        <div className="crumbs"><b>Settings</b></div>
        <div className="page wide"><p className="ld">Loading ~/.claude/settings.json…</p></div>
      </main>
    );
  }

  const suggestions = view?.suggestions ?? NO_SUGGESTIONS;
  const enterpriseEffectiveOpen = enterpriseOpen || (q !== "" && visibleByGroup.has("enterprise"));

  return (
    <main>
      <div className="crumbs"><b>Settings</b></div>
      <div className="page wide">
        <div className="head">
          <h1>Settings</h1>
          <p className="ld">
            A merge-managed view of <code>~/.claude/settings.json</code> — every key of the official
            schema, with per-type editors. Changes save automatically: Garrison writes only the key you
            touch, preserves bespoke/unknown keys untouched, and never blind-overwrites. Claude Code
            itself rewrites this file, so it is owned cooperatively, not exclusively.
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
                <button className="btn small ghost" data-testid="drift-reload" onClick={() => void reloadFromDisk()}>
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

        <div className="settings-layout">
          <aside className="settings-nav" data-testid="settings-nav">
            <input
              className="text"
              type="search"
              data-testid="settings-search"
              placeholder="Search settings"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <p className="snav-count" data-testid="settings-match-count">
              {q === "" ? `${view?.known.length ?? 0} settings` : `${matchCount} match${matchCount === 1 ? "" : "es"}`}
            </p>
            {GROUP_ORDER.filter(({ id }) => visibleByGroup.has(id)).map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className={`snav-item${activeGroup === id ? " active" : ""}`}
                data-testid={`snav-${id}`}
                onClick={() => jumpTo(id)}
              >
                {label}
              </button>
            ))}
          </aside>

          <div className="settings-content">
            {q !== "" && matchCount === 0 ? (
              <div style={{ padding: 28, color: "var(--mute)", fontSize: 13, textAlign: "center", border: "1px solid var(--rule)", background: "white", marginBottom: 18 }}>
                No settings match &ldquo;{query}&rdquo;. Bespoke keys live under Advanced below.
              </div>
            ) : null}

            {GROUP_ORDER.map(({ id, label }) => {
              const items = visibleByGroup.get(id);
              if (!items) return null;

              const rows = items.map((s) => (
                <EditorShell
                  key={s.key}
                  setting={s}
                  value={currentValue(s)}
                  invalidMsg={invalid[s.key] ?? null}
                  onChange={(next, opts) => setStructured(s.key, next, opts)}
                  onInvalid={(msg) => setInvalid(s.key, msg)}
                  suggestions={suggestions}
                />
              ));

              if (id === "enterprise") {
                return (
                  <details
                    key={id}
                    className="settings-enterprise"
                    data-testid="enterprise-group"
                    open={enterpriseEffectiveOpen}
                    onToggle={(e) => setEnterpriseOpen((e.currentTarget as HTMLDetailsElement).open)}
                    ref={(el) => {
                      if (el) sectionRefs.current.set(id, el);
                      else sectionRefs.current.delete(id);
                    }}
                  >
                    <summary className="font-display">{label} · {items.length}</summary>
                    <div className="banner warn" data-testid="enterprise-banner" style={{ margin: "0 18px 12px" }}>
                      <span className="glyph">!</span>
                      <div>
                        <h5>Editable here, enforced elsewhere</h5>
                        <p>
                          These keys only take effect in an IT-deployed <code>managed-settings.json</code>,
                          which Garrison does not write. Values saved here land in your user
                          <code> settings.json</code> where Claude Code ignores their policy meaning —
                          useful for staging a config to hand to IT, not for enforcing it.
                        </p>
                      </div>
                    </div>
                    {rows}
                  </details>
                );
              }

              return (
                <section
                  key={id}
                  ref={(el) => {
                    if (el) sectionRefs.current.set(id, el);
                    else sectionRefs.current.delete(id);
                  }}
                  style={{ border: "1px solid var(--rule)", background: "white", margin: "0 0 18px", scrollMarginTop: 16 }}
                >
                  <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--rule)" }}>
                    <h3 className="font-display" style={{ fontWeight: 600, fontSize: 16, margin: 0 }}>{label}</h3>
                    {id === "permissions" ? (
                      <p style={{ margin: "4px 0 0", color: "var(--mute)", fontSize: 11.5 }}>
                        {view?.permissionsScopeNote}
                      </p>
                    ) : null}
                    {id === "hooks" ? (
                      <p style={{ margin: "4px 0 0", color: "var(--mute)", fontSize: 11.5 }}>
                        The <code>hooks</code> key itself is read-only here —{" "}
                        <Link href="/quarters/hooks" data-testid="hooks-crud-link" style={{ color: "var(--sage)" }}>
                          manage hooks in Quarters
                        </Link>
                        .
                      </p>
                    ) : null}
                  </div>
                  {rows}
                  {id === "hooks" ? <HooksRows view={view} /> : null}
                </section>
              );
            })}

            <section style={{ border: "1px solid var(--rule)", background: "white", margin: "0 0 18px" }} data-testid="advanced-section">
              <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--rule)" }}>
                <h3 className="font-display" style={{ fontWeight: 600, fontSize: 16, margin: 0 }}>
                  Advanced — unmanaged keys · {view?.unknown.length ?? 0}
                </h3>
                <p style={{ margin: "4px 0 0", color: "var(--mute)", fontSize: 11.5 }}>
                  Keys not in the official schema (bespoke / experimental). Shown as raw JSON and
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
                    <div style={{ marginTop: 6 }}>
                      <JsonEditor
                        value={Object.prototype.hasOwnProperty.call(overrides, u.key) ? overrides[u.key] : u.value}
                        onChange={(next, opts) => setStructured(u.key, next, opts)}
                        onInvalid={(msg) => setInvalid(u.key, msg)}
                        testId={`setting-${u.key}`}
                        minHeight={52}
                      />
                    </div>
                  </div>
                ))
              )}
            </section>

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
        </div>
      </div>
    </main>
  );
}

// The hooks key itself, read-only with provenance — CRUD lives in Quarters >
// Hooks (hand-authored groups editable there; fitting-owned stay read-only).
function HooksRows({ view }: { view: SettingsView | null }) {
  const hooks = view?.hooks ?? [];
  return (
    <div data-testid="hooks-section">
      <div style={{ padding: "10px 18px", borderBottom: "1px solid var(--rule)", background: "var(--paper)" }}>
        <span className="font-display" style={{ fontWeight: 600, fontSize: 13 }}>Configured hooks · {hooks.length}</span>
        <span style={{ color: "var(--mute)", fontSize: 11.5, marginLeft: 10 }}>
          Garrison-owned groups are labelled by their owning fitting; hand-authored groups are never touched here.
        </span>
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
    </div>
  );
}
