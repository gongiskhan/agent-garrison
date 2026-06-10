"use client";

import { useState } from "react";
import { useExternalReset, isPlainObject, monoStyle, errStyle } from "./types";

interface Row {
  k: string;
  items: string; // one entry per line
}

const rowGrid = {
  display: "grid",
  gridTemplateColumns: "minmax(120px, 240px) 1fr auto",
  gap: 8,
  marginBottom: 6,
  alignItems: "start"
} as const;

// string -> string[] map editor (sandbox.ignoreViolations: command pattern to
// ignored filesystem paths, one path per line; "*" matches all commands).
export function KeyValueListEditor({
  value,
  onChange,
  onInvalid,
  testIdBase,
  keyPlaceholder,
  itemsPlaceholder
}: {
  value: unknown;
  onChange: (next: unknown, opts?: { immediate?: boolean }) => void;
  onInvalid?: (msg: string | null) => void;
  testIdBase: string;
  keyPlaceholder?: string;
  itemsPlaceholder?: string;
}) {
  const fromValue = (v: unknown): Row[] =>
    isPlainObject(v)
      ? Object.entries(v).map(([k, val]) => ({
          k,
          items: Array.isArray(val) ? val.filter((s) => typeof s === "string").join("\n") : ""
        }))
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
    for (const { k, items } of next) {
      if (k.trim() === "" && items.trim() === "") continue; // draft row
      if (k.trim() === "") return "A row is missing its command pattern.";
      if (seen.has(k)) return `Duplicate pattern "${k}".`;
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
    const out: Record<string, string[]> = {};
    for (const { k, items } of next) {
      if (k.trim() === "") continue;
      out[k] = items
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s !== "");
    }
    const emitted = Object.keys(out).length > 0 ? out : undefined;
    markEmitted(emitted);
    onChange(emitted, { immediate });
  };

  return (
    <div data-testid={testIdBase}>
      {rows.map((row, i) => (
        <div key={i} style={rowGrid}>
          <input
            className="text"
            data-testid={`${testIdBase}.${i}.key`}
            style={monoStyle}
            value={row.k}
            placeholder={keyPlaceholder ?? "* or command pattern"}
            onChange={(e) => apply(rows.map((r, j) => (j === i ? { ...r, k: e.target.value } : r)), false)}
            onBlur={() => apply(rows, true)}
          />
          <textarea
            className="text"
            data-testid={`${testIdBase}.${i}.items`}
            style={{ ...monoStyle, minHeight: 40 }}
            value={row.items}
            placeholder={itemsPlaceholder ?? "one path per line"}
            onChange={(e) => apply(rows.map((r, j) => (j === i ? { ...r, items: e.target.value } : r)), false)}
            onBlur={() => apply(rows, true)}
          />
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
        onClick={() => setRows([...rows, { k: "", items: "" }])}
      >
        Add entry
      </button>
      {err ? <p style={errStyle}>{err}</p> : null}
    </div>
  );
}
