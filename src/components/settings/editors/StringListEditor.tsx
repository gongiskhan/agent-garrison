"use client";

import { useState } from "react";
import { useExternalReset, monoStyle } from "./types";

const rowGrid = { display: "grid", gridTemplateColumns: "1fr auto", gap: 8, marginBottom: 6 } as const;

// Row-per-entry editor for string arrays. With enumValues set it renders a
// fixed checkbox set instead (sandbox.enabledPlatforms). Empty rows are kept
// as local drafts and never emitted; an empty list unsets the key.
export function StringListEditor({
  value,
  onChange,
  testIdBase,
  enumValues,
  placeholder,
  suggestions
}: {
  value: unknown;
  onChange: (next: unknown, opts?: { immediate?: boolean }) => void;
  testIdBase: string;
  enumValues?: string[];
  placeholder?: string;
  suggestions?: string[];
}) {
  const fromValue = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((s) => (typeof s === "string" ? s : JSON.stringify(s))) : [];
  const [rows, setRows] = useState<string[]>(() => fromValue(value));
  const markEmitted = useExternalReset(value, (incoming) => setRows(fromValue(incoming)));

  const emit = (next: string[], immediate: boolean) => {
    const cleaned = next.map((r) => r.trim()).filter((r) => r !== "");
    const out = cleaned.length > 0 ? cleaned : undefined;
    markEmitted(out);
    onChange(out, { immediate });
  };

  if (enumValues) {
    const selected = fromValue(value);
    const toggle = (option: string, checked: boolean) => {
      const next = enumValues.filter((o) => (o === option ? checked : selected.includes(o)));
      onChange(next.length > 0 ? next : undefined, { immediate: true });
    };
    return (
      <div data-testid={testIdBase} style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {enumValues.map((o) => (
          <label key={o} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
            <input
              type="checkbox"
              data-testid={`${testIdBase}.${o}`}
              checked={selected.includes(o)}
              onChange={(e) => toggle(o, e.target.checked)}
            />
            <code style={monoStyle}>{o}</code>
          </label>
        ))}
      </div>
    );
  }

  const listId = suggestions && suggestions.length > 0 ? `${testIdBase}-suggestions` : undefined;

  return (
    <div data-testid={testIdBase}>
      {listId ? (
        <datalist id={listId}>
          {suggestions!.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      ) : null}
      {rows.map((row, i) => (
        <div key={i} style={rowGrid}>
          <input
            className="text"
            data-testid={`${testIdBase}.${i}`}
            style={monoStyle}
            value={row}
            placeholder={placeholder}
            list={listId}
            onChange={(e) => {
              const next = rows.slice();
              next[i] = e.target.value;
              setRows(next);
              emit(next, false);
            }}
            onBlur={() => emit(rows, true)}
          />
          <button
            type="button"
            className="btn small ghost"
            data-testid={`${testIdBase}.${i}.remove`}
            onClick={() => {
              const next = rows.filter((_, j) => j !== i);
              setRows(next);
              emit(next, true);
            }}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn small ghost"
        data-testid={`${testIdBase}.add`}
        onClick={() => setRows([...rows, ""])}
      >
        Add entry
      </button>
    </div>
  );
}
