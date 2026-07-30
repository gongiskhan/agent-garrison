"use client";

import { useState } from "react";
import type { LibraryEntry, SelectedFitting } from "@/lib/types";
import { SaveBadge, SectionLabel, EmptyNote, useAutosave, fetchJson } from "./common";

type ConfigValue = string | number | boolean;

// Schema-driven config editor over the ACTIVE composition's selection config —
// the same store the Muster standing panel writes (POST
// /api/muster/standing/config). Autosave only: discrete fields persist
// immediately, text/number debounce.
export function ConfigForm({
  entry,
  config
}: {
  entry: LibraryEntry;
  config: SelectedFitting["config"];
}) {
  const schema = entry.metadata.config_schema ?? [];
  const [values, setValues] = useState<Record<string, ConfigValue>>(() => {
    const initial: Record<string, ConfigValue> = {};
    for (const field of schema) {
      const current = (config as Record<string, unknown> | undefined)?.[field.key];
      if (typeof current === "string" || typeof current === "number" || typeof current === "boolean") {
        initial[field.key] = current;
      } else if (field.default !== undefined) {
        initial[field.key] = field.default as ConfigValue;
      }
    }
    return initial;
  });

  const { state, error, schedule, flushNow } = useAutosave<{ key: string; value: ConfigValue }>(
    async ({ key, value }) => {
      await fetchJson("/api/muster/standing/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ faculty: entry.faculty, fittingId: entry.id, key, value })
      });
    }
  );

  if (schema.length === 0) {
    return (
      <section>
        <SectionLabel>Configuration</SectionLabel>
        <EmptyNote>This Fitting has no configuration.</EmptyNote>
      </section>
    );
  }

  function commit(key: string, value: ConfigValue, immediate: boolean) {
    setValues((prev) => ({ ...prev, [key]: value }));
    schedule({ key, value });
    if (immediate) flushNow();
  }

  return (
    <section>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <SectionLabel>Configuration</SectionLabel>
        <SaveBadge state={state} error={error} />
      </div>
      <div style={{ display: "grid", gap: 12 }}>
        {schema.map((field) => {
          const value = values[field.key];
          const inputId = `fitting-config-${entry.id}-${field.key}`;
          return (
            <div key={field.key} style={{ display: "grid", gap: 4 }}>
              <label
                htmlFor={inputId}
                className="font-mono"
                style={{ fontSize: 11.5, color: "var(--ink)" }}
              >
                {field.key}
                {field.required ? <span style={{ color: "var(--alarm)" }}> *</span> : null}
              </label>
              {field.type === "boolean" ? (
                <input
                  id={inputId}
                  type="checkbox"
                  checked={value === true}
                  onChange={(e) => commit(field.key, e.target.checked, true)}
                  style={{ justifySelf: "start", width: 15, height: 15 }}
                />
              ) : field.type === "select" ? (
                <select
                  id={inputId}
                  className="text"
                  value={String(value ?? "")}
                  onChange={(e) => commit(field.key, e.target.value, true)}
                >
                  <option value="">—</option>
                  {(field.options ?? []).map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              ) : field.type === "integer" || field.type === "number" ? (
                <input
                  id={inputId}
                  className="text"
                  type="number"
                  value={value === undefined ? "" : String(value)}
                  onChange={(e) => {
                    const parsed =
                      field.type === "integer" ? parseInt(e.target.value, 10) : Number(e.target.value);
                    if (Number.isFinite(parsed)) commit(field.key, parsed, false);
                  }}
                  onBlur={flushNow}
                />
              ) : (
                <input
                  id={inputId}
                  className="text"
                  type="text"
                  value={value === undefined ? "" : String(value)}
                  placeholder={field.default !== undefined ? String(field.default) : undefined}
                  onChange={(e) => commit(field.key, e.target.value, false)}
                  onBlur={flushNow}
                />
              )}
              {field.description ? (
                <span style={{ fontSize: 11.5, lineHeight: 1.5, color: "var(--mute)" }}>
                  {field.description}
                  {field.type === "secret-ref" ? " (names a Vault secret)" : ""}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
