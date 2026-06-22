"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { StateModel, PrimitiveRecord, PrimitiveSurface } from "@/lib/primitive-state";
import { StateBadge } from "./StateBadge";
import { ConfirmDialog } from "./ConfirmDialog";
import { WRITER_LABEL, type QuartersCategory } from "./quartersTypes";
import { crudFor, type SurfaceCrud } from "./surfaceEditors";

// Map a presence-managed record (hook/mcp/plugin) to the enable/disable action
// body. Enabling = a record currently parked; disabling = a record active. Hook
// ids encode the event + (active) index or (parked) parkedIndex.
function presenceBody(rec: PrimitiveRecord): Record<string, unknown> | null {
  if (rec.managedBy !== "presence") return null;
  const enabling = rec.presence === "parked";
  if (rec.surface === "mcp") return { action: enabling ? "mcp.enable" : "mcp.disable", name: rec.name };
  if (rec.surface === "plugin") return { action: enabling ? "plugin.enable" : "plugin.disable", key: rec.name };
  if (rec.surface === "hook") {
    if (enabling) {
      const m = rec.id.match(/#parked(\d+)$/);
      return m ? { action: "hook.enable", parkedIndex: Number(m[1]) } : null;
    }
    const m = rec.id.match(/#(\d+)$/);
    if (!m) return null;
    return { action: "hook.disable", event: rec.id.slice("hook:".length, rec.id.lastIndexOf("#")), index: Number(m[1]) };
  }
  return null;
}

// One parameterized panel for every package-surface category (Skills/Hooks/MCPs/
// Plugins/Scripts). Lists ALL primitives with their state, the promote/park
// transition action OR (HV wave) the presence enable/disable toggle, AND — where
// Garrison is writer-of-record — full CRUD (Add / Edit / Remove) via the
// per-surface editor registry. Refetches on any mutation (no watcher).
export function PrimitiveListPanel({ cat }: { cat: QuartersCategory }) {
  const [model, setModel] = useState<StateModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ surface: PrimitiveSurface; rec: PrimitiveRecord | null } | null>(null);
  const [deleting, setDeleting] = useState<{ rec: PrimitiveRecord; crud: SurfaceCrud } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/quarters");
      const data = await res.json();
      if (!res.ok || data?.error) throw new Error(data?.error ?? res.statusText);
      setModel(data as StateModel);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const transition = useCallback(
    async (rec: PrimitiveRecord) => {
      const body =
        rec.state === "loose"
          ? { action: "promote", id: rec.id }
          : { action: "park", fittingId: rec.fittingId ?? rec.name };
      setBusy(rec.id);
      setError(null);
      try {
        const res = await fetch("/api/quarters", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok || data?.ok === false) throw new Error(data?.error ?? data?.code ?? res.statusText);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [load]
  );

  const togglePresence = useCallback(
    async (rec: PrimitiveRecord) => {
      const body = presenceBody(rec);
      if (!body) {
        // Never let the toggle look actionable but do nothing — surface why
        // (a malformed/unexpected presence record id) instead of a silent no-op.
        setError(`Can't toggle "${rec.name}" — unrecognized presence record (${rec.id}).`);
        return;
      }
      setBusy(rec.id);
      setError(null);
      try {
        const res = await fetch("/api/quarters", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok || data?.ok === false) throw new Error(data?.error ?? data?.code ?? res.statusText);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [load]
  );

  const remove = useCallback(
    async (rec: PrimitiveRecord, crud: SurfaceCrud) => {
      const body = crud.deleteBody(rec);
      if (!body) return;
      const res = await fetch("/api/quarters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false) throw new Error(data?.error ?? data?.code ?? res.statusText);
      await load();
    },
    [load]
  );

  const surfaces = cat.surfaces ?? [];
  const records = surfaces.flatMap((s) => model?.bySurface[s] ?? []);
  const transitionable = cat.writer === "apm" || cat.writer === "split"; // promote/park surfaces
  const creatable = surfaces.map((s) => crudFor(s)).filter((c): c is SurfaceCrud => !!c?.creatable);

  const ActiveEditor = editing ? crudFor(editing.surface)?.Editor : undefined;

  return (
    <main>
      <div className="crumbs"><b>Quarters</b> · {cat.label}</div>
      <div className="page">
        <div className="head" style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
          <div style={{ flex: 1 }}>
            <h1>{cat.label}</h1>
            <p className="ld">{cat.blurb}</p>
            <span className="pill idle" style={{ fontSize: 10.5 }}>{WRITER_LABEL[cat.writer]}</span>
          </div>
          {creatable.length > 0 ? (
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              {surfaces
                .map((s) => ({ s, crud: crudFor(s) }))
                .filter((x): x is { s: PrimitiveSurface; crud: SurfaceCrud } => !!x.crud?.creatable)
                .map(({ s, crud }) => (
                  <button
                    key={s}
                    className="btn small"
                    data-testid={`create-${s}`}
                    onClick={() => setEditing({ surface: s, rec: null })}
                    style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                  >
                    <Plus size={14} aria-hidden /> {crud.createLabel}
                  </button>
                ))}
            </div>
          ) : null}
        </div>

        {error ? (
          <div className="banner alarm" data-testid="primitive-error">
            <span className="glyph">!</span>
            <div><h5>Action failed</h5><p>{error}</p></div>
          </div>
        ) : null}

        <section style={{ border: "1px solid var(--rule)", background: "white" }} data-testid={`primitives-${cat.slug}`}>
          {!model ? (
            <div style={{ padding: 20, color: "var(--mute)", fontSize: 13 }} className="ld">Loading…</div>
          ) : records.length === 0 ? (
            <div style={{ padding: 20, color: "var(--mute)", fontSize: 13, textAlign: "center" }}>
              No {cat.label.toLowerCase()} found in ~/.claude.
              {creatable.length > 0 ? " Use the button above to add one." : ""}
            </div>
          ) : (
            records.map((rec) => {
              const crud = crudFor(rec.surface);
              const deletable = crud ? crud.deleteBody(rec) !== null : false;
              const blockedHint = crud && !deletable ? crud.blockedDeleteHint?.(rec) ?? null : null;
              return (
                <div
                  key={rec.id}
                  data-testid={`primitive-${rec.id}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: 12,
                    alignItems: "center",
                    padding: "11px 18px",
                    borderBottom: "1px solid var(--rule)"
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <span className="font-mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{rec.name}</span>
                    {rec.fittingId ? (
                      <code style={{ fontSize: 11, color: "var(--mute)", marginLeft: 8 }}>{rec.fittingId}</code>
                    ) : null}
                    {rec.preview ? (
                      <code
                        data-testid={`preview-${rec.id}`}
                        style={{
                          display: "block",
                          fontSize: 11,
                          color: "var(--mute)",
                          marginTop: 3,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap"
                        }}
                      >
                        {rec.preview}
                      </code>
                    ) : null}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {rec.managedBy === "presence" ? (
                      <span
                        data-testid={`presence-${rec.id}`}
                        className="pill"
                        style={{
                          fontSize: 10,
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                          color: rec.presence === "parked" ? "var(--mute)" : "var(--sage)",
                          borderColor: rec.presence === "parked" ? "var(--rule)" : "var(--sage)"
                        }}
                      >
                        {rec.presence}
                      </span>
                    ) : (
                      <StateBadge state={rec.state} drifted={rec.driftedFromLock} />
                    )}
                    {crud?.Editor && (crud.editable?.(rec) ?? true) ? (
                      <button
                        className="btn small ghost"
                        data-testid={`edit-${rec.id}`}
                        title="Edit"
                        onClick={() => setEditing({ surface: rec.surface, rec })}
                        style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                      >
                        <Pencil size={13} aria-hidden /> Edit
                      </button>
                    ) : null}
                    {rec.managedBy === "presence" ? (
                      <button
                        className="btn small ghost"
                        data-testid={`toggle-${rec.id}`}
                        disabled={busy === rec.id}
                        onClick={() => void togglePresence(rec)}
                      >
                        {busy === rec.id ? "…" : rec.presence === "parked" ? "Enable" : "Disable"}
                      </button>
                    ) : null}
                    {transitionable && (rec.state === "loose" || rec.state === "owned") ? (
                      <button
                        className="btn small ghost"
                        data-testid={`action-${rec.id}`}
                        disabled={busy === rec.id}
                        onClick={() => void transition(rec)}
                      >
                        {busy === rec.id ? "…" : rec.state === "loose" ? "Promote" : "Park"}
                      </button>
                    ) : null}
                    {deletable ? (
                      <button
                        className="btn small ghost"
                        data-testid={`delete-${rec.id}`}
                        title="Remove"
                        onClick={() => setDeleting({ rec, crud: crud! })}
                        style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--alarm)" }}
                      >
                        <Trash2 size={13} aria-hidden /> Remove
                      </button>
                    ) : blockedHint && !transitionable ? (
                      <span style={{ fontSize: 11, color: "var(--mute)" }}>{blockedHint}</span>
                    ) : !crud && cat.slug === "hooks" ? (
                      <span style={{ fontSize: 11, color: "var(--mute)" }}>manage via fitting</span>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </section>
      </div>

      {editing && ActiveEditor ? (
        <ActiveEditor
          rec={editing.rec}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={`Remove ${deleting.crud.noun}`}
          body={
            deleting.crud.confirmBody?.(deleting.rec) ??
            `Remove "${deleting.rec.name}"? This rewrites the underlying ~/.claude file. This cannot be undone from here.`
          }
          confirmLabel="Remove"
          onConfirm={() => remove(deleting.rec, deleting.crud)}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </main>
  );
}
