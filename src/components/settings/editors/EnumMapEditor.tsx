"use client";

import { useState } from "react";
import { useExternalReset, isPlainObject, monoStyle, errStyle } from "./types";

interface Row {
  k: string;
  v: string;
}

const rowGrid = {
  display: "grid",
  gridTemplateColumns: "1fr minmax(140px, 220px) auto",
  gap: 8,
  marginBottom: 6
} as const;

// string -> enum map editor (skillOverrides). Key suggestions come from the
// live ~/.claude scan (datalist); values are a fixed select.
export function EnumMapEditor({
  value,
  onChange,
  onInvalid,
  testIdBase,
  enumValues,
  keyPlaceholder,
  keySuggestions
}: {
  value: unknown;
  onChange: (next: unknown, opts?: { immediate?: boolean }) => void;
  onInvalid?: (msg: string | null) => void;
  testIdBase: string;
  enumValues: string[];
  keyPlaceholder?: string;
  keySuggestions?: string[];
}) {
  const fromValue = (v: unknown): Row[] =>
    isPlainObject(v)
      ? Object.entries(v).map(([k, val]) => ({ k, v: typeof val === "string" ? val : String(val) }))
      : [];
  const [rows, setRows] = useState<Row[]>(() => fromValue(value));
  const [err, setErr] = useState<string | null>(null);
  const markEmitted = useExternalReset(value, (incoming) => {
    setRows(fromValue(incoming));
    setErr(null);
    onInvalid?.(null);
  });

  const firstProblem = (next: Row[]): string | null => {
    const seen = new Set<string>();
    for (const { k } of next) {
      if (k.trim() === "") continue; // draft row
      if (seen.has(k)) return `Duplicate key "${k}".`;
      seen.add(k);
    }
    return null;
  };

  const apply = (next: Row[], immediate: boolean) => {
    setRows(next);
    const problem = firstProblem(next);
    setErr(problem);
    onInvalid?.(problem);
    if (problem) return;
    const out: Record<string, string> = {};
    for (const { k, v } of next) {
      if (k.trim() === "") continue;
      out[k] = v;
    }
    const emitted = Object.keys(out).length > 0 ? out : undefined;
    markEmitted(emitted);
    onChange(emitted, { immediate });
  };

  const listId = keySuggestions && keySuggestions.length > 0 ? `${testIdBase}-keys` : undefined;

  return (
    <div data-testid={testIdBase}>
      {listId ? (
        <datalist id={listId}>
          {keySuggestions!.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      ) : null}
      {rows.map((row, i) => (
        <div key={i} style={rowGrid}>
          <input
            className="text"
            data-testid={`${testIdBase}.${i}.key`}
            style={monoStyle}
            value={row.k}
            placeholder={keyPlaceholder}
            list={listId}
            onChange={(e) => apply(rows.map((r, j) => (j === i ? { ...r, k: e.target.value } : r)), false)}
            onBlur={() => apply(rows, true)}
          />
          <select
            className="text"
            data-testid={`${testIdBase}.${i}.value`}
            value={row.v}
            onChange={(e) => apply(rows.map((r, j) => (j === i ? { ...r, v: e.target.value } : r)), true)}
          >
            {enumValues.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn small ghost"
            data-testid={`${testIdBase}.${i}.remove`}
            onClick={() => apply(rows.filter((_, j) => j !== i), true)}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn small ghost"
        data-testid={`${testIdBase}.add`}
        onClick={() => setRows([...rows, { k: "", v: enumValues[0] }])}
      >
        Add entry
      </button>
      {err ? <p style={errStyle}>{err}</p> : null}
    </div>
  );
}
