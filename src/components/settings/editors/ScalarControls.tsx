"use client";

import { useEffect, useRef, useState } from "react";
import { validateNumber } from "@/lib/settings-validate";
import { errStyle } from "./types";

// The four scalar controls, extracted from the old SettingRow. Checkbox saves
// immediately; text debounces and flushes on blur; number additionally
// enforces min/max/integer via onInvalid (out-of-bounds input is shown but
// never queued); enum selects save immediately with an explicit (unset).

export function BooleanControl({
  value,
  onChange,
  testId
}: {
  value: unknown;
  onChange: (next: unknown, opts?: { immediate?: boolean }) => void;
  testId: string;
}) {
  return (
    <input
      type="checkbox"
      data-testid={testId}
      checked={value === true}
      onChange={(e) => onChange(e.target.checked, { immediate: true })}
    />
  );
}

export function StringControl({
  value,
  onChange,
  testId,
  placeholder,
  emptyStringMeaningful
}: {
  value: unknown;
  onChange: (next: unknown, opts?: { immediate?: boolean }) => void;
  testId: string;
  placeholder?: string;
  emptyStringMeaningful?: boolean;
}) {
  const text = typeof value === "string" ? value : value === undefined ? "" : String(value);
  const toNext = (v: string) => (v === "" && !emptyStringMeaningful ? undefined : v);
  return (
    <input
      className="text"
      type="text"
      data-testid={testId}
      placeholder={placeholder}
      value={text}
      onChange={(e) => onChange(toNext(e.target.value), { immediate: false })}
      onBlur={(e) => onChange(toNext(e.target.value), { immediate: true })}
    />
  );
}

export function NumberControl({
  value,
  onChange,
  onInvalid,
  testId,
  min,
  max,
  integer
}: {
  value: unknown;
  onChange: (next: unknown, opts?: { immediate?: boolean }) => void;
  onInvalid?: (msg: string | null) => void;
  testId: string;
  min?: number;
  max?: number;
  integer?: boolean;
}) {
  // Local text so an out-of-bounds keystroke stays visible (and flagged)
  // instead of snapping back — it is excluded from the patch queue.
  const [text, setText] = useState(value === undefined || value === null ? "" : String(value));
  const [err, setErr] = useState<string | null>(null);
  const lastProp = useRef(value);
  useEffect(() => {
    if (lastProp.current !== value) {
      lastProp.current = value;
      setText(value === undefined || value === null ? "" : String(value));
      setErr(null);
    }
  }, [value]);

  const handle = (v: string, immediate: boolean) => {
    setText(v);
    if (v === "") {
      setErr(null);
      onInvalid?.(null);
      lastProp.current = undefined;
      onChange(undefined, { immediate });
      return;
    }
    const num = Number(v);
    const msg = validateNumber(num, { min, max, integer });
    if (msg) {
      setErr(msg);
      onInvalid?.(msg);
      return;
    }
    setErr(null);
    onInvalid?.(null);
    lastProp.current = num;
    onChange(num, { immediate });
  };

  return (
    <>
      <input
        className="text"
        type="number"
        data-testid={testId}
        value={text}
        min={min}
        max={max}
        step={integer ? 1 : undefined}
        onChange={(e) => handle(e.target.value, false)}
        onBlur={(e) => handle(e.target.value, true)}
      />
      {err ? <p style={errStyle}>{err}</p> : null}
    </>
  );
}

export function EnumControl({
  value,
  onChange,
  testId,
  enumValues
}: {
  value: unknown;
  onChange: (next: unknown, opts?: { immediate?: boolean }) => void;
  testId: string;
  enumValues: string[];
}) {
  return (
    <select
      className="text"
      data-testid={testId}
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value, { immediate: true })}
    >
      <option value="">(unset)</option>
      {enumValues.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}
