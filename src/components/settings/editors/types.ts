import { useEffect, useRef } from "react";

// Shared contract for every settings editor. `onChange(undefined)` means
// "remove this key"; opts.immediate skips the debounce (checkbox/select/row
// add+remove save at once, typing flushes on blur). `onInvalid(msg)` keeps the
// key OUT of the autosave patch queue while msg is non-null — invalid input is
// shown, never written.
export interface EditorProps {
  value: unknown;
  onChange: (next: unknown, opts?: { immediate?: boolean }) => void;
  onInvalid?: (msg: string | null) => void;
  testIdBase: string;
}

// Local-rows editors (lists, maps, rules) hold draft state so half-typed rows
// never enter the patch queue. This hook resets that draft when the VALUE
// changes from outside (load, reload-from-disk, raw-JSON edit) while ignoring
// the editor's own emissions. Call the returned marker with every emitted
// value BEFORE onChange.
export function useExternalReset(
  value: unknown,
  reset: (incoming: unknown) => void
): (emitted: unknown) => void {
  const last = useRef(JSON.stringify(value ?? null));
  useEffect(() => {
    const incoming = JSON.stringify(value ?? null);
    if (incoming !== last.current) {
      last.current = incoming;
      reset(value);
    }
  });
  return (emitted: unknown) => {
    last.current = JSON.stringify(emitted ?? null);
  };
}

export const monoStyle = {
  fontFamily: "var(--font-mono), monospace",
  fontSize: 12
} as const;

export const errStyle = {
  margin: "4px 0 0",
  color: "var(--alarm)",
  fontSize: 11
} as const;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}
