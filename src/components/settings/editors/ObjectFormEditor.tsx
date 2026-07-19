"use client";

import type { FieldDesc } from "@/lib/settings-catalog";
import {
  assembleObjectValue,
  missingRequired,
  passthroughKeys
} from "@/lib/settings-validate";
import { BooleanControl, StringControl, NumberControl, EnumControl } from "./ScalarControls";
import { JsonEditor } from "./JsonEditor";
import { StringListEditor } from "./StringListEditor";
import { KeyValueListEditor } from "./KeyValueListEditor";
import { PermissionRulesEditor } from "./PermissionRulesEditor";
import { isPlainObject, monoStyle } from "./types";

// Recursive structured sub-form over the catalog's FieldDesc tree. The
// correctness core is in assembleObjectValue: every subfield edit spreads the
// CURRENT object, so subkeys this catalog does not know (a future Claude Code
// version's additions) round-trip untouched — the bespoke-passthrough
// invariant one level down. Each edit emits the WHOLE top-level object; the
// panel queues { <topKey>: assembled }, exactly the JSON-control semantics
// writeSettingsPatch already merges.
//
// Same-key concurrency note: two writers editing DIFFERENT subfields of one
// top-level key still last-write-wins at the top-level key, like the JSON
// control always has. The drift banner + reload-before-edit is the standing
// mitigation; Garrison's own saves stay echo-suppressed.
export function ObjectFormEditor({
  fields,
  value,
  onChange,
  onInvalid,
  testIdBase,
  suggestions
}: {
  fields: FieldDesc[];
  value: unknown;
  onChange: (next: unknown, opts?: { immediate?: boolean }) => void;
  onInvalid?: (msg: string | null) => void;
  testIdBase: string;
  suggestions?: { skills: string[]; mcpServers: string[] };
}) {
  const obj = isPlainObject(value) ? value : undefined;

  const setSub = (f: FieldDesc, next: unknown, opts?: { immediate?: boolean }) => {
    const assembled = assembleObjectValue(fields, value, f.key, next);
    // Propagate first so the in-progress object stays visible; a missing
    // required sibling then keeps the key OUT of the patch queue until filled.
    onChange(assembled, opts);
    const missing = assembled === undefined ? [] : missingRequired(fields, assembled);
    onInvalid?.(missing.length > 0 ? `Required: ${missing.join(", ")}` : null);
  };

  const extras = passthroughKeys(fields, value);

  return (
    <div
      data-testid={testIdBase}
      className="settings-object-form"
      style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 10 }}
    >
      {fields.map((f) => (
        <div key={f.key}>
          <div className="settings-object-field-head" style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 3 }}>
            <label style={{ fontWeight: 600, fontSize: 12.5 }}>{f.label}</label>
            <code style={{ fontSize: 10.5, color: "var(--mute)" }}>{f.key}</code>
            {f.required && f.constValue === undefined ? (
              <span style={{ fontSize: 10.5, color: "var(--mute)" }}>(required)</span>
            ) : null}
            {f.managedOnly ? (
              <span className="pill warn" style={{ fontSize: 9.5 }}>
                managed-only
              </span>
            ) : null}
          </div>
          {f.doc ? (
            <p style={{ margin: "0 0 5px", color: "var(--mute)", fontSize: 11 }}>{f.doc}</p>
          ) : null}
          <FieldControl
            field={f}
            value={obj?.[f.key]}
            onChange={(next, opts) => setSub(f, next, opts)}
            onInvalid={onInvalid}
            testId={`${testIdBase}.${f.key}`}
            suggestions={suggestions}
          />
        </div>
      ))}
      {extras.length > 0 ? (
        <p style={{ margin: 0, color: "var(--mute)", fontSize: 10.5 }}>
          Passthrough subkeys (round-tripped untouched):{" "}
          {extras.map((k, i) => (
            <code key={k} style={{ fontSize: 10.5 }}>
              {i > 0 ? ", " : ""}
              {k}
            </code>
          ))}
        </p>
      ) : null}
    </div>
  );
}

function FieldControl({
  field,
  value,
  onChange,
  onInvalid,
  testId,
  suggestions
}: {
  field: FieldDesc;
  value: unknown;
  onChange: (next: unknown, opts?: { immediate?: boolean }) => void;
  onInvalid?: (msg: string | null) => void;
  testId: string;
  suggestions?: { skills: string[]; mcpServers: string[] };
}) {
  if (field.constValue !== undefined) {
    // Auto-injected by assembleObjectValue whenever a sibling is set.
    return (
      <code style={{ ...monoStyle, color: "var(--mute)" }} data-testid={testId}>
        {field.constValue} (set automatically)
      </code>
    );
  }
  switch (field.control) {
    case "boolean":
      return <BooleanControl value={value} onChange={onChange} testId={testId} />;
    case "number":
      return (
        <NumberControl
          value={value}
          onChange={onChange}
          onInvalid={onInvalid}
          testId={testId}
          min={field.min}
          max={field.max}
          integer={field.integer}
        />
      );
    case "enum":
      return <EnumControl value={value} onChange={onChange} testId={testId} enumValues={field.enumValues ?? []} />;
    case "string-list":
      return (
        <StringListEditor
          value={value}
          onChange={onChange}
          testIdBase={testId}
          enumValues={field.enumValues}
          placeholder={field.placeholder}
        />
      );
    case "string-list-map":
      return (
        <KeyValueListEditor value={value} onChange={onChange} onInvalid={onInvalid} testIdBase={testId} />
      );
    case "permission-rules":
      return <PermissionRulesEditor value={value} onChange={onChange} testIdBase={testId} />;
    case "object-form":
      return (
        <div style={{ borderLeft: "2px solid var(--rule)", paddingLeft: 12 }}>
          <ObjectFormEditor
            fields={field.fields ?? []}
            value={value}
            onChange={onChange}
            onInvalid={onInvalid}
            testIdBase={testId}
            suggestions={suggestions}
          />
        </div>
      );
    case "json":
      return <JsonEditor value={value} onChange={onChange} onInvalid={onInvalid} testId={testId} />;
    case "string":
    default:
      return (
        <StringControl
          value={value}
          onChange={onChange}
          testId={testId}
          placeholder={field.placeholder}
          emptyStringMeaningful={field.emptyStringMeaningful}
        />
      );
  }
}
